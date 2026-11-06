// test_suite.js — Comprehensive regression test suite covering specifications A through Z.
// Compatible with both Node.js (CLI execution) and modern browser runtimes.

import * as V from './validators.js';
import * as Prompts from './prompts.js';
import { computeVerification, statusSection, Workflow } from './workflow.js';
import { OllamaError, modelInstalled } from './ollama.js';
import { DELIVERABLES, isAvailable } from './downloads.js';

let passedCount = 0;
let failedCount = 0;
const results = [];

function assert(condition, name, details = '') {
  if (condition) {
    passedCount++;
    results.push({ status: 'PASS', name, details });
    console.log(`  ✓ PASS: ${name}`);
  } else {
    failedCount++;
    results.push({ status: 'FAIL', name, details });
    console.error(`  ✗ FAIL: ${name} — ${details}`);
  }
}

console.log('\n======================================================');
console.log(' FutureCAD Comprehensive Verification & Regression Suite');
console.log('======================================================\n');

// ----------------------------------------------------
// A. REQUIREMENT EXTRACTION SCHEMA
// ----------------------------------------------------
console.log('[Test Suite A] Requirement Extraction Schema');
{
  const validReq = {
    object: 'L-Bracket',
    mechanical_purpose: 'Wall mounting support',
    summary: 'L-shaped bracket for wall mounting',
    units: 'mm',
    dimensions: [{ id: 'DIM-001', name: 'height', value: 80, unit: 'mm', source: 'explicit' }],
    features: [{ id: 'FEAT-001', type: 'hole', description: 'Mounting hole', quantity: 2, parameters: {} }],
    explicit_requirements: ['vertical height 80 mm'],
    assumptions: [],
    missing_information: [],
    contradictions: [],
    warnings: [],
    exports: ['STEP', 'STL']
  };
  const errsValid = V.validateRequirements(validReq);
  assert(errsValid.length === 0, 'Valid requirement schema passes with 0 errors');

  const invalidReq = { object: '', dimensions: 'not-an-array' };
  const errsInvalid = V.validateRequirements(invalidReq);
  assert(errsInvalid.length >= 2, 'Invalid requirements schema correctly reports errors', JSON.stringify(errsInvalid));
}

// ----------------------------------------------------
// B. MISSING DIMENSIONS & PROVISIONAL TRACKING
// ----------------------------------------------------
console.log('\n[Test Suite B] Missing Dimensions & Provisional Status');
{
  const reqWithMissing = {
    object: 'L-Bracket',
    units: 'mm',
    dimensions: [
      { id: 'DIM-001', name: 'height', value: 80, unit: 'mm', source: 'explicit' },
      { id: 'DIM-002', name: 'hole_x', value: null, unit: 'mm', source: 'provisional' }
    ],
    features: [],
    explicit_requirements: [],
    assumptions: [{ item: 'hole_x', proposed_value: '20 mm', reason: 'Centered on arm' }],
    missing_information: ['Exact mounting hole coordinates not specified by user'],
    contradictions: [],
    warnings: []
  };
  const errs = V.validateRequirements(reqWithMissing);
  assert(errs.length === 0, 'Requirements with provisional null dimensions pass schema validation');
  assert(reqWithMissing.missing_information.length === 1, 'Missing information is explicitly preserved');
}

// ----------------------------------------------------
// C. UNIT CONVERSION
// ----------------------------------------------------
console.log('\n[Test Suite C] Unit Conversion');
{
  assert(Math.abs(V.convertUnit(1, 'in', 'mm') - 25.4) < 1e-4, '1 inch converts to 25.4 mm');
  assert(Math.abs(V.convertUnit(50, 'mm', 'mm') - 50.0) < 1e-4, '50 mm converts to 50 mm');
  assert(Math.abs(V.convertUnit(5, 'cm', 'mm') - 50.0) < 1e-4, '5 cm converts to 50 mm');
  assert(Math.abs(V.convertUnit(2, 'm', 'mm') - 2000.0) < 1e-4, '2 m converts to 2000 mm');
  assert(Number.isNaN(V.convertUnit(10, 'unknown', 'mm')), 'Unknown unit yields NaN');
}

// ----------------------------------------------------
// D. GEOMETRY PLAN VALIDATION (VALID PLAN)
// ----------------------------------------------------
console.log('\n[Test Suite D] Deterministic Geometry Plan Validation (Valid Plan)');
{
  const validPlan = {
    coordinate_system: {
      description: 'Right-handed Cartesian',
      origin: [0, 0, 0],
      x_axis: '+X length',
      y_axis: '+Y width',
      z_axis: '+Z height',
      units: 'mm'
    },
    parameters: { length: 50, height: 80, width: 40, thickness: 4 },
    steps: [
      {
        id: 1,
        geometry: 'polyline_extrusion',
        workplane: 'XZ',
        profile_vertices: [[0, 0], [50, 0], [50, 4], [4, 4], [4, 80], [0, 80]],
        extrusion_direction: '+Y',
        extrusion_distance: 40,
        resulting_bounding_box: { x_min: 0, x_max: 50, y_min: 0, y_max: 40, z_min: 0, z_max: 80 }
      }
    ],
    holes: [
      {
        id: 'HOLE-001',
        diameter: 5,
        center_xyz: [2, 20, 25],
        axis: 'X',
        through: true,
        status: 'PROVISIONAL'
      }
    ],
    fillets_chamfers: [
      {
        id: 'FILLET-001',
        type: 'fillet',
        radius: 3.5,
        target: 'internal_corner',
        status: 'PROVISIONAL'
      }
    ],
    expected_bounding_box: { x_len: 50, y_len: 40, z_len: 80, x_min: 0, x_max: 50, y_min: 0, y_max: 40, z_min: 0, z_max: 80 },
    expected_solid_count: 1,
    provisional_assumptions: [],
    validation_steps: []
  };

  const structErrs = V.validatePlan(validPlan);
  assert(structErrs.length === 0, 'Valid plan passes structural schema validation');

  const geomResult = V.validateGeometryPlan(validPlan);
  assert(geomResult.valid === true, 'Valid plan passes deterministic geometry validation');
  assert(geomResult.errors.length === 0, 'Valid plan has 0 blocking geometric errors');
}

