// workflow.js — single mutable state object + sequential state machine. DOM-free.
import { AGENTS } from './config.js';
import { listModels, modelInstalled, OllamaError } from './ollama.js';
import * as A from './agents.js';

const isAbort = e => e && e.name === 'AbortError';
const BLANK_LIVE = { agentId: null, model: '', stage: '', text: '' };

export function computeVerification(s) {
  const o = s.outputs;
  let review = 'NOT RUN';
  if (o.review) review = o.review.stale ? 'STALE — latest code not re-reviewed'
    : o.review.approved ? 'APPROVED (static + LLM review only)' : 'BLOCKING ISSUES REMAIN';
  return {
    requirements_extracted: !!o.requirements, cad_plan_generated: !!o.plan, python_generated: !!o.code,
    static_review: review,
    python_execution: 'NOT VERIFIED', geometry_validity: 'NOT VERIFIED',
    step_export: 'NOT VERIFIED', stl_export: 'NOT VERIFIED'
  };
}

function reportFacts(s) {
  const o = s.outputs, r = o.requirements, p = o.plan;
  return {
    workflow_status: s.status, failures: Object.values(s.agents).filter(a => a.error).map(a => `${a.name}: ${a.error}`),
    verification: computeVerification(s),
    requirements: r && { object: r.object, summary: r.summary, units: r.units, dimensions: r.dimensions, features: r.features,
      explicit_requirements: r.explicit_requirements, assumptions: r.assumptions, missing_information: r.missing_information,
      contradictions: r.contradictions, warnings: r.warnings },
    plan: p && { coordinate_system: p.coordinate_system, provisional_assumptions: p.provisional_assumptions,
      parameters: p.parameters, step_count: p.steps?.length, expected_bounding_box: p.expected_bounding_box,
      expected_solid_count: p.expected_solid_count, validation_steps: p.validation_steps },
    code: o.code ? { chars: o.code.length, lines: o.code.split('\n').length } : null,
    review: o.review && { approved: o.review.approved, stale: !!o.review.stale, summary: o.review.summary, issues: o.review.issues },
    repair_history: o.repairHistory.map(h => ({ attempt: h.attempt, error: h.error || null, changed: h.changed,
      approved_after: h.review_after?.approved ?? null, remaining_issues: h.review_after?.issues?.length ?? null }))
  };
}

export function statusSection(s) {
  const v = computeVerification(s), yn = b => (b ? 'YES' : 'NO');
  return [
    '=== APPLICATION-GENERATED STATUS (authoritative) ===',
    `Workflow status: ${s.status}`,
    `1. Requirements extracted: ${yn(v.requirements_extracted)}`,
    `2. CAD plan generated: ${yn(v.cad_plan_generated)}`,
    `3. Python source generated: ${yn(v.python_generated)}`,
    `4. Static code review: ${v.static_review}`,
    `5. Python execution: ${v.python_execution}`,
    `6. Geometry validity: ${v.geometry_validity}`,
    `7. STEP/STL exports: ${v.step_export} / ${v.stl_export}`,
    `Repair attempts used: ${s.outputs.repairHistory.length}`,
    'This browser app never executes Python. To obtain STEP/STL: pip install cadquery, run generated_cad.py, and inspect the result.'
  ].join('\n');
}

function freshState(cfg = {}, prompt = '') {
  const agents = {};
  for (const a of AGENTS) agents[a.id] = { id: a.id, name: a.name, model: cfg[a.modelKey] || cfg.cadModel || '', status: 'waiting', progress: 0, detail: '', error: null };
  return {
    status: 'idle', prompt, config: { ...cfg }, startedAt: null, finishedAt: null, activeAgent: null,
    agents, live: { ...BLANK_LIVE },
    outputs: { requirements: null, plan: null, code: null, review: null, repairHistory: [], report: null },
    log: []
  };
}

