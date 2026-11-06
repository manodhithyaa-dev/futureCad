// config.js — defaults, agent registry, persisted settings.
export const STORAGE_KEY = 'futurecad.config.v1';

export const DEFAULT_CONFIG = {
  ollamaUrl: 'http://localhost:11434',
  analystModel: 'gemma4:e4b',
  cadModel: 'hf.co/mradermacher/FutureCAD-7B-GGUF:Q4_K_M',
  reviewerModel: 'qwen2.5-coder:7b',
  generatorModel: '',      // '' = same as CAD model
  maxRepairs: 3,
  cadTokenLimit: 3000,     // num_predict for CAD generation / repair
  jsonTokenLimit: 3072,    // num_predict for JSON agents
  reportTokenLimit: 2500,  // num_predict for the final report
  temperature: 0.1,
  numCtx: 8192,            // Ollama's default (4096) silently truncates long prompts
  idleTimeoutSec: 180      // abort if the stream goes silent this long
};

// Code generation uses the strong repetition penalty required for FutureCAD-7B;
// JSON/report agents use a mild one so keys/words can legitimately repeat.
export const SAMPLING = {
  generator: { top_p: 0.9, top_k: 40, repeat_penalty: 1.18, repeat_last_n: 256 },
  repair:    { top_p: 0.9, top_k: 40, repeat_penalty: 1.08, repeat_last_n: 256 },
  json:      { top_p: 0.9, top_k: 40, repeat_penalty: 1.05, repeat_last_n: 128 },
  text:      { top_p: 0.9, top_k: 40, repeat_penalty: 1.05, repeat_last_n: 128 }
};

export const AGENTS = [
  { id: 'analyst',   name: 'Requirement Analyst',       modelKey: 'analystModel' },
  { id: 'planner',   name: 'CAD Planner',               modelKey: 'cadModel' },
  { id: 'generator', name: 'CAD Generator',             modelKey: 'generatorModel' },
  { id: 'reviewer',  name: 'Independent Code Reviewer', modelKey: 'reviewerModel' },
  { id: 'repair',    name: 'Code Repair Engineer',      modelKey: 'reviewerModel' },
  { id: 'reporter',  name: 'Final Reporter',            modelKey: 'analystModel' }
];

export const EXAMPLE_PROMPT =
`Create an L-shaped wall mounting bracket.
Dimensions: vertical height 80 mm, horizontal projection 50 mm, width 40 mm, thickness 4 mm.
Features: two mounting holes, diameter 5 mm, equally spaced; rounded internal corner; rounded external edges.
CAD engine: CadQuery. Exports: STEP and STL.`;

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return { ...DEFAULT_CONFIG, ...(raw ? JSON.parse(raw) : {}) };
  } catch { return { ...DEFAULT_CONFIG }; }
}
export function saveConfig(cfg) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* storage unavailable */ }
}