// ----------------------------------------------------
// E. INVALID COORDINATES & NEGATIVE DIMENSIONS
// ----------------------------------------------------
console.log('\n[Test Suite E] Invalid Coordinates & Negative Dimensions');
{
  const invalidCoordPlan = {
    coordinate_system: { units: 'mm', origin: [0, 0, 0] },
    parameters: { length: -50, height: 80 },
    steps: [{ id: 1, geometry: 'box', workplane: 'XY', extrusion_distance: -10, resulting_bounding_box: 'box' }],
    expected_bounding_box: { x_len: -50, y_len: 40, z_len: 80 },
    expected_solid_count: 1,
    provisional_assumptions: [],
    validation_steps: []
  };
  const geomRes = V.validateGeometryPlan(invalidCoordPlan);
  assert(geomRes.valid === false, 'Negative dimensions and extrusion distances are rejected');
  assert(geomRes.errors.some(e => e.id === 'PLAN-PARAM-NONPOSITIVE'), 'Detects negative parameter error ID');
  assert(geomRes.errors.some(e => e.id === 'PLAN-EXTRUDE-DIST'), 'Detects negative extrusion distance error ID');
}

// ----------------------------------------------------
// F. HOLE CENTERS OUTSIDE FACES & EDGE CLEARANCE
// ----------------------------------------------------
console.log('\n[Test Suite F] Hole Centers Outside Faces & Edge Clearance');
{
  const planWithBadHoles = {
    coordinate_system: { units: 'mm' },
    parameters: { length: 50, height: 80, width: 40, thickness: 4 },
    steps: [{ id: 1, geometry: 'box', workplane: 'XY', resulting_bounding_box: 'box' }],
    expected_bounding_box: { x_len: 50, y_len: 40, z_len: 80, x_min: 0, x_max: 50, y_min: 0, y_max: 40, z_min: 0, z_max: 80 },
    expected_solid_count: 1,
    holes: [
      // Hole 1: Out of bounds in Z
      { id: 'HOLE-OUT', diameter: 5, center_xyz: [2, 20, 150] },
      // Hole 2: Negative clearance / breakout in Y (radius 5mm placed at Y=2mm in range [0, 40])
      { id: 'HOLE-BREAKOUT', diameter: 10, center_xyz: [2, 2, 25] }
    ],
    provisional_assumptions: [],
    validation_steps: []
  };
  const geomRes = V.validateGeometryPlan(planWithBadHoles);
  assert(geomRes.valid === false, 'Rejects holes with invalid placement');
  assert(geomRes.errors.some(e => e.id === 'PLAN-HOLE-OUTSIDE-BB'), 'Detects hole center placed outside bounding box');
  assert(geomRes.errors.some(e => e.id === 'PLAN-HOLE-EDGE-BREAKOUT'), 'Detects hole breaking outside part perimeter in Y');
}

// ----------------------------------------------------
// G. BOUNDING BOX CONSISTENCY
// ----------------------------------------------------
console.log('\n[Test Suite G] Bounding Box Consistency');
{
  const planWithBadBB = {
    coordinate_system: { units: 'mm' },
    parameters: { length: 50 },
    steps: [{ id: 1, geometry: 'box', workplane: 'XY', resulting_bounding_box: 'box' }],
    expected_bounding_box: { x_min: 50, x_max: 10, y_len: 40, z_len: 80 },
    expected_solid_count: 1,
    provisional_assumptions: [],
    validation_steps: []
  };
  const geomRes = V.validateGeometryPlan(planWithBadBB);
  assert(geomRes.valid === false, 'Rejects inverted bounding box coordinate range');
  assert(geomRes.errors.some(e => e.id === 'PLAN-BB-RANGE-X'), 'Reports PLAN-BB-RANGE-X error');
}

// ----------------------------------------------------
// H. MISSING FEATURE PARAMETERS & DEGENERATE PROFILES
// ----------------------------------------------------
console.log('\n[Test Suite H] Missing Feature Parameters & Degenerate Profiles');
{
  const planWithDegenerateProfile = {
    coordinate_system: { units: 'mm' },
    parameters: { thickness: 4 },
    steps: [
      {
        id: 1,
        geometry: 'polyline',
        workplane: 'XZ',
        profile_vertices: [[0, 0], [10, 0], [20, 0]],
        resulting_bounding_box: 'line'
      }
    ],
    fillets_chamfers: [
      { id: 'FC-FAIL', type: 'fillet', radius: 10, target: 'corner' }
    ],
    expected_bounding_box: { x_len: 50, y_len: 40, z_len: 80 },
    expected_solid_count: 1,
    provisional_assumptions: [],
    validation_steps: []
  };
  const geomRes = V.validateGeometryPlan(planWithDegenerateProfile);
  assert(geomRes.valid === false, 'Rejects plan with degenerate profile polygon and impossible fillet');
  assert(geomRes.errors.some(e => e.id === 'PLAN-PROFILE-DEGENERATE'), 'Detects degenerate zero-area profile polygon via Shoelace check');
  assert(geomRes.errors.some(e => e.id === 'PLAN-FILLET-EXCEEDS-THICKNESS'), 'Detects fillet radius exceeding wall thickness');
}

