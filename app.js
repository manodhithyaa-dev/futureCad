// app.js — UI wiring. All event handlers are attached here (no inline handlers).
import { AGENTS, DEFAULT_CONFIG, EXAMPLE_PROMPT, loadConfig, saveConfig } from './config.js';
import { listModels, modelInstalled } from './ollama.js';
import { Workflow, computeVerification } from './workflow.js';
import { DELIVERABLES, downloadDeliverable, isAvailable } from './downloads.js';

const $ = id => document.getElementById(id);
const wf = new Workflow();
let cfg = loadConfig();
let installed = null;           // null = unknown
let activeTab = 'requirements';
let connAbort = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = { waiting: 'Waiting', running: 'Running', done: 'Done', error: 'Failed', warning: 'Issues remain', skipped: 'Skipped', cancelled: 'Cancelled' };
const SELECTS = [['cfgAnalyst', 'analystModel'], ['cfgCad', 'cadModel'], ['cfgGen', 'generatorModel'], ['cfgReviewer', 'reviewerModel']];

// ---------- config form ----------
function readConfig() {
  const num = (id, min, max, def) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def; };
  cfg = {
    ...cfg,
    ollamaUrl: $('cfgUrl').value.trim().replace(/\/+$/, '') || DEFAULT_CONFIG.ollamaUrl,
    analystModel: $('cfgAnalyst').value || DEFAULT_CONFIG.analystModel,
    cadModel: $('cfgCad').value || DEFAULT_CONFIG.cadModel,
    generatorModel: $('cfgGen').value,
    reviewerModel: $('cfgReviewer').value || DEFAULT_CONFIG.reviewerModel,
    maxRepairs: Math.round(num('cfgRepairs', 0, 3, 3)),
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
    const el = $(id), cur = cfg[key];
    const names = [...new Set([...(installed || []), cur])].filter(Boolean);
    el.innerHTML = (id === 'cfgGen' ? `<option value=""${cur ? '' : ' selected'}>Same as CAD model</option>` : '') + names.map(n => {
      const missing = installed && !modelInstalled(installed, n);
      return `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}${missing ? '  (not installed)' : ''}</option>`;
    }).join('');
  }
}
function fillForm() {
  $('cfgUrl').value = cfg.ollamaUrl; $('cfgRepairs').value = cfg.maxRepairs; $('cfgTemp').value = cfg.temperature;
  $('cfgTokens').value = cfg.cadTokenLimit; $('cfgJsonTokens').value = cfg.jsonTokenLimit;
  $('cfgCtx').value = cfg.numCtx; $('cfgIdle').value = cfg.idleTimeoutSec; fillSelects();
}
function updateModelChip() {
  const chip = $('modelChip');
  if (!installed) { chip.textContent = 'Models: unknown'; return; }
  const need = [...new Set([cfg.analystModel, cfg.cadModel, cfg.generatorModel || cfg.cadModel, cfg.reviewerModel])];
  const miss = need.filter(m => !modelInstalled(installed, m));
  chip.textContent = miss.length ? `Missing: ${miss.join(', ')}` : `Models: ${need.length}/${need.length} installed`;
  chip.style.color = miss.length ? 'var(--err)' : 'var(--ok)';
}
async function testConnection() {
  readConfig(); saveConfig(cfg);
  connAbort?.abort(); connAbort = new AbortController();
  $('connText').textContent = 'Ollama: testing…';
  try {
    installed = await listModels(cfg.ollamaUrl, connAbort.signal);
    $('connDot').className = 'dot ok'; $('connText').textContent = `Ollama: connected (${installed.length} models)`;
    $('cfgMsg').className = 'hint ok'; $('cfgMsg').textContent = 'Connection OK.';
  } catch (e) {
    if (e.name === 'AbortError') return;
    installed = null; $('connDot').className = 'dot err'; $('connText').textContent = 'Ollama: unreachable';
    $('cfgMsg').className = 'hint err'; $('cfgMsg').textContent = e.message;
  }
  fillSelects(); updateModelChip();
}

// ---------- rendering ----------
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(wf.state); }); };

