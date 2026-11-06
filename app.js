// app.js — UI wiring, rendering and deliverable presentation.
import { AGENTS, DEFAULT_CONFIG, EXAMPLE_PROMPT, loadConfig, saveConfig } from './config.js';
import { listModels, modelInstalled } from './ollama.js';
import { Workflow, computeVerification } from './workflow.js';
import { DELIVERABLES, downloadDeliverable, isAvailable } from './downloads.js';

const $ = id => document.getElementById(id);
const wf = new Workflow();
let cfg = loadConfig();
let installed = null; // null = unknown
let activeTab = 'requirements';
let connAbort = null;

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = {
  waiting: 'Waiting',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  warning: 'Issues remain',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  completed: 'Completed',
  unresolved: 'Unresolved',
  failed: 'Failed'
};

const SELECTS = [
  ['cfgAnalyst', 'analystModel'],
  ['cfgCad', 'cadModel'],
  ['cfgGen', 'generatorModel'],
  ['cfgReviewer', 'reviewerModel']
];

// ---------- Configuration form ----------
function readConfig() {
  const num = (id, min, max, def) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  cfg = {
    ...cfg,
    ollamaUrl: $('cfgUrl').value.trim().replace(/\/+$/, '') || DEFAULT_CONFIG.ollamaUrl,
    analystModel: $('cfgAnalyst').value || DEFAULT_CONFIG.analystModel,
    cadModel: $('cfgCad').value || DEFAULT_CONFIG.cadModel,
    generatorModel: $('cfgGen').value,
    reviewerModel: $('cfgReviewer').value || DEFAULT_CONFIG.reviewerModel,
    maxRepairs: Math.round(num('cfgRepairs', 0, 5, 3)),
    temperature: num('cfgTemp', 0, 1, 0.1),
    cadTokenLimit: Math.round(num('cfgTokens', 500, 16000, 3000)),
    jsonTokenLimit: Math.round(num('cfgJsonTokens', 500, 16000, 3072)),
    numCtx: Math.round(num('cfgCtx', 2048, 65536, 8192)),
    idleTimeoutSec: Math.round(num('cfgIdle', 20, 900, 180))
  };
  return cfg;
}

function fillSelects() {
  for (const [id, key] of SELECTS) {
    const el = $(id);
    const cur = cfg[key];
    const names = [...new Set([...(installed || []), cur])].filter(Boolean);
    el.innerHTML =
      (id === 'cfgGen' ? `<option value=""${cur ? '' : ' selected'}>Same as CAD model</option>` : '') +
      names
        .map(n => {
          const missing = installed && !modelInstalled(installed, n);
          return `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}${missing ? '  (not installed)' : ''}</option>`;
        })
        .join('');
  }
}

function fillForm() {
  $('cfgUrl').value = cfg.ollamaUrl;
  $('cfgRepairs').value = cfg.maxRepairs;
  $('cfgTemp').value = cfg.temperature;
  $('cfgTokens').value = cfg.cadTokenLimit;
  $('cfgJsonTokens').value = cfg.jsonTokenLimit;
  $('cfgCtx').value = cfg.numCtx;
  $('cfgIdle').value = cfg.idleTimeoutSec;
  fillSelects();
}

function updateModelChip() {
  const chip = $('modelChip');
  if (!installed) {
    chip.textContent = 'Models: unknown';
    return;
  }
  const need = [...new Set([cfg.analystModel, cfg.cadModel, cfg.generatorModel || cfg.cadModel, cfg.reviewerModel])];
  const miss = need.filter(m => !modelInstalled(installed, m));
  chip.textContent = miss.length ? `Missing: ${miss.join(', ')}` : `Models: ${need.length}/${need.length} installed`;
  chip.style.color = miss.length ? 'var(--err)' : 'var(--ok)';
}