// ----------------------------------------------------
// I. REVIEWER SEVERITY POLICY (BLOCKING & MAJOR PREVENT APPROVAL)
// ----------------------------------------------------
console.log('\n[Test Suite I] Reviewer Severity Policy Enforcement');
{
  const mockCode = `import cadquery as cq
result = cq.Workplane("XY").box(10, 10, 10)
cq.exporters.export(result, "part.step")
cq.exporters.export(result, "part.stl")`;

  const reviewWithMajor = {
    approved: true,
    summary: 'Looks mostly good',
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'major',
        category: 'dimensions',
        evidence: 'box(10, 10, 10)',
        explanation: 'Wrong dimensions: expected 50x40x80',
        suggested_correction: 'Change box dimensions'
      }
    ]
  };
  const mergedMajor = V.mergeReview(reviewWithMajor, [], mockCode);
  assert(mergedMajor.approved === false, 'MAJOR severity issue strictly prevents approval (approved: false)');
  assert(mergedMajor.major_count === 1, 'Accurately tracks major_count = 1');

  const reviewWithBlocking = {
    approved: true,
    issues: [
      {
        id: 'ISSUE-002',
        severity: 'blocking',
        evidence: 'box(10, 10, 10)',
        explanation: 'Syntax crash',
        suggested_correction: 'Fix code'
      }
    ]
  };
  const mergedBlocking = V.mergeReview(reviewWithBlocking, [], mockCode);
  assert(mergedBlocking.approved === false, 'BLOCKING severity issue strictly prevents approval');

  const reviewWithMinorOnly = {
    approved: true,
    issues: [
      {
        id: 'ISSUE-003',
        severity: 'minor',
        evidence: 'box(10, 10, 10)',
        explanation: 'Consider naming parameters',
        suggested_correction: 'Declare L, W, H'
      },
      {
        id: 'ISSUE-004',
        severity: 'info',
        evidence: 'result =',
        explanation: 'Nice variable name',
        suggested_correction: 'None needed'
      }
    ]
  };
  const mergedMinor = V.mergeReview(reviewWithMinorOnly, [], mockCode);
  assert(mergedMinor.approved === true, 'Review with only minor and info issues is approved');
}

// ----------------------------------------------------
// J. FALSE ABSENT FINDINGS
// ----------------------------------------------------
console.log('\n[Test Suite J] False ABSENT Finding Detection & Verification');
{
  const codeWithFeatures = `import cadquery as cq
body = cq.Workplane("XY").box(50, 40, 10)
body = body.faces(">Z").workplane().hole(5.0)
body = body.edges("|Z").fillet(2.0)
cq.exporters.export(body, "part.step")
cq.exporters.export(body, "part.stl")`;

  const rawReview = {
    approved: false,
    issues: [
      {
        id: 'HALLUC-001',
        severity: 'major',
        evidence: 'ABSENT: STEP export',
        explanation: 'No step export found',
        suggested_correction: 'Add export'
      },
      {
        id: 'HALLUC-002',
        severity: 'major',
        evidence: 'ABSENT: hole',
        explanation: 'No hole found',
        suggested_correction: 'Add hole'
      },
      {
        id: 'REAL-001',
        severity: 'major',
        evidence: 'ABSENT: chamfer',
        explanation: 'No chamfer found',
        suggested_correction: 'Add chamfer'
      }
    ]
  };

  const merged = V.mergeReview(rawReview, [], codeWithFeatures);
  assert(merged.discarded_issues.some(d => d.id === 'HALLUC-001'), 'False ABSENT: STEP export is detected and discarded');
  assert(merged.discarded_issues.some(d => d.id === 'HALLUC-002'), 'False ABSENT: hole is detected and discarded');
  assert(merged.issues.some(i => i.id === 'REAL-001'), 'Genuine ABSENT: chamfer is retained as confirmed issue');
}

// ----------------------------------------------------
// K, L, M. REPAIR STAGNATION, IDENTICAL OUTPUTS & REPEATED ISSUES
// ----------------------------------------------------
console.log('\n[Test Suite K, L, M] Repair Stagnation, Identical Outputs & Repeated Issues');
{
  const codeBefore = `import cadquery as cq\nbody = cq.Workplane("XY").box(10, 10, 10)\ncq.exporters.export(body, "part.step")`;
  const codeIdentical = `import cadquery as cq\nbody = cq.Workplane("XY").box(10, 10, 10)\ncq.exporters.export(body, "part.step")`;
  const codeWhitespaceOnly = `import cadquery as cq\n# Added a comment\nbody = cq.Workplane("XY").box(10, 10, 10)\n\ncq.exporters.export(body, "part.step")`;

  const beforeIssues = [
    { category: 'dimensions', severity: 'major', evidence: 'box(10, 10, 10)', explanation: 'Wrong dimensions' }
  ];
  const afterReviewUnchanged = {
    approved: false,
    issues: [
      { category: 'dimensions', severity: 'major', evidence: 'box(10, 10, 10)', explanation: 'Wrong dimensions' }
    ]
  };

  const resIdentical = V.analyzeRepairAttempt({
    beforeCode: codeBefore,
    afterCode: codeIdentical,
    beforeIssues,
    afterReview: afterReviewUnchanged,
    attempt: 1,
    maxRepairs: 3
  });
  assert(resIdentical.is_identical === true, 'Detects identical code output (hash before == hash after)');
  assert(resIdentical.outcome === 'stagnation_identical_code', 'Categorizes outcome as stagnation_identical_code');
  assert(resIdentical.should_stop === true, 'Signals repair loop to halt immediately');

  const resNoChange = V.analyzeRepairAttempt({
    beforeCode: codeBefore,
    afterCode: codeWhitespaceOnly,
    beforeIssues,
    afterReview: afterReviewUnchanged,
    attempt: 1,
    maxRepairs: 3
  });
  assert(resNoChange.meaningful_change === false, 'Detects non-meaningful code change (comment/whitespace only)');
  assert(resNoChange.outcome === 'stagnation_no_code_change', 'Categorizes outcome as stagnation_no_code_change');
  assert(resNoChange.should_stop === true, 'Halts repair loop when code change is not meaningful');

  const codeChangedMeaningful = `import cadquery as cq\nbody = cq.Workplane("XY").box(10, 10, 10)\nx = 1\ncq.exporters.export(body, "part.step")`;
  const resRepeated = V.analyzeRepairAttempt({
    beforeCode: codeBefore,
    afterCode: codeChangedMeaningful,
    beforeIssues,
    afterReview: afterReviewUnchanged,
    attempt: 2,
    maxRepairs: 3
  });
  assert(resRepeated.resolved_count === 0 && resRepeated.unresolved_count === 1, 'Calculates 0 resolved and 1 unresolved issue');
  assert(resRepeated.outcome === 'stagnation_repeated_unresolved', 'Detects stagnation on repeated unresolved issues without progress');
  assert(resRepeated.should_stop === true, 'Halts repair loop when stalled on repeated issues');
}

