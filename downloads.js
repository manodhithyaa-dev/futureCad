// downloads.js — deliverable serialisation and browser downloads.
import { computeVerification } from './workflow.js';

const json = v => JSON.stringify(v, null, 2);

export const DELIVERABLES = [
  {
    key: 'requirements',
    file: 'requirements.json',
    label: 'requirements.json',
    mime: 'application/json',
    get: s => s.outputs.requirements && json(s.outputs.requirements)
  },
  {
    key: 'plan',
    file: 'cad_plan.json',
    label: 'cad_plan.json',
    mime: 'application/json',
    get: s => s.outputs.plan && json(s.outputs.plan)
  },
  {
    key: 'plan_validation',
    file: 'plan_validation.json',
    label: 'plan_validation.json',
    mime: 'application/json',
    get: s => s.outputs.planValidation && json(s.outputs.planValidation)
  },
  {
    key: 'code',
    file: 'generated_cad.py',
    label: 'generated_cad.py',
    mime: 'text/x-python',
    get: s => s.outputs.code
  },
  {
    key: 'review',
    file: 'code_review.json',
    label: 'code_review.json',
    mime: 'application/json',
    get: s => s.outputs.review && json(s.outputs.review)
  },
  {
    key: 'repair',
    file: 'repair_history.json',
    label: 'repair_history.json',
    mime: 'application/json',
    get: s => s.outputs.repairHistory?.length ? json(s.outputs.repairHistory) : null
  },
  {
    key: 'report',
    file: 'final_report.txt',
    label: 'final_report.txt',
    mime: 'text/plain',
    get: s => s.outputs.report
  },
  {
    key: 'bundle',
    file: 'futurecad_bundle.json',
    label: 'Complete bundle (JSON)',
    mime: 'application/json',
    get: s =>
      s.outputs.requirements || s.outputs.code
        ? json({
            generated_by: 'FutureCAD',
            version: '2.0.0',
            exported_at: new Date().toISOString(),
            status: s.status,
            prompt: s.prompt,
            config: s.config,
            verification: computeVerification(s),
            outputs: s.outputs,
            agents: s.agents,
            log: s.log
          })
        : null
  }
];

export function downloadText(filename, content, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export const isAvailable = (d, state) => !!d.get(state);

export function downloadDeliverable(key, state) {
  const d = DELIVERABLES.find(x => x.key === key);
  const content = d && d.get(state);
  if (!content) return false;
  downloadText(d.file, content, d.mime);
  return true;
}