export class Workflow {
  constructor() { this.listeners = new Set(); this.state = freshState(); this.controller = null; this.running = false; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.state); }
  log(msg) { this.state.log.push({ t: new Date().toISOString(), msg }); }
  setAgent(id, patch) { Object.assign(this.state.agents[id], patch); this.emit(); }

  stop() { if (this.running) this.controller?.abort(); }
  reset() { if (this.running) return false; this.state = freshState(); this.emit(); return true; }

  makeCtx() {
    const s = this.state;
    return {
      cfg: s.config, signal: this.controller.signal,
      onStart: label => { s.live.stage = label; s.live.text = ''; this.setAgent(s.activeAgent, { detail: label, progress: 0 }); },
      onToken: (full, n, limit) => { s.live.text = full; s.agents[s.activeAgent].progress = Math.min(95, Math.round(n / limit * 100)); this.emit(); },
      onNote: msg => { this.log(`[${s.activeAgent}] ${msg}`); s.live.stage = msg; this.emit(); }
    };
  }

  async stage(ctx, id, label, fn) {
    const s = this.state;
    s.activeAgent = id;
    s.live = { agentId: id, model: s.agents[id].model, stage: label, text: '' };
    this.setAgent(id, { status: 'running', progress: 0, detail: label, error: null });
    this.log(`[${id}] ${label}`);
    try { const r = await fn(); this.setAgent(id, { progress: 100 }); return r; }
    catch (e) {
      if (isAbort(e)) this.setAgent(id, { status: 'cancelled', detail: 'Cancelled by user' });
      else { this.log(`[${id}] FAILED: ${e.message}`); this.setAgent(id, { status: 'error', error: e.message, detail: 'Failed' }); }
      throw e;
    }
  }

  async preflight() {
    const cfg = this.state.config;
    const installed = await listModels(cfg.ollamaUrl, this.controller.signal);
    const missing = [...new Set([cfg.analystModel, cfg.cadModel, cfg.generatorModel || cfg.cadModel, cfg.reviewerModel])].filter(m => !modelInstalled(installed, m));
    if (missing.length) throw new OllamaError('model_missing', `Missing Ollama model(s): ${missing.join(', ')}. Run: ${missing.map(m => 'ollama pull ' + m).join(' ; ')}`);
    this.log('Preflight OK: Ollama reachable, all selected models installed.');
  }

  async run(prompt, cfg) {
    if (this.running) return false;
    this.running = true;
    this.controller = new AbortController();
    this.state = freshState(cfg, prompt);
    const s = this.state, o = s.outputs;
    s.status = 'running'; s.startedAt = new Date().toISOString(); this.log('Workflow started'); this.emit();
    const ctx = this.makeCtx();
    let cancelled = false, completed = false;

    try {
      try {
        await this.preflight();
        o.requirements = await this.stage(ctx, 'analyst', 'Extracting requirements', () => A.runAnalyst(ctx, prompt));
        const nMissing = o.requirements.missing_information.length;
        this.setAgent('analyst', { status: 'done', detail: `${nMissing} missing item(s), ${o.requirements.contradictions.length} contradiction(s)` });

        o.plan = await this.stage(ctx, 'planner', 'Building CAD plan', () => A.runPlanner(ctx, o.requirements));
        this.setAgent('planner', { status: 'done', detail: `${o.plan.steps.length} construction step(s)` });

        o.code = await this.stage(ctx, 'generator', 'Generating CadQuery code', () => A.runGenerator(ctx, { requirements: o.requirements, plan: o.plan }));
        this.setAgent('generator', { status: 'done', detail: `${o.code.split('\n').length} lines, complete program` });

        await this.reviewAndRepair(ctx);
        completed = true;
      } catch (e) {
        if (isAbort(e)) cancelled = true;
        else { s.status = 'failed'; s.error = e.message; this.log(`Workflow failed: ${e.message}`); }
      }

      // Final report: generated even after failures, as long as there is usable data. Never after cancellation.
      if (!cancelled && o.requirements) {
        let narrative = '';
        try {
          narrative = await this.stage(ctx, 'reporter', 'Writing final report', () => A.runReporter(ctx, reportFacts(s)));
          this.setAgent('reporter', { status: 'done', detail: 'Report ready' });
        } catch (e) {
          if (isAbort(e)) cancelled = true;
          else narrative = `(The Final Reporter model failed: ${e.message}. Only the application-generated status below is available.)`;
        }
        if (!cancelled && completed) s.status = 'completed';
        if (!cancelled) o.report = (narrative ? narrative + '\n\n' : '') + statusSection(s);
      }
    } finally {
      if (!cancelled && completed && s.status === 'running') s.status = 'completed';
      if (cancelled) { s.status = 'cancelled'; this.log('Workflow cancelled by user'); }
      for (const a of Object.values(s.agents)) if (a.status === 'waiting') this.setAgent(a.id, { status: 'skipped', detail: cancelled ? 'Not run (cancelled)' : 'Not run' });
      s.activeAgent = null; s.live.stage = s.status; s.finishedAt = new Date().toISOString();
      this.running = false; this.controller = null; this.emit();
    }
    return true;
  }

  async reviewAndRepair(ctx) {
    const s = this.state, o = s.outputs, max = s.config.maxRepairs;
    const review = (label) => this.stage(ctx, 'reviewer', label, () =>
      A.runReviewer(ctx, { requirements: o.requirements, plan: o.plan, code: o.code, label }));
    const done = r => this.setAgent('reviewer', r.approved
      ? { status: 'done', detail: `Approved (${r.issues.length} non-blocking note(s)); NOT executed` }
      : { status: 'warning', detail: `${r.issues.filter(i => i.severity === 'blocking').length} blocking issue(s)` });

    o.review = await review('Initial review'); done(o.review);
    let attempt = 0;
    while (!o.review.approved && attempt < max) {
      attempt++;
      const before = o.code, issues = o.review.issues.filter(i => i.severity === 'blocking' || i.severity === 'major');
      const entry = { attempt, issues_addressed: issues, code_before_chars: before.length };
      o.repairHistory.push(entry);
      try {
        o.code = await this.stage(ctx, 'repair', `Repair attempt ${attempt}/${max}`,
          () => A.runRepair(ctx, { requirements: o.requirements, plan: o.plan, code: before, issues }));
      } catch (e) {
        if (isAbort(e)) throw e;
        entry.error = e.message; entry.changed = false; break;        // keep previous code; report honestly
      }
      entry.changed = o.code !== before; entry.code_after = o.code; entry.code_after_chars = o.code.length;
      try { o.review = await review(`Re-review after repair ${attempt}`); }
      catch (e) {
        o.review = { ...o.review, approved: false, stale: true, summary: 'Re-review failed; the latest code has NOT been reviewed.' };
        throw e;
      }
      done(o.review);
      entry.review_after = { approved: o.review.approved, summary: o.review.summary, issues: o.review.issues };
    }

    if (attempt === 0) this.setAgent('repair', { status: 'skipped', detail: 'No repair needed' });
    else if (o.review.approved) this.setAgent('repair', { status: 'done', detail: `Approved after ${attempt} attempt(s)` });
    else {
      const why = [...o.repairHistory].reverse().find(h => h.error)?.error;
      this.setAgent('repair', { status: 'error', error: `Blocking issues remain after ${attempt} attempt(s)` + (why ? ` — repair error: ${why}` : ''), detail: 'Repair failed' });
    }
  }
}
