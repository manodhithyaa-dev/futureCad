// validators.js — JSON schema checks, Python program extraction/completeness, static CadQuery checks.
export class ValidationError extends Error { constructor(m) { super(m); this.name = 'ValidationError'; } }

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isArr = Array.isArray;

// ---------- JSON (separate strategy from Python) ----------
export function parseJsonStrict(text) {
  let t = (text || '').trim();
  if (!t) throw new ValidationError('Empty response');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); }
  catch (e1) {
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* fall through */ } }
    throw new ValidationError('Invalid or truncated JSON: ' + e1.message);
  }
}

export function validateRequirements(o) {
  const e = [];
  if (!isObj(o)) return ['root must be a JSON object'];
  if (typeof o.object !== 'string' || !o.object.trim()) e.push('"object" must be a non-empty string');
  for (const k of ['dimensions', 'features', 'explicit_requirements', 'assumptions',
                   'missing_information', 'contradictions', 'warnings'])
    if (!isArr(o[k])) e.push(`"${k}" must be an array`);
  return e;
}

export function validatePlan(o) {
  const e = [];
  if (!isObj(o)) return ['root must be a JSON object'];
  if (!isObj(o.coordinate_system)) e.push('"coordinate_system" must be an object');
  if (!isArr(o.steps) || !o.steps.length) e.push('"steps" must be a non-empty array');
  else o.steps.forEach((s, i) => {
    if (!isObj(s)) return e.push(`steps[${i}] must be an object`);
    for (const k of ['geometry', 'workplane', 'resulting_bounding_box'])
      if (s[k] === undefined || s[k] === null || s[k] === '') e.push(`steps[${i}].${k} is required`);
  });
  if (!isObj(o.expected_bounding_box)) e.push('"expected_bounding_box" must be an object');
  if (typeof o.expected_solid_count !== 'number') e.push('"expected_solid_count" must be a number');
  if (!isArr(o.validation_steps)) e.push('"validation_steps" must be an array');
  if (!isArr(o.provisional_assumptions)) e.push('"provisional_assumptions" must be an array');
  return e;
}

const SEVERITIES = ['blocking', 'major', 'minor', 'info'];
export function validateReview(o) {
  const e = [];
  if (!isObj(o)) return ['root must be a JSON object'];
  if (typeof o.approved !== 'boolean') e.push('"approved" must be a boolean');
  if (!isArr(o.issues)) e.push('"issues" must be an array');
  else o.issues.forEach((it, i) => {
    if (!isObj(it)) return e.push(`issues[${i}] must be an object`);
    for (const k of ['severity', 'evidence', 'explanation', 'suggested_correction'])
      if (typeof it[k] !== 'string' || !it[k].trim()) e.push(`issues[${i}].${k} must be a non-empty string`);
  });
  return e;
}

// ---------- Python scanning ----------
export function scanPython(code) {
  const stack = [], pairs = { ')': '(', ']': '[', '}': '{' };
  let i = 0; const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '#') { while (i < n && code[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const tri = code.startsWith(c.repeat(3), i), q = tri ? c.repeat(3) : c;
      i += q.length; let closed = false;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code.startsWith(q, i)) { i += q.length; closed = true; break; }
        if (!tri && code[i] === '\n') break;
        i++;
      }
      if (!closed) return { ok: false, reason: 'unterminated string literal' };
      continue;
    }
    if ('([{'.includes(c)) stack.push(c);
    else if (')]}'.includes(c) && stack.pop() !== pairs[c]) return { ok: false, reason: `unbalanced '${c}'` };
    i++;
  }
  return stack.length ? { ok: false, reason: `${stack.length} unclosed bracket(s)` } : { ok: true };
}