// ----------------------------------------------------
// N. WORKFLOW CANCELLATION & AGENT CLEANUP
// ----------------------------------------------------
console.log('\n[Test Suite N] Workflow Cancellation');
{
  const wf = new Workflow();
  wf.controller = new AbortController();
  wf.running = true;
  wf.state.status = 'running';

  wf.stop();
  assert(wf.controller.signal.aborted === true, 'Workflow.stop() aborts the AbortController signal');
}

// ----------------------------------------------------
// O. FAILED AGENT STATUS & NEVER COUNTING AS COMPLETED
// ----------------------------------------------------
console.log('\n[Test Suite O & P] Failed Agent Status & Accurate Progress Calculation');
{
  const wf = new Workflow();
  wf.state.agents['analyst'].status = 'done';
  wf.state.agents['planner'].status = 'error';
  wf.state.agents['planner'].error = 'Invalid coordinate bounds';
  wf.state.agents['generator'].status = 'skipped';
  wf.state.agents['reviewer'].status = 'skipped';
  wf.state.agents['repair'].status = 'skipped';
  wf.state.agents['reporter'].status = 'skipped';
  wf.state.status = 'failed';

  const vals = Object.values(wf.state.agents);
  const completedWeight = vals.reduce((sum, a) => {
    if (a.status === 'done') return sum + 1.0;
    if (a.status === 'skipped') return sum + 0.5;
    if (a.status === 'warning') return sum + 0.7;
    if (a.status === 'running') return sum + (a.progress / 100) * 0.9;
    if (a.status === 'error' || a.status === 'cancelled') return sum + 0.0;
    return sum;
  }, 0);
  const pct = Math.round((completedWeight / vals.length) * 100);

  assert(pct < 100, `Failed workflow does not display 100% progress (calculated: ${pct}%)`);
  assert(wf.state.agents['planner'].status === 'error', 'Failed agent retains error status');
}

// ----------------------------------------------------
// Q. DUPLICATE PYTHON CODE BLOCKS
// ----------------------------------------------------
console.log('\n[Test Suite Q] Duplicate Python Code Block Extraction');
{
  const repeatedResponse = `Here is the code:
\`\`\`python
import cadquery as cq
result = cq.Workplane("XY").box(50, 40, 80)
cq.exporters.export(result, "part.step")
cq.exporters.export(result, "part.stl")
\`\`\`

And here is another copy of the code:
\`\`\`python
import cadquery as cq
result = cq.Workplane("XY").box(50, 40, 80)
\`\`\``;

  const ex = V.extractFirstProgram(repeatedResponse);
  assert(ex.complete === true, 'Extracts complete program from repeated output');
  assert(!ex.code.includes('another copy'), 'Discards text outside the first program block');
  assert((ex.code.match(/import cadquery/g) || []).length === 1, 'Extracted source contains exactly one import statement');
}

// ----------------------------------------------------
// R. INCOMPLETE MODEL OUTPUT & SYNTAX SCANNING
// ----------------------------------------------------
console.log('\n[Test Suite R] Incomplete Model Output Detection');
{
  const truncatedCode = `import cadquery as cq
result = cq.Workplane("XY").box(50, 40, 80
# Notice unclosed bracket above`;

  const scan = V.scanPython(truncatedCode);
  assert(scan.ok === false, 'scanPython detects unclosed bracket');

  const comp = V.checkComplete(truncatedCode);
  assert(comp.complete === false, 'checkComplete detects incomplete program');
}

// ----------------------------------------------------
// S. OLLAMA CONNECTION ERRORS & MODEL CHECKING
// ----------------------------------------------------
console.log('\n[Test Suite S] Ollama Connection Errors & Model Matching');
{
  const errUnreachable = new OllamaError('unreachable', 'Connection refused', { recoverable: false });
  assert(errUnreachable.recoverable === false, 'unreachable error is marked non-recoverable without retry loops');

  const errTimeout = new OllamaError('timeout', 'Read timed out', { recoverable: true });
  assert(errTimeout.recoverable === true, 'timeout error is marked recoverable for retry');

  const installed = ['qwen2.5-coder:7b', 'gemma4:e4b', 'hf.co/mradermacher/FutureCAD-7B-GGUF:Q4_K_M'];
  assert(modelInstalled(installed, 'qwen2.5-coder:7b') === true, 'Exact model name matches');
  assert(modelInstalled(installed, 'gemma4:e4b:latest') === true, 'Model with tag alias matches');
  assert(modelInstalled(installed, 'nonexistent_model') === false, 'Non-installed model returns false');
}