async function testConnection() {
  readConfig();
  saveConfig(cfg);
  connAbort?.abort();
  connAbort = new AbortController();
  $('connText').textContent = 'Ollama: testing…';
  try {
    installed = await listModels(cfg.ollamaUrl, connAbort.signal);
    $('connDot').className = 'dot ok';
    $('connText').textContent = `Ollama: connected (${installed.length} models)`;
    $('cfgMsg').className = 'hint ok';
    $('cfgMsg').textContent = 'Connection OK.';
  } catch (e) {
    if (e.name === 'AbortError') return;
    installed = null;
    $('connDot').className = 'dot err';
    $('connText').textContent = 'Ollama: unreachable';
    $('cfgMsg').className = 'hint err';
    $('cfgMsg').textContent = e.message;
  }
  fillSelects();
  updateModelChip();
}

// ---------- Rendering ----------
let raf = 0;
const schedule = () => {
  if (!raf)
    raf = requestAnimationFrame(() => {
      raf = 0;
      render(wf.state);
    });
};

function render(s) {
  // 1. Pipeline cards
  $('pipeline').innerHTML = AGENTS.map((a, i) => {
    const ag = s.agents[a.id];
    const model = ag.model || cfg[a.modelKey];
    return `<div class="agent ${ag.status}">
      <div class="agent-top">
        <span>${String(i + 1).padStart(2, '0')}</span>
        <span class="badge">${STATUS[ag.status] || ag.status}</span>
      </div>
      <h4>${esc(a.name)}</h4>
      <div class="model">${esc(model)}</div>
      <div class="bar"><i style="width:${ag.status === 'waiting' ? 0 : ag.progress}%"></i></div>
      <div class="detail">${esc(ag.error || ag.detail || '')}</div>
    </div>`;
  }).join('');

  // 2. Accurate progress calculation: failed agents NEVER count as 100% complete!
  const vals = Object.values(s.agents);
  const completedWeight = vals.reduce((sum, a) => {
    if (a.status === 'done') return sum + 1.0;
    if (a.status === 'skipped') return sum + 0.5;
    if (a.status === 'warning') return sum + 0.7;
    if (a.status === 'running') return sum + (a.progress / 100) * 0.9;
    if (a.status === 'error' || a.status === 'cancelled') return sum + 0.0;
    return sum; // waiting = 0
  }, 0);

  let pct = Math.round((completedWeight / vals.length) * 100);
  if (s.status === 'completed') pct = 100;
  if (s.status === 'failed' && pct === 100) pct = 90;

  $('overallBar').style.width = pct + '%';
  const displayStatus = STATUS[s.status] || s.status;
  $('overallText').textContent = `${pct}% · ${displayStatus}`;

  // 3. Live output panel
  const act = s.agents[s.live.agentId];
  $('liveAgent').textContent = act ? act.name : '—';
  $('liveModel').textContent = s.live.model || '—';
  $('liveStage').textContent = s.live.stage || s.status;
  const live = $('liveOutput');
  const t = s.live.text || (s.status === 'idle' ? 'Waiting for workflow…' : '');
  live.textContent = t.length > 20000 ? '…' + t.slice(-20000) : t;
  if (s.status === 'running') live.scrollTop = live.scrollHeight;

  // 4. Run controls and message
  $('btnStart').disabled = wf.running;
  $('btnStop').disabled = !wf.running;
  $('btnReset').disabled = wf.running;
  const msg = $('runMsg');

  if (wf.running) {
    msg.className = 'hint';
    msg.textContent = `Running: ${act ? act.name : 'processing'}…`;
  } else if (s.status === 'completed') {
    msg.className = 'hint ok';
    msg.textContent = 'Workflow complete. Code review approved; execution NOT verified.';
  } else if (s.status === 'unresolved') {
    msg.className = 'hint err';
    msg.textContent = 'Workflow finished with unresolved blocking/major review issues.';
  } else if (s.status === 'failed') {
    msg.className = 'hint err';
    msg.textContent = 'Workflow failed: ' + (s.error || 'unknown error');
  } else if (s.status === 'cancelled') {
    msg.className = 'hint';
    msg.textContent = 'Workflow cancelled. Completed outputs were preserved.';
  } else {
    msg.className = 'hint';
    msg.textContent = 'Ready.';
  }

  // 5. Authoritative verification status
  const v = computeVerification(s);
  const yn = b => `<span class="${b ? 'yes' : 'no'}">${b ? 'YES' : 'NO'}</span>`;
  const rev = v.static_review;
  const revCls = rev.startsWith('APPROVED') ? 'yes' : rev.startsWith('UNRESOLVED') ? 'bad' : 'no';
  const planValCls = v.plan_deterministic_validation.startsWith('PASSED') ? 'yes' : v.plan_deterministic_validation.startsWith('FAILED') ? 'bad' : 'no';

  $('verification').innerHTML = [
    ['Requirements extracted', yn(v.requirements_extracted)],
    ['CAD plan generated', yn(v.cad_plan_generated)],
    ['Deterministic plan validation', `<span class="${planValCls}">${esc(v.plan_deterministic_validation)}</span>`],
    ['Python source generated', yn(v.python_generated)],
    ['Static code review', `<span class="${revCls}">${esc(rev)}</span>`],
    ['Python execution', '<span class="no">NOT VERIFIED</span>'],
    ['Geometry validity', '<span class="no">NOT VERIFIED</span>'],
    ['STEP export', '<span class="no">NOT VERIFIED</span>'],
    ['STL export', '<span class="no">NOT VERIFIED</span>']
  ]
    .map(([k, val]) => `<div class="vrow"><span>${k}</span><b>${val}</b></div>`)
    .join('');

  renderPane(s);
  renderDownloads(s);
}