export function checkComplete(code) {
  if (!/^[ \t]*import\s+cadquery\s+as\s+cq\b/m.test(code))
    return { complete: false, reason: 'missing "import cadquery as cq"' };
  const sc = scanPython(code);
  if (!sc.ok) return { complete: false, reason: 'program is cut off or malformed (' + sc.reason + ')' };
  const lines = code.split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !l.trim().startsWith('#'));
  const last = lines[lines.length - 1] || '';
  if (/[,\\+\-*\/=:(\[{.]$/.test(last)) return { complete: false, reason: 'last line looks unfinished: ' + last.trim().slice(0, 60) };
  if (lines.length < 8) return { complete: false, reason: 'program is too short to be complete' };
  return { complete: true };
}

const IMPORT_G = /^[ \t]*import\s+cadquery\s+as\s+cq\b/gm;

/** Extracts ONLY the first Python program from model output; never concatenates repeats. */
export function extractFirstProgram(text) {
  let body, fenceClosed = false;
  const open = /```(?:python|py)[ \t]*\r?\n/i.exec(text) || /```[ \t]*\r?\n(?=[ \t]*(?:#|import|from))/.exec(text);
  if (open) {
    const start = open.index + open[0].length, close = text.indexOf('```', start);
    fenceClosed = close >= 0;
    body = fenceClosed ? text.slice(start, close) : text.slice(start);
  } else {
    const m = /^[ \t]*import\s+cadquery\s+as\s+cq\b/m.exec(text);
    if (!m) return { code: '', complete: false, fenceClosed: false, repeated: false, reason: 'no Python code found in response' };
    body = text.slice(m.index);
  }
  const imports = [...body.matchAll(IMPORT_G)];
  let repeated = false;
  if (imports.length > 1) { body = body.slice(0, imports[1].index); repeated = true; }
  body = body.replace(/\s+$/, '') + '\n';
  return { code: body, fenceClosed, repeated, ...checkComplete(body) };
}

/** Streaming predicate: stop as soon as the first complete program is available. */
export function shouldStopStreaming(text, piece, tokens) {
  if (!(piece.includes('`') || piece.includes('cq') || tokens % 16 === 0)) return false;
  const ex = extractFirstProgram(text);
  return ex.complete && (ex.fenceClosed || ex.repeated);
}

// ---------- Static CadQuery checks (real, deterministic; NOT execution) ----------
const INVALID_METHODS = ['extrude_bidir', 'extrudeBidir', 'fillet_edges', 'chamfer_edges', 'hole_at', 'cutHole', 'add_hole', 'CadQuery.Workplane', 'filletQ', 'chamferQ', 'cq.Query'];

export function staticChecks(code) {
  const out = [];
  const add = (severity, evidence, explanation, fix) =>
    out.push({ severity, evidence, explanation, suggested_correction: fix, source: 'static-check' });
  const lineOf = re => (code.split('\n').find(l => re.test(l)) || '').trim();

  if (!/^[ \t]*import\s+cadquery\s+as\s+cq\b/m.test(code))
    add('blocking', 'ABSENT: import cadquery as cq', 'Required import is missing.', 'Add "import cadquery as cq" at the top.');
  for (const m of INVALID_METHODS) {
    const re = new RegExp(m.replace('.', '\\.') + '\\b');
    if (re.test(code)) add('blocking', lineOf(re), `"${m}" is not a valid CadQuery API.`, 'Replace it with documented CadQuery calls (extrude, hole, fillet, union, cut).');
  }
  if (!/\bcq\.Workplane\s*\(/.test(code))
    add('blocking', 'ABSENT: cq.Workplane(', 'No cq.Workplane is used, so no CadQuery solid is constructed.', 'Build the solid with cq.Workplane(...).');
  if (!/(exportStep|exporters\.export\([^)]*\.step|\.step['"])/i.test(code))
    add('blocking', 'ABSENT: STEP export', 'No STEP export found.', 'Add cq.exporters.export(result, "part.step").');
  if (!/(exportStl|exporters\.export\([^)]*\.stl|\.stl['"])/i.test(code))
    add('blocking', 'ABSENT: STL export', 'No STL export found.', 'Add cq.exporters.export(result, "part.stl").');
  const sc = scanPython(code);
  if (!sc.ok) add('blocking', 'ABSENT: balanced syntax', 'Syntax structure problem: ' + sc.reason + '.', 'Fix the unbalanced brackets/strings.');
  if ((code.match(IMPORT_G) || []).length > 1)
    add('blocking', lineOf(/import\s+cadquery/), 'Program text is repeated (multiple imports).', 'Keep exactly one program.');
  return out;
}

const norm = s => String(s).replace(/\s+/g, ' ').trim();

/** Merge reviewer output with static findings. Reviewer issues whose evidence is not in the code are discarded (no invented errors). */
export function mergeReview(raw, staticIssues, code) {
  const nc = norm(code), kept = [], discarded = [];
  for (const it of raw.issues || []) {
    const sev = SEVERITIES.includes(String(it.severity).toLowerCase()) ? String(it.severity).toLowerCase() : 'minor';
    const issue = { severity: sev, evidence: it.evidence, explanation: it.explanation, suggested_correction: it.suggested_correction, source: 'llm-reviewer' };
    const ev = norm(it.evidence);
    if (/^ABSENT:/i.test(ev) || (ev.length > 2 && nc.includes(ev))) kept.push(issue);
    else discarded.push({ ...issue, discard_reason: 'evidence not found in code' });
  }
  for (const s of staticIssues)
    if (!kept.some(k => norm(k.evidence) === norm(s.evidence))) kept.push(s);
  const approved = !kept.some(i => i.severity === 'blocking');
  return {
    approved, summary: raw.summary || '', reviewer_said_approved: raw.approved,
    issues: kept, discarded_issues: discarded,
    note: 'Static/LLM review only. The code has NOT been executed.',
    reviewed_at: new Date().toISOString()
  };
}