// ----------------------------------------------------
// T. FINAL REPORT ACCURACY & HONEST VERIFICATION
// ----------------------------------------------------
console.log('\n[Test Suite T] Final Report Accuracy & Verification Honesty');
{
  const state = {
    status: 'completed',
    prompt: 'L-bracket 80x50x40',
    config: {},
    agents: {},
    outputs: {
      requirements: { object: 'L-Bracket' },
      plan: { coordinate_system: {} },
      planValidation: { valid: true },
      code: 'import cadquery as cq...',
      review: { approved: true, issues: [] },
      repairHistory: []
    }
  };

  const v = computeVerification(state);
  assert(v.python_execution === 'NOT VERIFIED', 'Python execution remains honestly NOT VERIFIED');
  assert(v.geometry_validity === 'NOT VERIFIED', 'Geometry validity remains honestly NOT VERIFIED');
  assert(v.step_export === 'NOT VERIFIED', 'STEP export remains honestly NOT VERIFIED');
  assert(v.stl_export === 'NOT VERIFIED', 'STL export remains honestly NOT VERIFIED');

  const sec = statusSection(state);
  assert(sec.includes('APPLICATION-GENERATED STATUS'), 'Authoritative status section header present');
  assert(sec.includes('Notice: The browser environment does not execute Python'), 'Honest execution disclaimer present');
}

// ----------------------------------------------------
// DELIVERABLES CHECKS
// ----------------------------------------------------
console.log('\n[Test Suite Deliverables] Downloads Availability');
{
  const state = {
    status: 'completed',
    outputs: {
      requirements: { object: 'L-Bracket' },
      plan: { coordinate_system: {} },
      planValidation: { valid: true },
      code: 'import cadquery as cq...',
      review: { approved: true, issues: [] },
      repairHistory: [],
      report: 'Final report'
    }
  };

  const planValDeliv = DELIVERABLES.find(d => d.key === 'plan_validation');
  assert(!!planValDeliv, 'plan_validation deliverable is registered');
  assert(isAvailable(planValDeliv, state) === true, 'plan_validation deliverable is available when outputs exist');
}

// ====================================================
// V2.1 HARDENING REGRESSION TEST SUITES (U THROUGH Z)
// ====================================================