// ---------- Formatted deliverables presentation ----------
function paneText(s, tab) {
  const o = s.outputs;
  const j = v => JSON.stringify(v, null, 2);

  switch (tab) {
    case 'requirements': {
      if (!o.requirements) return null;
      const r = o.requirements;
      const lines = [
        '========================================',
        'MECHANICAL DESIGN SPECIFICATION',
        '========================================',
        `Object: ${r.object || '—'}`,
        `Purpose: ${r.mechanical_purpose || '—'}`,
        `Units: ${r.units || 'mm'} | Engine: ${r.cad_engine || 'CadQuery'}`,
        `Materials: ${r.materials || 'Not specified'}`,
        '',
        '--- PARAMETRIC DIMENSIONS ---'
      ];
      (r.dimensions || []).forEach(d => {
        lines.push(`- [${d.id || 'DIM'}] ${d.name}: ${d.value} ${d.unit || 'mm'} (Source: ${d.source || 'explicit'})`);
      });
      lines.push('', '--- EXPLICIT USER REQUIREMENTS ---');
      (r.explicit_requirements || []).forEach(req => {
        const text = typeof req === 'string' ? req : `[${req.id || 'REQ'}] ${req.text}`;
        lines.push(`- ${text}`);
      });
      lines.push('', '--- ASSUMPTIONS & PROVISIONAL VALUES ---');
      if (r.assumptions?.length) {
        r.assumptions.forEach(a => lines.push(`- [${a.id || 'ASM'}] ${a.item}: ${a.proposed_value} (Reason: ${a.reason})`));
      } else lines.push('(None)');
      lines.push('', '--- UNRESOLVED / MISSING INFORMATION ---');
      if (r.missing_information?.length) {
        r.missing_information.forEach(m => {
          const text = typeof m === 'string' ? m : `[${m.id || 'MISS'}] ${m.item} (Impact: ${m.impact})`;
          lines.push(`- ${text}`);
        });
      } else lines.push('(None)');
      lines.push('', '========================================', 'RAW JSON SPECIFICATION:', '========================================', j(r));
      return lines.join('\n');
    }

    case 'plan': {
      if (!o.plan) return null;
      const p = o.plan;
      const pv = o.planValidation;
      const lines = [
        '========================================',
        'GEOMETRIC CAD PLAN & COORDINATES',
        '========================================',
        `Global Coordinate System:`,
        `  Origin: ${JSON.stringify(p.coordinate_system?.origin || [0, 0, 0])}`,
        `  X-Axis: ${p.coordinate_system?.x_axis || '—'}`,
        `  Y-Axis: ${p.coordinate_system?.y_axis || '—'}`,
        `  Z-Axis: ${p.coordinate_system?.z_axis || '—'}`,
        `Expected Bounding Box: X=${p.expected_bounding_box?.x_len || p.expected_bounding_box?.x_mm} mm, Y=${p.expected_bounding_box?.y_len || p.expected_bounding_box?.y_mm} mm, Z=${p.expected_bounding_box?.z_len || p.expected_bounding_box?.z_mm} mm`,
        `Expected Solid Count: ${p.expected_solid_count ?? 1}`,
        '',
        '--- DETERMINISTIC PLAN VALIDATION ---',
        pv ? `Status: ${pv.valid ? 'PASSED (0 blocking errors)' : 'FAILED'}\nSummary: ${pv.summary}` : 'Validation: Pending'
      ];
      if (pv?.errors?.length) {
        lines.push('Blocking Geometric Errors:');
        pv.errors.forEach(err => lines.push(`  ! [${err.id}] ${err.field}: ${err.message}`));
      }
      if (pv?.warnings?.length) {
        lines.push('Warnings:');
        pv.warnings.forEach(w => lines.push(`  * [${w.id}] ${w.field}: ${w.message}`));
      }
      lines.push('', '--- CONSTRUCTION STEPS ---');
      (p.steps || []).forEach(s => {
        lines.push(`Step ${s.id}: ${s.name || s.geometry} on plane ${s.workplane} -> Extrude ${s.extrusion_direction || ''} by ${s.extrusion_distance || s.sketch_dimensions || '—'}`);
      });
      if (p.holes?.length) {
        lines.push('', '--- HOLES & CLEARANCES ---');
        p.holes.forEach(h => {
          lines.push(`- [${h.id || 'HOLE'}] Diam: ${h.diameter} mm, Center: ${JSON.stringify(h.center_xyz)}, Axis: ${h.axis}, Edge Clearance: ${h.edge_clearance_mm ?? '—'} mm (${h.status || 'EXPLICIT'})`);
        });
      }
      if (p.fillets_chamfers?.length) {
        lines.push('', '--- FILLETS & CHAMFERS ---');
        p.fillets_chamfers.forEach(fc => {
          lines.push(`- [${fc.id || 'FC'}] Type: ${fc.type}, Size: ${fc.radius || fc.size} mm, Target: ${fc.target} (${fc.status || 'EXPLICIT'})`);
        });
      }
      lines.push('', '========================================', 'RAW JSON CAD PLAN:', '========================================', j(p));
      return lines.join('\n');
    }

    case 'code':
      return o.code;

    case 'review': {
      if (!o.review) return null;
      const rev = o.review;
      const lines = [
        '========================================',
        'INDEPENDENT CAD CODE REVIEW',
        '========================================',
        `Review Verdict: ${rev.approved ? 'APPROVED (0 blocking, 0 major issues)' : 'UNRESOLVED ISSUES REMAIN'}`,
        `Summary: ${rev.summary || '—'}`,
        `Findings: ${rev.blocking_count || 0} blocking, ${rev.major_count || 0} major, ${rev.minor_count || 0} minor, ${rev.info_count || 0} info`,
        `Discarded False Findings: ${rev.discarded_issues_count || 0}`,
        '',
        '--- VERIFIED FINDINGS ---'
      ];
      if (rev.issues?.length) {
        rev.issues.forEach(i => {
          lines.push(
            `[${i.id || 'ISSUE'}] [${(i.severity || 'minor').toUpperCase()}] (${i.category || 'general'})\n  Evidence: ${i.evidence}\n  Explanation: ${i.explanation}\n  Fix: ${i.suggested_correction}\n`
          );
        });
      } else {
        lines.push('No issues detected! Clean CadQuery code.');
      }
      if (rev.discarded_issues?.length) {
        lines.push('--- DISCARDED HALLUCINATIONS / FALSE FINDINGS ---');
        rev.discarded_issues.forEach(d => {
          lines.push(`- [${d.id || 'DISCARD'}] Evidence "${d.evidence}": ${d.discard_reason}`);
        });
      }
      lines.push('', '========================================', 'RAW JSON REVIEW:', '========================================', j(rev));
      return lines.join('\n');
    }

    case 'repair': {
      if (!o.repairHistory || !o.repairHistory.length) {
        return o.review ? 'No repair attempts were needed or executed (code approved on initial review).' : null;
      }
      const lines = [
        '========================================',
        'REPAIR & STAGNATION ANALYSIS LOG',
        '========================================',
        `Total Repair Attempts: ${o.repairHistory.length}`,
        ''
      ];
      o.repairHistory.forEach(h => {
        lines.push(`--- ATTEMPT ${h.attempt} ---`);
        lines.push(`Code Hash: ${h.hash_before} -> ${h.hash_after} (Identical: ${h.is_identical ? 'YES' : 'NO'})`);
        lines.push(`Meaningful Code Change: ${h.meaningful_change ? 'YES' : 'NO'}`);
        lines.push(`Outcome: ${h.outcome}`);
        if (h.stop_reason) lines.push(`Stop Reason: ${h.stop_reason}`);
        if (h.resolved_count !== undefined) {
          lines.push(`Issues Progress: ${h.resolved_count} resolved, ${h.unresolved_count} unresolved, ${h.new_issues_count} new`);
        }
        if (h.error) lines.push(`Error: ${h.error}`);
        lines.push('');
      });
      lines.push('========================================', 'RAW JSON REPAIR HISTORY:', '========================================', j(o.repairHistory));
      return lines.join('\n');
    }

    case 'report':
      return o.report;
  }
}