function render(s) {
  // pipeline
  $('pipeline').innerHTML = AGENTS.map((a, i) => {
    const ag = s.agents[a.id], model = ag.model || cfg[a.modelKey];
    return `<div class="agent ${ag.status}"><div class="agent-top"><span>${String(i + 1).padStart(2, '0')}</span><span class="badge">${STATUS[ag.status]}</span></div>
      <h4>${esc(a.name)}</h4><div class="model">${esc(model)}</div>
      <div class="bar"><i style="width:${ag.status === 'waiting' ? 0 : ag.progress}%"></i></div>
      <div class="detail">${esc(ag.error || ag.detail || '')}</div></div>`;
  }).join('');
  const vals = Object.values(s.agents);
  const pct = Math.round(vals.reduce((t, a) => t + (a.status === 'done' || a.status === 'warning' || a.status === 'skipped' ? 1 : a.status === 'error' ? 1 : a.status === 'running' ? a.progress / 100 : 0), 0) / vals.length * 100);
  $('overallBar').style.width = pct + '%'; $('overallText').textContent = `${pct}% · ${s.status}`;

  // live output
  const act = s.agents[s.live.agentId];
  $('liveAgent').textContent = act ? act.name : '—'; $('liveModel').textContent = s.live.model || '—'; $('liveStage').textContent = s.live.stage || s.status;
  const live = $('liveOutput'), t = s.live.text || (s.status === 'idle' ? 'Waiting for workflow…' : '');
  live.textContent = t.length > 20000 ? '…' + t.slice(-20000) : t;
  if (s.status === 'running') live.scrollTop = live.scrollHeight;

  // run controls
  $('btnStart').disabled = wf.running; $('btnStop').disabled = !wf.running; $('btnReset').disabled = wf.running;
  const msg = $('runMsg');
  if (wf.running) { msg.className = 'hint'; msg.textContent = `Running: ${act ? act.name : 'starting'}…`; }
  else if (s.status === 'completed') { msg.className = 'hint ok'; msg.textContent = s.outputs.review?.approved ? 'Workflow complete. Code review approved; execution NOT verified.' : 'Workflow complete with unresolved review issues.'; }
  else if (s.status === 'failed') { msg.className = 'hint err'; msg.textContent = 'Workflow failed: ' + (s.error || 'unknown error'); }
  else if (s.status === 'cancelled') { msg.className = 'hint'; msg.textContent = 'Workflow cancelled. Completed outputs were preserved.'; }

  // verification
  const v = computeVerification(s), yn = b => `<span class="${b ? 'yes' : 'no'}">${b ? 'YES' : 'NO'}</span>`;
  const rev = v.static_review, revCls = rev.startsWith('APPROVED') ? 'yes' : rev.startsWith('BLOCKING') ? 'bad' : 'no';
  $('verification').innerHTML = [
    ['Requirements extracted', yn(v.requirements_extracted)], ['CAD plan generated', yn(v.cad_plan_generated)],
    ['Python source generated', yn(v.python_generated)], ['Static code review', `<span class="${revCls}">${esc(rev)}</span>`],
    ['Python execution', '<span class="no">NOT VERIFIED</span>'], ['Geometry validity', '<span class="no">NOT VERIFIED</span>'],
    ['STEP export', '<span class="no">NOT VERIFIED</span>'], ['STL export', '<span class="no">NOT VERIFIED</span>']
  ].map(([k, val]) => `<div class="vrow"><span>${k}</span><b>${val}</b></div>`).join('');

  renderPane(s); renderDownloads(s);
}

function paneText(s, tab) {
  const o = s.outputs, j = v => JSON.stringify(v, null, 2);
  switch (tab) {
    case 'requirements': return o.requirements && j(o.requirements);
    case 'plan': return o.plan && j(o.plan);
    case 'code': return o.code;
    case 'review': return o.review && j(o.review);
    case 'repair': return o.repairHistory.length ? j(o.repairHistory) : (o.review ? 'No repair attempts were needed or made.' : null);
    case 'report': return o.report;
  }
}
function renderPane(s) { $('pane').textContent = paneText(s, activeTab) || 'Not generated yet.'; }

let dlKey = '';
function renderDownloads(s) {
  const key = DELIVERABLES.map(d => (isAvailable(d, s) ? 1 : 0)).join('') + s.status;
  if (key === dlKey) return; dlKey = key;
  const box = $('downloads'); box.innerHTML = '';
  for (const d of DELIVERABLES) {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = '⬇ ' + d.label; b.disabled = !isAvailable(d, s);
    b.addEventListener('click', () => downloadDeliverable(d.key, wf.state));
    box.appendChild(b);
  }
}

// ---------- events ----------
$('tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  activeTab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  renderPane(wf.state);
});
for (const [id, key] of SELECTS) $(id).addEventListener('change', () => { readConfig(); saveConfig(cfg); updateModelChip(); });
['cfgUrl', 'cfgRepairs', 'cfgTemp', 'cfgTokens', 'cfgJsonTokens', 'cfgCtx', 'cfgIdle'].forEach(id => $(id).addEventListener('change', () => { readConfig(); saveConfig(cfg); }));
$('cfgUrl').addEventListener('change', testConnection);
$('btnTest').addEventListener('click', testConnection);
$('btnRefresh').addEventListener('click', testConnection);
$('btnExample').addEventListener('click', () => { $('prompt').value = EXAMPLE_PROMPT; });
$('btnStop').addEventListener('click', () => wf.stop());
$('btnReset').addEventListener('click', () => { if (wf.reset()) { dlKey = ''; $('runMsg').className = 'hint'; $('runMsg').textContent = 'Ready.'; } });
$('btnStart').addEventListener('click', async () => {
  if (wf.running) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) { $('runMsg').className = 'hint err'; $('runMsg').textContent = 'Enter a design requirement first.'; return; }
  readConfig(); saveConfig(cfg); dlKey = '';
  try { await wf.run(prompt, cfg); } catch (e) { console.error(e); }
  schedule();
});

wf.subscribe(schedule);
fillForm(); render(wf.state); testConnection();