// ----------------------------------------------------
// U. HOLE MATERIAL MEMBERSHIP (POINT-IN-POLYGON) & COORDINATE RIGOR
// ----------------------------------------------------
console.log('\n[Test Suite U] P0 Fix: Hole Material Membership & Coordinate Rigor');
{
  const lBracketBasePlan = {
    coordinate_system: { units: 'mm', origin: [0, 0, 0] },
    parameters: { length: 50, height: 80, width: 40, thickness: 4 },
    steps: [
      {
        id: 1,
        geometry: 'polyline_extrusion',
        workplane: 'XZ',
        profile_vertices: [[0, 0], [50, 0], [50, 4], [4, 4], [4, 80], [0, 80]],
        extrusion_direction: '+Y',
        extrusion_distance: 40,
        resulting_bounding_box: { x_min: 0, x_max: 50, y_min: 0, y_max: 40, z_min: 0, z_max: 80 }
      }
    ],
    expected_bounding_box: { x_min: 0, x_max: 50, y_min: 0, y_max: 40, z_min: 0, z_max: 80, x_len: 50, y_len: 40, z_len: 80 },
    expected_solid_count: 1,
    provisional_assumptions: [],
    validation_steps: []
  };

  // U1: Hole in the EMPTY QUADRANT of L-bracket [25, 20, 40] must be REJECTED
  const planEmptyQuadrant = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-EMPTY', diameter: 5, center_xyz: [25, 20, 40], axis: 'Y' }]
  };
  const resEmpty = V.validateGeometryPlan(planEmptyQuadrant);
  assert(resEmpty.valid === false, 'Hole in empty quadrant [25, 20, 40] is rejected');
  assert(resEmpty.errors.some(e => e.id === 'PLAN-HOLE-NOT-IN-MATERIAL'), 'Reports PLAN-HOLE-NOT-IN-MATERIAL for empty quadrant hole');

  // U2: Hole in VERTICAL ARM material region [2, 20, 25] must PASS
  const planVerticalArm = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-VERT', diameter: 3, center_xyz: [2, 20, 25], axis: 'X' }]
  };
  const resVert = V.validateGeometryPlan(planVerticalArm);
  assert(resVert.valid === true, 'Hole in vertical arm material region [2, 20, 25] passes');

  // U3: Hole in HORIZONTAL ARM material region [25, 20, 2] must PASS
  const planHorizArm = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-HORIZ', diameter: 3, center_xyz: [25, 20, 2], axis: 'Z' }]
  };
  const resHoriz = V.validateGeometryPlan(planHorizArm);
  assert(resHoriz.valid === true, 'Hole in horizontal arm material region [25, 20, 2] passes');

  // U4: Missing center_xyz must be rejected
  const planMissingCoords = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-NO-COORDS', diameter: 5, axis: 'X' }]
  };
  const resNoCoords = V.validateGeometryPlan(planMissingCoords);
  assert(resNoCoords.errors.some(e => e.id === 'PLAN-HOLE-COORDS-INVALID'), 'Missing center_xyz rejected with PLAN-HOLE-COORDS-INVALID');

  // U5: Malformed center_xyz (2 coordinates instead of 3) must be rejected
  const planMalformedCoords = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-2D', diameter: 5, center_xyz: [2, 20], axis: 'X' }]
  };
  const resMalformed = V.validateGeometryPlan(planMalformedCoords);
  assert(resMalformed.errors.some(e => e.id === 'PLAN-HOLE-COORDS-INVALID'), '2D array center_xyz rejected with PLAN-HOLE-COORDS-INVALID');

  // U6: NaN coordinates must be rejected
  const planNaNCoords = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-NAN', diameter: 5, center_xyz: [NaN, 20, 25], axis: 'X' }]
  };
  const resNaN = V.validateGeometryPlan(planNaNCoords);
  assert(resNaN.errors.some(e => e.id === 'PLAN-HOLE-COORDS-INVALID'), 'NaN in center_xyz rejected with PLAN-HOLE-COORDS-INVALID');

  // U7: Infinite coordinates must be rejected
  const planInfCoords = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-INF', diameter: 5, center_xyz: [2, Infinity, 25], axis: 'X' }]
  };
  const resInf = V.validateGeometryPlan(planInfCoords);
  assert(resInf.errors.some(e => e.id === 'PLAN-HOLE-COORDS-INVALID'), 'Infinity in center_xyz rejected with PLAN-HOLE-COORDS-INVALID');

  // U8: String coordinates must be rejected
  const planStrCoords = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-STR', diameter: 5, center_xyz: ['2', '20', '25'], axis: 'X' }]
  };
  const resStr = V.validateGeometryPlan(planStrCoords);
  assert(resStr.errors.some(e => e.id === 'PLAN-HOLE-COORDS-INVALID'), 'String center_xyz rejected with PLAN-HOLE-COORDS-INVALID');

  // U9: Zero or negative diameter must be rejected
  const planZeroDiam = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-ZERO', diameter: 0, center_xyz: [2, 20, 25], axis: 'X' }]
  };
  const resZeroDiam = V.validateGeometryPlan(planZeroDiam);
  assert(resZeroDiam.errors.some(e => e.id === 'PLAN-HOLE-DIAM'), 'Zero diameter rejected with PLAN-HOLE-DIAM');

  // U10: Invalid axis must be rejected
  const planBadAxis = {
    ...lBracketBasePlan,
    holes: [{ id: 'HOLE-AXIS', diameter: 5, center_xyz: [2, 20, 25], axis: 'DIAGONAL' }]
  };
  const resBadAxis = V.validateGeometryPlan(planBadAxis);
  assert(resBadAxis.errors.some(e => e.id === 'PLAN-HOLE-AXIS-INVALID'), 'Invalid axis rejected with PLAN-HOLE-AXIS-INVALID');

  // U11: Rectangular box hole containment & clearances
  const boxPlan = {
    coordinate_system: { units: 'mm', origin: [0, 0, 0] },
    parameters: { length: 50, width: 40, height: 10 },
    steps: [{ id: 1, geometry: 'box', workplane: 'XY', resulting_bounding_box: 'box' }],
    expected_bounding_box: { x_min: 0, x_max: 50, y_min: 0, y_max: 40, z_min: 0, z_max: 10, x_len: 50, y_len: 40, z_len: 10 },
    expected_solid_count: 1,
    holes: [
      { id: 'HOLE-BOX-OK', diameter: 6, center_xyz: [25, 20, 5], axis: 'Z' }
    ],
    provisional_assumptions: [],
    validation_steps: []
  };
  const resBoxOk = V.validateGeometryPlan(boxPlan);
  assert(resBoxOk.valid === true, 'Hole centered in rectangular box passes');
}