function renderPane(s) {
  $('pane').textContent = paneText(s, activeTab) || 'Not generated yet.';
}

let dlKey = '';
function renderDownloads(s) {
  const key = DELIVERABLES.map(d => (isAvailable(d, s) ? 1 : 0)).join('') + s.status;
  if (key === dlKey) return;
  dlKey = key;
  const box = $('downloads');
  box.innerHTML = '';
  for (const d of DELIVERABLES) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = '⬇ ' + d.label;
    b.disabled = !isAvailable(d, s);
    b.addEventListener('click', () => downloadDeliverable(d.key, wf.state));
    box.appendChild(b);
  }
}

// ---------- UI Event Handlers ----------
$('tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  activeTab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  renderPane(wf.state);
});

for (const [id, key] of SELECTS) {
  $(id).addEventListener('change', () => {
    readConfig();
    saveConfig(cfg);
    updateModelChip();
  });
}

['cfgUrl', 'cfgRepairs', 'cfgTemp', 'cfgTokens', 'cfgJsonTokens', 'cfgCtx', 'cfgIdle'].forEach(id => {
  $(id).addEventListener('change', () => {
    readConfig();
    saveConfig(cfg);
  });
});

$('cfgUrl').addEventListener('change', testConnection);
$('btnTest').addEventListener('click', testConnection);
$('btnRefresh').addEventListener('click', testConnection);
$('btnExample').addEventListener('click', () => {
  $('prompt').value = EXAMPLE_PROMPT;
});
$('btnStop').addEventListener('click', () => wf.stop());
$('btnReset').addEventListener('click', () => {
  if (wf.reset()) {
    dlKey = '';
    $('runMsg').className = 'hint';
    $('runMsg').textContent = 'Ready.';
  }
});

$('btnStart').addEventListener('click', async () => {
  if (wf.running) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) {
    $('runMsg').className = 'hint err';
    $('runMsg').textContent = 'Enter a design requirement first.';
    return;
  }
  readConfig();
  saveConfig(cfg);
  dlKey = '';
  try {
    await wf.run(prompt, cfg);
  } catch (e) {
    console.error(e);
  }
  schedule();
});

wf.subscribe(schedule);
fillForm();
render(wf.state);
testConnection();
