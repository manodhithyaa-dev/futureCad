# FutureCAD — browser-based multi-agent AI CAD platform

Static HTML/CSS/vanilla-JS app. Six Ollama agents turn a natural-language mechanical design into reviewed, repairable, parametric **CadQuery Python source**. No backend, no build step, no packages.

## Run
```bash
cd FutureCAD
python3 -m http.server 8000      # serves static files only
# open http://localhost:8000
```

## Ollama setup (CORS)
The page (`http://localhost:8000`) calls Ollama (`http://localhost:11434`) directly. Ollama normally allows `localhost` origins; if you serve from another host/IP or see "unreachable", set `OLLAMA_ORIGINS` and restart Ollama:

| OS | Command |
|---|---|
| Linux (systemd) | `sudo systemctl edit ollama` → add `Environment="OLLAMA_ORIGINS=http://localhost:8000,http://127.0.0.1:8000"` → `sudo systemctl restart ollama` |
| macOS | `launchctl setenv OLLAMA_ORIGINS "http://localhost:8000,http://127.0.0.1:8000"` then restart the Ollama app |
| Windows | Set user env var `OLLAMA_ORIGINS`, then restart Ollama |
| Manual | `OLLAMA_ORIGINS="http://localhost:8000" ollama serve` |

Required models (defaults, changeable in the UI): `gemma4:e4b`, `hf.co/mradermacher/FutureCAD-7B-GGUF:Q4_K_M`, `qwen2.5-coder:7b`. A preflight check fails fast with the exact `ollama pull` command if one is missing.

## Workflow
Preflight → Requirement Analyst (JSON) → CAD Planner (JSON) → CAD Generator (Python) → Reviewer → [Repair → Reviewer] ×max 3 → Final Reporter. Strictly sequential; one workflow at a time; Stop aborts the in-flight request (AbortController). Completed outputs survive later failures, and the report is still produced when review issues remain.

## Repetition / truncation controls (CAD generation)
`temperature 0.1`, `top_p 0.9`, `top_k 40`, `repeat_penalty 1.18`, `repeat_last_n 256`, `num_predict 3000` (configurable), `num_ctx 8192` (configurable; Ollama's 4096 default would silently truncate prompts). The stream is consumed until the **first complete program**, then the connection is cancelled; anything after (a second fence, a repeated `import cadquery as cq`) is discarded and never concatenated. Incomplete code (unbalanced brackets, cut-off last line, missing import) is never sent to the reviewer; the generator is re-asked up to 3 times with a targeted "compact, single program" prompt. JSON agents use Ollama JSON mode, schema validation and a corrective re-ask; Python and JSON use different parsers.
Repair uses a milder penalty (1.08) and JSON/report agents 1.05, because heavy penalties damage code/JSON that legitimately repeats tokens.

## Honesty about verification
The browser cannot run CadQuery. Reviewer approval means *static + LLM review only*. The UI, report and bundle always show Python execution, geometry validity and STEP/STL export as **NOT VERIFIED**. Deterministic static checks (invalid methods such as `extrude_bidir`, missing imports/exports, unbalanced syntax, repeated programs) are real; reviewer issues whose quoted evidence is not found in the code are discarded as invented.

To get geometry: `pip install cadquery`, run `generated_cad.py` locally, inspect the STEP/STL.

## Future OpenCascade.js hook
`computeVerification()` in `js/workflow.js` is the single place where verification flags are derived. A future `js/geometry.js` (OpenCascade.js, WASM) can run a translated construction, then set `python_execution`/`geometry_validity`/`step_export`/`stl_export` from real results. Nothing is faked today.

## Layout
`index.html`, `css/style.css`, `js/{app,config,ollama,agents,prompts,workflow,validators,downloads}.js`