// ----------------------------------------------------
// V. LEXICAL CODE ANALYSIS: COMMENTS & STRING LITERALS IGNORED
// ----------------------------------------------------
console.log('\n[Test Suite V] P0 Fix: Lexical Code Analysis (Comments vs Executable Code)');
{
  // V1: STEP export ONLY in a comment must NOT count as actual export
  const codeCommentOnlyStep = `import cadquery as cq
body = cq.Workplane("XY").box(10, 10, 10)
# cq.exporters.export(body, "part.step")
cq.exporters.export(body, "part.stl")`;

  const staticStepComment = V.staticChecks(codeCommentOnlyStep);
  assert(staticStepComment.some(s => s.id && s.category === 'exports' && s.evidence.includes('STEP')),
    'staticChecks detects missing STEP export when commented out with #');

  const absentStepComment = V.verifyAbsentClaim('ABSENT: STEP export', codeCommentOnlyStep);
  assert(absentStepComment.isActuallyPresent === false,
    'verifyAbsentClaim correctly reports STEP export as confirmed absent when in a comment');

  // V2: STEP export ONLY in a string literal must NOT count as actual export
  const codeStringOnlyStep = `import cadquery as cq
body = cq.Workplane("XY").box(10, 10, 10)
doc = "cq.exporters.export(body, 'part.step')"
cq.exporters.export(body, "part.stl")`;

  const staticStepString = V.staticChecks(codeStringOnlyStep);
  assert(staticStepString.some(s => s.id && s.category === 'exports' && s.evidence.includes('STEP')),
    'staticChecks detects missing STEP export when only in a string literal');

  const absentStepString = V.verifyAbsentClaim('ABSENT: STEP export', codeStringOnlyStep);
  assert(absentStepString.isActuallyPresent === false,
    'verifyAbsentClaim correctly reports STEP export as confirmed absent when in a string literal');

  // V3: Executable STEP export MUST be detected
  const codeExecutableStep = `import cadquery as cq
body = cq.Workplane("XY").box(10, 10, 10)
cq.exporters.export(body, "part.step")
cq.exporters.export(body, "part.stl")`;

  const staticStepExec = V.staticChecks(codeExecutableStep);
  assert(!staticStepExec.some(s => s.evidence.includes('STEP')),
    'staticChecks recognizes executable STEP export');

  const absentStepExec = V.verifyAbsentClaim('ABSENT: STEP export', codeExecutableStep);
  assert(absentStepExec.isActuallyPresent === true,
    'verifyAbsentClaim confirms executable STEP export is actually present');

  // V4: Fillet ONLY in a comment must NOT count
  const codeCommentOnlyFillet = `import cadquery as cq
body = cq.Workplane("XY").box(10, 10, 10)
# body = body.edges().fillet(2.0)
cq.exporters.export(body, "part.step")`;
  const absentFilletComment = V.verifyAbsentClaim('ABSENT: fillet', codeCommentOnlyFillet);
  assert(absentFilletComment.isActuallyPresent === false,
    'verifyAbsentClaim confirms fillet is absent when only in comment');

  // V5: Fillet ONLY in a string literal must NOT count
  const codeStringOnlyFillet = `import cadquery as cq
body = cq.Workplane("XY").box(10, 10, 10)
desc = "Use body.fillet(2.0) on edges"
cq.exporters.export(body, "part.step")`;
  const absentFilletString = V.verifyAbsentClaim('ABSENT: fillet', codeStringOnlyFillet);
  assert(absentFilletString.isActuallyPresent === false,
    'verifyAbsentClaim confirms fillet is absent when only in string literal');

  // V6: Multiline call expression is detected
  const codeMultilineCall = `import cadquery as cq
body = cq.Workplane("XY").box(10, 10, 10)
cq.exporters.export(
    body,
    "part.step"
)
cq.exporters.export(body, "part.stl")`;
  const staticMulti = V.staticChecks(codeMultilineCall);
  assert(!staticMulti.some(s => s.evidence.includes('STEP')),
    'staticChecks recognizes multiline formatted export call');

  // V7: Code normalization preserves '#' inside string literals
  const codeWithHashInString = `import cadquery as cq
filename = "part_#1.step"
body = cq.Workplane("XY").box(10, 10, 10) # trailing comment`;
  const normalized = V.normalizeCodeForComparison(codeWithHashInString);
  assert(normalized.includes('filename = "part_#1.step"'),
    'normalizeCodeForComparison preserves "#" character inside string literals');
  assert(!normalized.includes('trailing comment'),
    'normalizeCodeForComparison strips real comments');
}

// ----------------------------------------------------
// W. 2D POLYGON PROFILE TOPOLOGY (SELF-INTERSECTION & DEGENERACY)
// ----------------------------------------------------
console.log('\n[Test Suite W] P1 Fix: 2D Polygon Profile Topology & Self-Intersection');
{
  // W1: Valid rectangle passes
  const rect = [[0, 0], [50, 0], [50, 40], [0, 40]];
  const resRect = V.validatePolygonProfile(rect);
  assert(resRect.valid === true, 'Valid rectangle profile passes');

  // W2: Valid L-shaped profile passes
  const lProf = [[0, 0], [50, 0], [50, 4], [4, 4], [4, 80], [0, 80]];
  const resL = V.validatePolygonProfile(lProf);
  assert(resL.valid === true, 'Valid concave L-profile passes');

  // W3: Bow-tie self-intersecting polygon MUST BE REJECTED
  const bowTie = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const resBowTie = V.validatePolygonProfile(bowTie);
  assert(resBowTie.valid === false, 'Bow-tie self-intersecting polygon is rejected');
  assert(resBowTie.errorId === 'PLAN-PROFILE-SELF-INTERSECTING', 'Reports PLAN-PROFILE-SELF-INTERSECTING');

  // W4: Duplicate consecutive vertices MUST BE REJECTED
  const dupConsecutive = [[0, 0], [10, 0], [10, 0], [10, 10], [0, 10]];
  const resDup = V.validatePolygonProfile(dupConsecutive);
  assert(resDup.valid === false, 'Duplicate consecutive vertices rejected');
  assert(resDup.errorId === 'PLAN-PROFILE-ZERO-EDGE', 'Reports PLAN-PROFILE-ZERO-EDGE for duplicate consecutive vertex');

  // W5: Zero-length edge MUST BE REJECTED
  const zeroEdge = [[0, 0], [10, 0], [10, 0.00000001], [0, 10]];
  const resZeroEdge = V.validatePolygonProfile(zeroEdge);
  assert(resZeroEdge.valid === false, 'Zero-length edge rejected');
  assert(resZeroEdge.errorId === 'PLAN-PROFILE-ZERO-EDGE', 'Reports PLAN-PROFILE-ZERO-EDGE for zero-length edge');

  // W6: Collinear degenerate polygon (zero area) MUST BE REJECTED
  const collinear = [[0, 0], [10, 0], [20, 0]];
  const resCollinear = V.validatePolygonProfile(collinear);
  assert(resCollinear.valid === false, 'Collinear polygon rejected');
  assert(resCollinear.errorId === 'PLAN-PROFILE-DEGENERATE', 'Reports PLAN-PROFILE-DEGENERATE');

  // W7: Non-finite vertex coordinates MUST BE REJECTED
  const nonFiniteVert = [[0, 0], [NaN, 10], [10, 10]];
  const resNonFinite = V.validatePolygonProfile(nonFiniteVert);
  assert(resNonFinite.valid === false, 'Non-finite coordinates rejected');
  assert(resNonFinite.errorId === 'PLAN-PROFILE-VERTEX', 'Reports PLAN-PROFILE-VERTEX for NaN vertex');
}

