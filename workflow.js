// workflow.js — state machine, execution orchestration, repair stagnation detection and verification derivations.
import { AGENTS } from './config.js';
import { listModels, modelInstalled, OllamaError } from './ollama.js';
import * as A from './agents.js';
import * as V from './validators.js';

const isAbort = e => e && e.name === 'AbortError';
const BLANK_LIVE = { agentId: null, model: '', stage: '', text: '' };

export function computeVerification(s) {
  const o = s.outputs;
  let review = 'NOT RUN';
  if (o.review) {
    if (o.review.stale) {
      review = 'STALE — latest code not re-reviewed';
    } else if (o.review.approved) {
      const notes = (o.review.minor_count || 0) + (o.review.info_count || 0);
      review = `APPROVED (static + LLM review; ${notes} non-blocking note(s))`;
    } else {
      const b = o.review.blocking_count ?? o.review.issues?.filter(i => i.severity === 'blocking').length ?? 0;
      const m = o.review.major_count ?? o.review.issues?.filter(i => i.severity === 'major').length ?? 0;
      review = `UNRESOLVED ISSUES (${b} blocking, ${m} major)`;
    }
  }

  let planVal = 'NOT RUN';
  if (o.planValidation) {
    planVal = o.planValidation.valid ? 'PASSED (deterministic)' : `FAILED (${o.planValidation.errors?.length || 0} error(s))`;
  }

  return {
    requirements_extracted: !!o.requirements,
    cad_plan_generated: !!o.plan,
    plan_deterministic_validation: planVal,
    python_generated: !!o.code,
    static_review: review,
    python_execution: 'NOT VERIFIED',
    geometry_validity: 'NOT VERIFIED',
    step_export: 'NOT VERIFIED',
    stl_export: 'NOT VERIFIED'
  };
}

function reportFacts(s) {
  const o = s.outputs;
  const r = o.requirements;
  const p = o.plan;
  const pv = o.planValidation;

  return {
    workflow_status: s.status,
    failures: Object.values(s.agents)
      .filter(a => a.error)
      .map(a => `${a.name}: ${a.error}`),
    verification: computeVerification(s),
    requirements: r && {
      object: r.object,
      mechanical_purpose: r.mechanical_purpose,
      summary: r.summary,
      units: r.units,
      materials: r.materials,
      manufacturing_constraints: r.manufacturing_constraints,
      functional_requirements: r.functional_requirements,
      mounting_requirements: r.mounting_requirements,
      tolerances: r.tolerances,
      component_count: r.component_count,
      components: r.components,
      dimensions: r.dimensions,
      features: r.features,
      explicit_requirements: r.explicit_requirements,
      derived_engineering_info: r.derived_engineering_info,
      assumptions: r.assumptions,
      missing_information: r.missing_information,
      contradictions: r.contradictions,
      warnings: r.warnings
    },
    plan: p && {
      coordinate_system: p.coordinate_system,
      parameters: p.parameters,
      step_count: p.steps?.length,
      steps: p.steps,
      holes: p.holes,
      fillets_chamfers: p.fillets_chamfers,
      expected_bounding_box: p.expected_bounding_box,
      expected_solid_count: p.expected_solid_count,
      provisional_assumptions: p.provisional_assumptions,
      validation_steps: p.validation_steps
    },
    plan_validation: pv && {
      valid: pv.valid,
      summary: pv.summary,
      error_count: pv.errors?.length || 0,
      warning_count: pv.warnings?.length || 0,
      errors: pv.errors,
      warnings: pv.warnings,
      disclaimer: pv.disclaimer
    },
    code: o.code
      ? {
          chars: o.code.length,
          lines: o.code.split('\n').length,
          hash: V.hashCode(o.code)
        }
      : null,
    review: o.review && {
      approved: o.review.approved,
      stale: !!o.review.stale,
      blocking_count: o.review.blocking_count,
      major_count: o.review.major_count,
      minor_count: o.review.minor_count,
      info_count: o.review.info_count,
      summary: o.review.summary,
      issues: o.review.issues,
      discarded_issues_count: o.review.discarded_issues?.length || 0
    },
    repair_history: o.repairHistory.map(h => ({
      attempt: h.attempt,
      hash_before: h.hash_before,
      hash_after: h.hash_after,
      is_identical: h.is_identical,
      meaningful_change: h.meaningful_change,
      resolved_count: h.resolved_count,
      unresolved_count: h.unresolved_count,
      new_issues_count: h.new_issues_count,
      outcome: h.outcome,
      stop_reason: h.stop_reason,
      error: h.error || null,
      changed: h.changed,
      approved_after: h.review_after?.approved ?? null
    }))
  };
}

