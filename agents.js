// agents.js — the six agents. Each call is sequential; orchestration lives in workflow.js.
import { chatStream, withRetry } from './ollama.js';
import { SAMPLING } from './config.js';
import { SYSTEM, USER } from './prompts.js';
import * as V from './validators.js';

export class WorkflowError extends Error { constructor(m) { super(m); this.name = 'WorkflowError'; } }

const options = (cfg, kind, numPredict) => ({
  temperature: cfg.temperature, num_predict: numPredict, num_ctx: cfg.numCtx, ...SAMPLING[kind]
});
const msgs = (system, user) => [{ role: 'system', content: system }, { role: 'user', content: user }];

async function stream(ctx, { model, system, user, kind, numPredict, format, shouldStop }) {
  const { cfg } = ctx;
  return withRetry(() => chatStream({
    baseUrl: cfg.ollamaUrl, model, messages: msgs(system, user), format, signal: ctx.signal,
    options: options(cfg, kind, numPredict), idleTimeoutMs: cfg.idleTimeoutSec * 1000, shouldStop,
    onToken: (_p, full, n) => ctx.onToken(full, n, numPredict)
  }), { retries: 2, signal: ctx.signal, onRetry: (e, n) => ctx.onNote(`Recoverable error (${e.kind}): ${e.message} — retry ${n}`) });
}

// JSON agents: Ollama JSON mode + schema validation + one corrective re-ask per failure.
async function jsonAgent(ctx, { model, system, user, validate, label }) {
  let prompt = user, lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    ctx.onStart(attempt === 1 ? label : `${label} (re-ask ${attempt - 1})`);
    const res = await stream(ctx, { model, system, user: prompt, kind: 'json', numPredict: ctx.cfg.jsonTokenLimit, format: 'json' });
    try {
      const data = V.parseJsonStrict(res.text);
      const errs = validate(data);
      if (errs.length) throw new V.ValidationError('Schema errors: ' + errs.slice(0, 8).join('; '));
      return data;
    } catch (e) {
      if (!(e instanceof V.ValidationError)) throw e;
      lastErr = e.message; ctx.onNote(`Output rejected: ${lastErr}`);
      prompt = USER.jsonRetry(user, lastErr);
    }
  }
  throw new WorkflowError(`Output still invalid after retries: ${lastErr}`);
}

// Code agents: stream, stop at the FIRST complete program, never accept incomplete code.
async function codeAgent(ctx, { model, system, user, kind, label }) {
  let prompt = user, reason = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    ctx.onStart(attempt === 1 ? label : `${label} (regeneration ${attempt - 1})`);
    const res = await stream(ctx, { model, system, user: prompt, kind, numPredict: ctx.cfg.cadTokenLimit, shouldStop: V.shouldStopStreaming });
    const ex = V.extractFirstProgram(res.text);
    if (ex.complete) {
      if (ex.repeated || res.stoppedEarly) ctx.onNote('Repeated/extra model output was discarded; only the first complete program was kept.');
      return ex.code;
    }
    reason = ex.reason || 'no complete program';
    ctx.onNote(`Incomplete program (${reason}).`);
    prompt = USER.codeRetry(user, reason);
  }
  throw new WorkflowError(`No complete Python program after 3 attempts: ${reason}`);
}

export const runAnalyst = (ctx, prompt) => jsonAgent(ctx, {
  model: ctx.cfg.analystModel, system: SYSTEM.analyst, user: USER.analyst(prompt),
  validate: V.validateRequirements, label: 'Extracting requirements' });

export const runPlanner = (ctx, requirements) => jsonAgent(ctx, {
  model: ctx.cfg.cadModel, system: SYSTEM.planner, user: USER.planner(requirements),
  validate: V.validatePlan, label: 'Building CAD plan' });

export const runGenerator = (ctx, { requirements, plan }) => codeAgent(ctx, {
  model: ctx.cfg.generatorModel || ctx.cfg.cadModel, system: SYSTEM.generator, user: USER.generator(requirements, plan),
  kind: 'generator', label: 'Generating CadQuery code' });

export const runRepair = (ctx, { requirements, plan, code, issues }) => codeAgent(ctx, {
  model: ctx.cfg.reviewerModel, system: SYSTEM.repair, user: USER.repair(requirements, plan, code, issues),
  kind: 'repair', label: 'Repairing code' });

export async function runReviewer(ctx, { requirements, plan, code, label }) {
  const raw = await jsonAgent(ctx, {
    model: ctx.cfg.reviewerModel, system: SYSTEM.reviewer, user: USER.reviewer(requirements, plan, code),
    validate: V.validateReview, label });
  return V.mergeReview(raw, V.staticChecks(code), code);
}

export async function runReporter(ctx, facts) {
  ctx.onStart('Writing final report');
  const res = await stream(ctx, { model: ctx.cfg.analystModel, system: SYSTEM.reporter, user: USER.reporter(facts),
                                  kind: 'text', numPredict: ctx.cfg.reportTokenLimit });
  return res.text.trim();
}