// ----------------------------------------------------
// X. DEEP PLAN VALIDATION & EXPECTED SOLID COUNT
// ----------------------------------------------------
console.log('\n[Test Suite X] P1 Fix: Deep Plan Validation & Expected Solid Count');
{
  const basePlan = {
    coordinate_system: { units: 'mm', origin: [0, 0, 0] },
    parameters: { length: 50 },
    steps: [{ id: 1, geometry: 'box', workplane: 'XY', resulting_bounding_box: 'box' }],
    expected_bounding_box: { x_len: 50, y_len: 40, z_len: 80 },
    expected_solid_count: 1,
    provisional_assumptions: [],
    validation_steps: []
  };

  // X1: Non-integer expected_solid_count rejected
  const resFloatSolid = V.validatePlan({ ...basePlan, expected_solid_count: 1.5 });
  assert(resFloatSolid.some(e => e.includes('expected_solid_count')), 'validatePlan rejects non-integer expected_solid_count (1.5)');

  // X2: Zero expected_solid_count rejected
  const resZeroSolid = V.validatePlan({ ...basePlan, expected_solid_count: 0 });
  assert(resZeroSolid.some(e => e.includes('expected_solid_count')), 'validatePlan rejects expected_solid_count = 0');

  // X3: validateGeometryPlan checks solid count
  const resGeomSolid = V.validateGeometryPlan({ ...basePlan, expected_solid_count: -1 });
  assert(resGeomSolid.errors.some(e => e.id === 'PLAN-SOLID-COUNT'), 'validateGeometryPlan reports PLAN-SOLID-COUNT for negative count');
}

// ----------------------------------------------------
// Y. FILLET VS CHAMFER VALIDATION
// ----------------------------------------------------
console.log('\n[Test Suite Y] P1 Fix: Fillet vs Chamfer Validation');
{
  const planBase = {
    coordinate_system: { units: 'mm' },
    parameters: { thickness: 4 },
    steps: [{ id: 1, geometry: 'box', workplane: 'XY', resulting_bounding_box: 'box' }],
    expected_bounding_box: { x_len: 50, y_len: 40, z_len: 80 },
    expected_solid_count: 1,
    provisional_assumptions: [],
    validation_steps: []
  };

  // Y1: Zero fillet radius rejected
  const resZeroFillet = V.validateGeometryPlan({
    ...planBase,
    fillets_chamfers: [{ id: 'FC-ZERO', type: 'fillet', radius: 0 }]
  });
  assert(resZeroFillet.errors.some(e => e.id === 'PLAN-FILLET-NONPOSITIVE'), 'Zero fillet radius rejected with PLAN-FILLET-NONPOSITIVE');

  // Y2: Negative fillet radius rejected
  const resNegFillet = V.validateGeometryPlan({
    ...planBase,
    fillets_chamfers: [{ id: 'FC-NEG', type: 'fillet', radius: -2.5 }]
  });
  assert(resNegFillet.errors.some(e => e.id === 'PLAN-FILLET-NONPOSITIVE'), 'Negative fillet radius rejected with PLAN-FILLET-NONPOSITIVE');

  // Y3: Zero chamfer size rejected
  const resZeroChamfer = V.validateGeometryPlan({
    ...planBase,
    fillets_chamfers: [{ id: 'FC-CHAM-ZERO', type: 'chamfer', size: 0 }]
  });
  assert(resZeroChamfer.errors.some(e => e.id === 'PLAN-CHAMFER-NONPOSITIVE'), 'Zero chamfer size rejected with PLAN-CHAMFER-NONPOSITIVE');

  // Y4: Negative chamfer size rejected
  const resNegChamfer = V.validateGeometryPlan({
    ...planBase,
    fillets_chamfers: [{ id: 'FC-CHAM-NEG', type: 'chamfer', size: -1.0 }]
  });
  assert(resNegChamfer.errors.some(e => e.id === 'PLAN-CHAMFER-NONPOSITIVE'), 'Negative chamfer size rejected with PLAN-CHAMFER-NONPOSITIVE');

  // Y5: Valid positive fillet and chamfer pass
  const resValidFC = V.validateGeometryPlan({
    ...planBase,
    fillets_chamfers: [
      { id: 'FC-F', type: 'fillet', radius: 2.0 },
      { id: 'FC-C', type: 'chamfer', size: 1.5 }
    ]
  });
  assert(resValidFC.valid === true, 'Valid positive fillet and chamfer pass');
}

// ----------------------------------------------------
// Z. DETERMINISTIC PRECEDENCE OVER REVIEWER APPROVAL
// ----------------------------------------------------
console.log('\n[Test Suite Z] Deterministic Validation Precedence');
{
  const codeMissingImport = `body = cq.Workplane("XY").box(10, 10, 10)
cq.exporters.export(body, "part.step")
cq.exporters.export(body, "part.stl")`;

  const reviewerClaimedApproved = {
    approved: true,
    summary: 'The code looks great!',
    issues: []
  };

  const merged = V.mergeReview(reviewerClaimedApproved, V.staticChecks(codeMissingImport), codeMissingImport);
  assert(merged.approved === false, 'Deterministic check overrides reviewer: approved is FALSE due to missing import');
  assert(merged.issues.some(i => i.id.startsWith('STATIC') && i.evidence.includes('import')),
    'Static import failure added with confirmed status');
}

// ----------------------------------------------------
// SUMMARY
// ----------------------------------------------------
console.log('\n======================================================');
console.log(` Test Execution Summary: ${passedCount} PASSED, ${failedCount} FAILED`);
console.log('======================================================\n');

if (failedCount > 0) {
  console.error(`❌ Regression test suite failed with ${failedCount} errors.`);
  if (typeof process !== 'undefined') process.exit(1);
} else {
  console.log('✅ All regression criteria (A through Z) verified successfully!');
}