export function statusSection(s) {
  const v = computeVerification(s);
  const yn = b => (b ? 'YES' : 'NO');
  return [
    '=== APPLICATION-GENERATED STATUS (authoritative) ===',
    `Workflow status: ${s.status}`,
    `1. Requirements extracted: ${yn(v.requirements_extracted)}`,
    `2. CAD plan generated: ${yn(v.cad_plan_generated)}`,
    `3. Deterministic geometry plan validation: ${v.plan_deterministic_validation}`,
    `4. Python source generated: ${yn(v.python_generated)}`,
    `5. Static code review: ${v.static_review}`,
    `6. Python execution: ${v.python_execution}`,
    `7. Geometry validity: ${v.geometry_validity}`,
    `8. STEP/STL exports: ${v.step_export} / ${v.stl_export}`,
    `Repair attempts used: ${s.outputs.repairHistory.length}`,
    'Notice: The browser environment does not execute Python. To generate valid STEP/STL solids: pip install cadquery, run generated_cad.py locally, and verify in a CAD viewer.'
  ].join('\n');
}

function freshState(cfg = {}, prompt = '') {
  const agents = {};
  for (const a of AGENTS) {
    agents[a.id] = {
      id: a.id,
      name: a.name,
      model: cfg[a.modelKey] || cfg.cadModel || '',
      status: 'waiting',
      progress: 0,
      detail: '',
      error: null
    };
  }
  return {
    status: 'idle',
    prompt,
    config: { ...cfg },
    startedAt: null,
    finishedAt: null,
    activeAgent: null,
    agents,
    live: { ...BLANK_LIVE },
    outputs: {
      requirements: null,
      plan: null,
      planValidation: null,
      code: null,
      review: null,
      repairHistory: [],
      report: null
    },
    log: []
  };
}

