// agents.js — sequential agent execution and validation contracts.
import { chatStream, withRetry } from './ollama.js';
import { SAMPLING } from './config.js';
import { SYSTEM, USER } from './prompts.js';
import * as V from './validators.js';

export class WorkflowError extends Error {
  constructor(m) {
    super(m);
    this.name = 'WorkflowError';
  }
}

const options = (cfg, kind, numPredict) => ({
  temperature: cfg.temperature,
  num_predict: numPredict,
  num_ctx: cfg.numCtx,
  ...SAMPLING[kind]
});

const msgs = (system, user) => [
  { role: 'system', content: system },
  { role: 'user', content: user }
];

async function stream(ctx, { model, system, user, kind, numPredict, format, shouldStop }) {
  const { cfg } = ctx;
  return withRetry(
    () =>
      chatStream({
        baseUrl: cfg.ollamaUrl,
        model,
        messages: msgs(system, user),
        format,
        signal: ctx.signal,
        options: options(cfg, kind, numPredict),
        idleTimeoutMs: cfg.idleTimeoutSec * 1000,
        shouldStop,
        onToken: (_p, full, n) => ctx.onToken(full, n, numPredict)
      }),
    {
      retries: 2,
      signal: ctx.signal,
      onRetry: (e, n) => ctx.onNote(`Recoverable error (${e.kind}): ${e.message} — retry ${n}`)
    }
  );
}

// JSON agents: Ollama JSON mode + strict schema/geometry validation + corrective re-ask on failure.
async function jsonAgent(ctx, { model, system, user, validate, label }) {
  let prompt = user;
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    ctx.onStart(attempt === 1 ? label : `${label} (re-ask ${attempt - 1})`);
    const res = await stream(ctx, {
      model,
      system,
      user: prompt,
      kind: 'json',
      numPredict: ctx.cfg.jsonTokenLimit,
      format: 'json'
    });

    try {
      const data = V.parseJsonStrict(res.text);
      const errs = validate(data);
      if (errs.length) {
        throw new V.ValidationError('Validation errors:\n- ' + errs.slice(0, 8).join('\n- '));
      }
      return data;
    } catch (e) {
      if (!(e instanceof V.ValidationError)) throw e;
      lastErr = e.message;
      ctx.onNote(`Output rejected: ${lastErr}`);
      prompt = USER.jsonRetry(user, lastErr);
    }
  }
  throw new WorkflowError(`Agent output still invalid after 3 attempts:\n${lastErr}`);
}

// Code agents: stream, stop at first complete program, reject cut-off or repeated code.
async function codeAgent(ctx, { model, system, user, kind, label }) {
  let prompt = user;
  let reason = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    ctx.onStart(attempt === 1 ? label : `${label} (regeneration ${attempt - 1})`);
    const res = await stream(ctx, {
      model,
      system,
      user: prompt,
      kind,
      numPredict: ctx.cfg.cadTokenLimit,
      shouldStop: V.shouldStopStreaming
    });

    const ex = V.extractFirstProgram(res.text);
    if (ex.complete) {
      if (ex.repeated || res.stoppedEarly) {
        ctx.onNote('Extraneous or repeated model output discarded; retained first complete CadQuery program.');
      }
      return ex.code;
    }

    reason = ex.reason || 'program incomplete or malformed';
    ctx.onNote(`Incomplete code received: ${reason}`);
    prompt = USER.codeRetry(user, reason);
  }
  throw new WorkflowError(`No complete CadQuery program produced after 3 attempts: ${reason}`);
}

export const runAnalyst = (ctx, prompt) =>
  jsonAgent(ctx, {
    model: ctx.cfg.analystModel,
    system: SYSTEM.analyst,
    user: USER.analyst(prompt),
    validate: V.validateRequirements,
    label: 'Extracting mechanical requirements'
  });

export const runPlanner = (ctx, requirements) =>
  jsonAgent(ctx, {
    model: ctx.cfg.cadModel,
    system: SYSTEM.planner,
    user: USER.planner(requirements),
    validate: data => {
      // 1. Structural schema validation
      const structErrs = V.validatePlan(data);
      if (structErrs.length) return structErrs;

      // 2. Deterministic geometry plan validation
      const geomRes = V.validateGeometryPlan(data);
      if (!geomRes.valid) {
        return geomRes.errors.map(err => `[${err.id}] ${err.field}: ${err.message}`);
      }
      return [];
    },
    label: 'Synthesizing geometric construction plan'
  });

export const runGenerator = (ctx, { requirements, plan }) =>
  codeAgent(ctx, {
    model: ctx.cfg.generatorModel || ctx.cfg.cadModel,
    system: SYSTEM.generator,
    user: USER.generator(requirements, plan),
    kind: 'generator',
    label: 'Generating CadQuery Python source'
  });

export const runRepair = (ctx, { requirements, plan, code, issues }) =>
  codeAgent(ctx, {
    model: ctx.cfg.reviewerModel,
    system: SYSTEM.repair,
    user: USER.repair(requirements, plan, code, issues),
    kind: 'repair',
    label: 'Executing targeted CadQuery repair'
  });

export async function runReviewer(ctx, { requirements, plan, code, label }) {
  const raw = await jsonAgent(ctx, {
    model: ctx.cfg.reviewerModel,
    system: SYSTEM.reviewer,
    user: USER.reviewer(requirements, plan, code),
    validate: V.validateReview,
    label: label || 'Conducting independent code review'
  });
  return V.mergeReview(raw, V.staticChecks(code), code);
}

export async function runReporter(ctx, facts) {
  ctx.onStart('Drafting comprehensive engineering report');
  const res = await stream(ctx, {
    model: ctx.cfg.analystModel,
    system: SYSTEM.reporter,
    user: USER.reporter(facts),
    kind: 'text',
    numPredict: ctx.cfg.reportTokenLimit
  });
  return res.text.trim();
}