export class Workflow {
  constructor() {
    this.listeners = new Set();
    this.state = freshState();
    this.controller = null;
    this.running = false;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  log(msg) {
    this.state.log.push({ t: new Date().toISOString(), msg });
  }

  setAgent(id, patch) {
    if (this.state.agents[id]) {
      Object.assign(this.state.agents[id], patch);
      this.emit();
    }
  }

  stop() {
    if (this.running) this.controller?.abort();
  }

  reset() {
    if (this.running) return false;
    this.state = freshState();
    this.emit();
    return true;
  }

  makeCtx() {
    const s = this.state;
    return {
      cfg: s.config,
      signal: this.controller.signal,
      onStart: label => {
        s.live.stage = label;
        s.live.text = '';
        this.setAgent(s.activeAgent, { detail: label, progress: 0 });
      },
      onToken: (full, n, limit) => {
        s.live.text = full;
        if (s.activeAgent && s.agents[s.activeAgent]) {
          s.agents[s.activeAgent].progress = Math.min(95, Math.round((n / limit) * 100));
        }
        this.emit();
      },
      onNote: msg => {
        this.log(`[${s.activeAgent}] ${msg}`);
        s.live.stage = msg;
        this.emit();
      }
    };
  }

  async stage(ctx, id, label, fn) {
    const s = this.state;
    s.activeAgent = id;
    s.live = { agentId: id, model: s.agents[id].model, stage: label, text: '' };
    this.setAgent(id, { status: 'running', progress: 0, detail: label, error: null });
    this.log(`[${id}] ${label}`);
    try {
      const r = await fn();
      this.setAgent(id, { progress: 100 });
      return r;
    } catch (e) {
      if (isAbort(e)) {
        this.setAgent(id, { status: 'cancelled', detail: 'Cancelled by user' });
      } else {
        this.log(`[${id}] FAILED: ${e.message}`);
        this.setAgent(id, { status: 'error', error: e.message, detail: 'Failed' });
      }
      throw e;
    }
  }

  async preflight() {
    const cfg = this.state.config;
    const installed = await listModels(cfg.ollamaUrl, this.controller.signal);
    const required = [
      cfg.analystModel,
      cfg.cadModel,
      cfg.generatorModel || cfg.cadModel,
      cfg.reviewerModel
    ];
    const missing = [...new Set(required)].filter(m => !modelInstalled(installed, m));
    if (missing.length) {
      throw new OllamaError(
        'model_missing',
        `Missing Ollama model(s): ${missing.join(', ')}. Run: ${missing.map(m => 'ollama pull ' + m).join(' ; ')}`
      );
    }
    this.log('Preflight OK: Ollama reachable and all required models installed.');
  }

  async run(prompt, cfg) {
    if (this.running) return false;
    this.running = true;
    this.controller = new AbortController();
    this.state = freshState(cfg, prompt);
    const s = this.state;
    const o = s.outputs;
    s.status = 'running';
    s.startedAt = new Date().toISOString();
    this.log('Workflow initiated');
    this.emit();
    const ctx = this.makeCtx();

    let cancelled = false;
    let pipelineCompleted = false;

    try {
      try {
        await this.preflight();

        // 1. Requirement Analyst
        o.requirements = await this.stage(ctx, 'analyst', 'Extracting mechanical requirements', () =>
          A.runAnalyst(ctx, prompt)
        );
        const nMissing = o.requirements.missing_information?.length || 0;
        const nContra = o.requirements.contradictions?.length || 0;
        this.setAgent('analyst', {
          status: 'done',
          detail: `${nMissing} missing item(s), ${nContra} contradiction(s)`
        });

        // 2. CAD Planner
        o.plan = await this.stage(ctx, 'planner', 'Synthesizing geometric construction plan', () =>
          A.runPlanner(ctx, o.requirements)
        );
        o.planValidation = V.validateGeometryPlan(o.plan);
        const nSteps = o.plan.steps?.length || 0;
        this.setAgent('planner', {
          status: 'done',
          detail: `${nSteps} step(s); deterministic validation ${o.planValidation.valid ? 'PASSED' : 'WARNED'}`
        });

        // 3. CAD Generator
        o.code = await this.stage(ctx, 'generator', 'Generating CadQuery Python source', () =>
          A.runGenerator(ctx, { requirements: o.requirements, plan: o.plan })
        );
        this.setAgent('generator', {
          status: 'done',
          detail: `${o.code.split('\n').length} lines, complete program`
        });

        // 4 & 5. Reviewer and Repair Orchestration
        await this.reviewAndRepair(ctx);
        pipelineCompleted = true;
      } catch (e) {
        if (isAbort(e)) {
          cancelled = true;
        } else {
          s.status = 'failed';
          s.error = e.message;
          this.log(`Workflow encountered error: ${e.message}`);
        }
      }

      // 6. Final Reporter (runs if requirements exist and not cancelled)
      if (!cancelled && o.requirements) {
        let narrative = '';
        try {
          narrative = await this.stage(ctx, 'reporter', 'Drafting comprehensive engineering report', () =>
            A.runReporter(ctx, reportFacts(s))
          );
          this.setAgent('reporter', { status: 'done', detail: 'Report generated' });
        } catch (e) {
          if (isAbort(e)) {
            cancelled = true;
          } else {
            narrative = `(The Final Reporter agent failed: ${e.message}. Authoritative verification status is provided below.)`;
          }
        }

        if (!cancelled) {
          o.report = (narrative ? narrative + '\n\n' : '') + statusSection(s);
          if (pipelineCompleted) {
            s.status = o.review?.approved ? 'completed' : 'unresolved';
          }
        }
      }
    } finally {
      if (cancelled) {
        s.status = 'cancelled';
        this.log('Workflow cancelled by user');
      } else if (pipelineCompleted && s.status === 'running') {
        s.status = o.review?.approved ? 'completed' : 'unresolved';
      }

      // Clean up stranded agent statuses
      for (const a of Object.values(s.agents)) {
        if (a.status === 'waiting' || a.status === 'running') {
          this.setAgent(a.id, {
            status: cancelled ? 'cancelled' : 'skipped',
            detail: cancelled ? 'Cancelled by user' : 'Not executed'
          });
        }
      }

      s.activeAgent = null;
      s.live.stage = s.status;
      s.finishedAt = new Date().toISOString();
      this.running = false;
      this.controller = null;
      this.emit();
    }
    return true;
  }

  async reviewAndRepair(ctx) {
    const s = this.state;
    const o = s.outputs;
    const max = s.config.maxRepairs;

    const review = label =>
      this.stage(ctx, 'reviewer', label, () =>
        A.runReviewer(ctx, { requirements: o.requirements, plan: o.plan, code: o.code, label })
      );

    const updateReviewerAgent = r => {
      if (r.approved) {
        const notes = (r.minor_count || 0) + (r.info_count || 0);
        this.setAgent('reviewer', {
          status: 'done',
          detail: `Approved (${notes} note(s); 0 blocking/major; NOT executed)`
        });
      } else {
        const b = r.blocking_count ?? r.issues?.filter(i => i.severity === 'blocking').length ?? 0;
        const m = r.major_count ?? r.issues?.filter(i => i.severity === 'major').length ?? 0;
        this.setAgent('reviewer', {
          status: 'warning',
          detail: `${b} blocking, ${m} major issue(s) prevent approval`
        });
      }
    };

    o.review = await review('Initial code review');
    updateReviewerAgent(o.review);

    let attempt = 0;
    while (!o.review.approved && attempt < max) {
      attempt++;
      const before = o.code;
      const issuesToFix = o.review.issues.filter(i => i.severity === 'blocking' || i.severity === 'major');
      const hashBefore = V.hashCode(before);

      let repairedCode = before;
      let repairError = null;

      try {
        repairedCode = await this.stage(ctx, 'repair', `Repair attempt ${attempt}/${max}`, () =>
          A.runRepair(ctx, { requirements: o.requirements, plan: o.plan, code: before, issues: issuesToFix })
        );
      } catch (e) {
        if (isAbort(e)) throw e;
        repairError = e.message;
        this.log(`[repair] Attempt ${attempt} failed: ${e.message}`);
      }

      if (repairError) {
        o.repairHistory.push({
          attempt,
          hash_before: hashBefore,
          hash_after: hashBefore,
          code_before_chars: before.length,
          code_after_chars: before.length,
          changed: false,
          meaningful_change: false,
          error: repairError,
          outcome: 'error',
          stop_reason: `Repair agent threw error: ${repairError}`
        });
        break;
      }

      o.code = repairedCode;
      const hashAfter = V.hashCode(repairedCode);

      // Re-review after repair
      let reReview = null;
      try {
        reReview = await review(`Re-review after repair ${attempt}`);
      } catch (e) {
        o.review = {
          ...o.review,
          approved: false,
          stale: true,
          summary: 'Re-review failed; latest code was not successfully reviewed.'
        };
        throw e;
      }

      o.review = reReview;
      updateReviewerAgent(o.review);

      // Analyze stagnation / regression / progress
      const analysis = V.analyzeRepairAttempt({
        beforeCode: before,
        afterCode: repairedCode,
        beforeIssues: issuesToFix,
        afterReview: reReview,
        attempt,
        maxRepairs: max
      });

      const entry = {
        attempt,
        hash_before: hashBefore,
        hash_after: hashAfter,
        code_before_chars: before.length,
        code_after_chars: repairedCode.length,
        changed: repairedCode !== before,
        meaningful_change: analysis.meaningful_change,
        resolved_count: analysis.resolved_count,
        unresolved_count: analysis.unresolved_count,
        new_issues_count: analysis.new_issues_count,
        resolved_issues: analysis.resolved_issues,
        unresolved_issues: analysis.unresolved_issues,
        new_issues: analysis.new_issues,
        outcome: analysis.outcome,
        stop_reason: analysis.stop_reason,
        review_after: {
          approved: reReview.approved,
          summary: reReview.summary,
          blocking_count: reReview.blocking_count,
          major_count: reReview.major_count,
          minor_count: reReview.minor_count,
          issues: reReview.issues
        }
      };
      o.repairHistory.push(entry);

      this.log(`[repair] Attempt ${attempt} outcome: ${analysis.outcome}${analysis.stop_reason ? ' (' + analysis.stop_reason + ')' : ''}`);

      if (analysis.should_stop) {
        break;
      }
    }

    if (attempt === 0) {
      this.setAgent('repair', { status: 'skipped', detail: 'No repair needed (approved on initial review)' });
    } else if (o.review.approved) {
      this.setAgent('repair', { status: 'done', detail: `Approved after ${attempt} attempt(s)` });
    } else {
      const lastEntry = o.repairHistory[o.repairHistory.length - 1];
      const why = lastEntry?.stop_reason || `Unresolved issues remain after ${attempt} attempt(s)`;
      this.setAgent('repair', {
        status: 'warning',
        error: why,
        detail: `Halted: ${lastEntry?.outcome || 'issues remain'}`
      });
    }
  }
}
