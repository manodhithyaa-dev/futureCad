// validators.js — Layered validation, schemas, deterministic geometry plan checks,
// lexical Python inspection, reviewer merge, and repair stagnation analysis.

export class ValidationError extends Error {
  constructor(m) {
    super(m);
    this.name = 'ValidationError';
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isArr = Array.isArray;
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

// ==========================================
// LAYER 1: STRICT JSON EXTRACTION & PARSING
// ==========================================

export function parseJsonStrict(text) {
  let t = (text || '').trim();
  if (!t) throw new ValidationError('Empty response');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch (e1) {
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {
        /* fall through */
      }
    }
    throw new ValidationError('Invalid or truncated JSON: ' + e1.message);
  }
}

// ==========================================
// LAYER 2: REQUIREMENT SPECIFICATION SCHEMA
// ==========================================

export const VALID_UNITS = ['mm', 'cm', 'm', 'in'];

export function convertUnit(value, fromUnit = 'mm', toUnit = 'mm') {
  if (!Number.isFinite(value)) return NaN;
  const factors = { mm: 1.0, cm: 10.0, m: 1000.0, in: 25.4 };
  const from = (fromUnit || 'mm').toLowerCase();
  const to = (toUnit || 'mm').toLowerCase();
  if (!factors[from] || !factors[to]) return NaN;
  return (value * factors[from]) / factors[to];
}

export function validateRequirements(o) {
  const e = [];
  if (!isObj(o)) return ['root must be a JSON object'];
  if (typeof o.object !== 'string' || !o.object.trim()) {
    e.push('"object" must be a non-empty string');
  }

  for (const k of [
    'dimensions',
    'features',
    'explicit_requirements',
    'assumptions',
    'missing_information',
    'contradictions',
    'warnings'
  ]) {
    if (!isArr(o[k])) e.push(`"${k}" must be an array`);
  }

  if (isArr(o.dimensions)) {
    o.dimensions.forEach((d, i) => {
      if (!isObj(d)) return e.push(`dimensions[${i}] must be an object`);
      if (typeof d.name !== 'string' || !d.name.trim()) e.push(`dimensions[${i}].name is required`);
      if (d.value !== null && d.value !== undefined && typeof d.value !== 'number') {
        e.push(`dimensions[${i}].value must be a number or null`);
      }
      if (d.unit && !VALID_UNITS.includes(String(d.unit).toLowerCase())) {
        e.push(`dimensions[${i}].unit "${d.unit}" is invalid; supported: ${VALID_UNITS.join(', ')}`);
      }
    });
  }

  if (isArr(o.features)) {
    o.features.forEach((f, i) => {
      if (!isObj(f)) return e.push(`features[${i}] must be an object`);
      if (typeof f.type !== 'string' || !f.type.trim()) e.push(`features[${i}].type is required`);
      if (typeof f.description !== 'string') e.push(`features[${i}].description must be a string`);
    });
  }

  return e;
}

// ==========================================
// 2D GEOMETRY UTILITIES & POLYGON VALIDATION
// ==========================================

export function ccw(p1, p2, p3) {
  return (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p2[1] - p1[1]) * (p3[0] - p1[0]);
}

export function onSegment(p, a, b, eps = 1e-7) {
  const minX = Math.min(a[0], b[0]) - eps;
  const maxX = Math.max(a[0], b[0]) + eps;
  const minY = Math.min(a[1], b[1]) - eps;
  const maxY = Math.max(a[1], b[1]) + eps;
  if (p[0] < minX || p[0] > maxX || p[1] < minY || p[1] > maxY) return false;
  const cross = Math.abs(ccw(a, b, p));
  const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return cross <= eps * Math.max(1.0, segLen);
}

export function segmentsIntersect(a, b, c, d, eps = 1e-7) {
  const cp1 = ccw(a, b, c);
  const cp2 = ccw(a, b, d);
  const cp3 = ccw(c, d, a);
  const cp4 = ccw(c, d, b);

  // General straddle intersection
  if (
    ((cp1 > eps && cp2 < -eps) || (cp1 < -eps && cp2 > eps)) &&
    ((cp3 > eps && cp4 < -eps) || (cp3 < -eps && cp4 > eps))
  ) {
    return true;
  }

  // Collinear or endpoint overlap on segment
  if (Math.abs(cp1) <= eps && onSegment(c, a, b, eps)) return true;
  if (Math.abs(cp2) <= eps && onSegment(d, a, b, eps)) return true;
  if (Math.abs(cp3) <= eps && onSegment(a, c, d, eps)) return true;
  if (Math.abs(cp4) <= eps && onSegment(b, c, d, eps)) return true;

  return false;
}

export function pointInPolygon2D(point, polygon, eps = 1e-7) {
  const [x, y] = point;
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];

    if (onSegment([x, y], [xi, yi], [xj, yj], eps)) {
      return { inside: true, onBoundary: true };
    }

    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return { inside, onBoundary: false };
}

export function pointToSegmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-14) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const projX = a[0] + t * dx;
  const projY = a[1] + t * dy;
  return Math.hypot(p[0] - projX, p[1] - projY);
}

export function distanceToPolygonPerimeter(point, polygon) {
  let minD = Infinity;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const next = polygon[(i + 1) % n];
    const d = pointToSegmentDistance(point, polygon[i], next);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * Validates 2D polygon profile:
 * - Minimum 3 vertices
 * - Finite coordinates
 * - No zero-length edges
 * - Non-zero signed area (Shoelace)
 * - No self-intersecting non-adjacent edges (e.g. bow-tie)
 */
export function validatePolygonProfile(vertices) {
  if (!isArr(vertices)) {
    return { valid: false, errorId: 'PLAN-PROFILE-FORMAT', message: 'profile_vertices must be an array' };
  }
  if (vertices.length < 3) {
    return { valid: false, errorId: 'PLAN-PROFILE-COUNT', message: `Profile must have at least 3 vertices (found ${vertices.length})` };
  }

  // Check coordinates
  for (let i = 0; i < vertices.length; i++) {
    const pt = vertices[i];
    if (!isArr(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      return { valid: false, errorId: 'PLAN-PROFILE-VERTEX', message: `Vertex at index ${i} must be a 2D numeric point [x, y]` };
    }
  }

  // Remove duplicate closing vertex if present
  const pts = vertices.map(v => [v[0], v[1]]);
  if (pts.length > 3) {
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-7) {
      pts.pop();
    }
  }

  const n = pts.length;
  if (n < 3) {
    return { valid: false, errorId: 'PLAN-PROFILE-COUNT', message: 'Profile has fewer than 3 unique vertices' };
  }

  // Zero-length edges & duplicate consecutive vertices
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const edgeLen = Math.hypot(pts[next][0] - pts[i][0], pts[next][1] - pts[i][1]);
    if (edgeLen < 1e-6) {
      return {
        valid: false,
        errorId: 'PLAN-PROFILE-ZERO-EDGE',
        message: `Edge from vertex ${i} to ${next} has zero length (${edgeLen.toFixed(6)} mm) / duplicate consecutive vertex`
      };
    }
  }

  // Segment self-intersection test on non-adjacent edges (run before area check to detect bow-tie topology)
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Exclude adjacent edges sharing a vertex
      if (j === i || j === (i + 1) % n || (i === 0 && j === n - 1)) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d, 1e-7)) {
        return {
          valid: false,
          errorId: 'PLAN-PROFILE-SELF-INTERSECTING',
          message: `Profile polygon is self-intersecting (e.g. bow-tie) between edge ${i}->${(i + 1) % n} and edge ${j}->${(j + 1) % n}`
        };
      }
    }
  }

  // Area (Shoelace formula)
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    area2 += pts[i][0] * pts[next][1] - pts[next][0] * pts[i][1];
  }
  const area = 0.5 * Math.abs(area2);
  if (area < 1e-6) {
    return {
      valid: false,
      errorId: 'PLAN-PROFILE-DEGENERATE',
      message: `Profile polygon is degenerate with zero area (${area.toFixed(6)})`
    };
  }

  return { valid: true, area, vertexCount: n, cleanedVertices: pts };
}

// ==========================================
// LAYER 3: CAD PLAN STRUCTURAL & GEOMETRIC VALIDATION
// ==========================================

export function validatePlan(o) {
  const e = [];
  if (!isObj(o)) return ['root must be a JSON object'];
  if (!isObj(o.coordinate_system)) e.push('"coordinate_system" must be an object');
  if (!isArr(o.steps) || !o.steps.length) {
    e.push('"steps" must be a non-empty array');
  } else {
    o.steps.forEach((s, i) => {
      if (!isObj(s)) return e.push(`steps[${i}] must be an object`);
      for (const k of ['geometry', 'workplane', 'resulting_bounding_box']) {
        if (s[k] === undefined || s[k] === null || s[k] === '') {
          e.push(`steps[${i}].${k} is required`);
        }
      }
    });
  }
  if (!isObj(o.expected_bounding_box)) e.push('"expected_bounding_box" must be an object');
  if (typeof o.expected_solid_count !== 'number' || !Number.isInteger(o.expected_solid_count) || o.expected_solid_count < 1) {
    e.push('"expected_solid_count" must be a positive integer >= 1');
  }
  if (!isArr(o.validation_steps)) e.push('"validation_steps" must be an array');
  if (!isArr(o.provisional_assumptions)) e.push('"provisional_assumptions" must be an array');
  return e;
}

/**
 * Deterministic Geometry Plan Validator.
 * Pure JavaScript: validates dimensional consistency, profile topology,
 * hole material membership (Point-in-Polygon), edge clearances, and fillet feasibility.
 */
export function validateGeometryPlan(plan) {
  const errors = [];
  const warnings = [];

  const addErr = (id, field, msg, severity = 'blocking') => {
    errors.push({ id, field, message: msg, severity });
  };
  const addWarn = (id, field, msg, severity = 'warning') => {
    warnings.push({ id, field, message: msg, severity });
  };

  if (!isObj(plan)) {
    addErr('PLAN-ROOT', 'root', 'Plan must be a JSON object');
    return { valid: false, errors, warnings, summary: 'Plan is not a valid JSON object' };
  }

  // 1. Expected Solid Count
  if (plan.expected_solid_count !== undefined && plan.expected_solid_count !== null) {
    if (typeof plan.expected_solid_count !== 'number' || !Number.isInteger(plan.expected_solid_count) || plan.expected_solid_count < 1) {
      addErr('PLAN-SOLID-COUNT', 'expected_solid_count', `expected_solid_count must be a positive integer >= 1 (found ${plan.expected_solid_count})`);
    }
  }

  // 2. Parameters & Positive Dimensions
  const params = isObj(plan.parameters) ? plan.parameters : {};
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) {
        addErr('PLAN-PARAM-NONFINITE', `parameters.${key}`, `Parameter "${key}" must be a finite number`);
      } else if (val <= 0) {
        addErr('PLAN-PARAM-NONPOSITIVE', `parameters.${key}`, `Parameter "${key}" must be > 0 (found ${val})`);
      }
    }
  }

  // 3. Units
  const units = String(plan.coordinate_system?.units || 'mm').toLowerCase();
  if (!VALID_UNITS.includes(units)) {
    addErr('PLAN-UNIT-INVALID', 'coordinate_system.units', `Invalid unit "${units}"; must be one of: ${VALID_UNITS.join(', ')}`);
  }

  // 4. Expected Bounding Box
  const bb = plan.expected_bounding_box;
  let bbX = 0, bbY = 0, bbZ = 0;
  if (isObj(bb)) {
    bbX = bb.x_len || bb.x_mm || (bb.x_max !== undefined && bb.x_min !== undefined ? bb.x_max - bb.x_min : 0);
    bbY = bb.y_len || bb.y_mm || (bb.y_max !== undefined && bb.y_min !== undefined ? bb.y_max - bb.y_min : 0);
    bbZ = bb.z_len || bb.z_mm || (bb.z_max !== undefined && bb.z_min !== undefined ? bb.z_max - bb.z_min : 0);

    if (bbX <= 0 || !Number.isFinite(bbX)) addErr('PLAN-BB-X', 'expected_bounding_box.x', `Bounding box X must be positive (found ${bbX})`);
    if (bbY <= 0 || !Number.isFinite(bbY)) addErr('PLAN-BB-Y', 'expected_bounding_box.y', `Bounding box Y must be positive (found ${bbY})`);
    if (bbZ <= 0 || !Number.isFinite(bbZ)) addErr('PLAN-BB-Z', 'expected_bounding_box.z', `Bounding box Z must be positive (found ${bbZ})`);

    if (bb.x_min !== undefined && bb.x_max !== undefined && bb.x_max <= bb.x_min) {
      addErr('PLAN-BB-RANGE-X', 'expected_bounding_box.x_range', `x_max (${bb.x_max}) must be greater than x_min (${bb.x_min})`);
    }
    if (bb.y_min !== undefined && bb.y_max !== undefined && bb.y_max <= bb.y_min) {
      addErr('PLAN-BB-RANGE-Y', 'expected_bounding_box.y_range', `y_max (${bb.y_max}) must be greater than y_min (${bb.y_min})`);
    }
    if (bb.z_min !== undefined && bb.z_max !== undefined && bb.z_max <= bb.z_min) {
      addErr('PLAN-BB-RANGE-Z', 'expected_bounding_box.z_range', `z_max (${bb.z_max}) must be greater than z_min (${bb.z_min})`);
    }
  } else {
    addErr('PLAN-BB-MISSING', 'expected_bounding_box', 'expected_bounding_box is missing');
  }

  // 5. Construction Steps & Profile Geometry
  const stepIds = new Set();
  const validPlanes = ['XY', 'XZ', 'YZ', 'front', 'back', 'top', 'bottom', 'left', 'right'];
  const validDirections = ['+X', '-X', '+Y', '-Y', '+Z', '-Z', 'X', 'Y', 'Z', 'normal'];
  let primaryStep = null;

  if (isArr(plan.steps)) {
    plan.steps.forEach((s, idx) => {
      const stepId = s.id !== undefined ? s.id : idx + 1;
      stepIds.add(String(stepId));
      if (!primaryStep && s.profile_vertices) primaryStep = s;

      // Extrusion distance
      if (s.extrusion_distance !== undefined && s.extrusion_distance !== null) {
        if (typeof s.extrusion_distance !== 'number' || s.extrusion_distance <= 0 || !Number.isFinite(s.extrusion_distance)) {
          addErr('PLAN-EXTRUDE-DIST', `steps[${idx}].extrusion_distance`, `Extrusion distance must be positive and finite (found ${s.extrusion_distance})`);
        }
      }

      // Workplane check
      if (s.workplane && typeof s.workplane === 'string') {
        const wpClean = s.workplane.replace(/[<>+-]/g, '').trim();
        if (!validPlanes.some(vp => wpClean.toUpperCase().includes(vp.toUpperCase()))) {
          addWarn('PLAN-WP-UNUSUAL', `steps[${idx}].workplane`, `Workplane "${s.workplane}" is unconventional; standard planes are XY, XZ, YZ.`);
        }
      }

      // Profile validation using segment-segment intersection
      if (s.profile_vertices !== undefined) {
        const profRes = validatePolygonProfile(s.profile_vertices);
        if (!profRes.valid) {
          addErr(profRes.errorId, `steps[${idx}].profile_vertices`, profRes.message);
        }
      }

      // Extrusion direction check
      if (s.extrusion_direction && typeof s.extrusion_direction === 'string') {
        const dir = s.extrusion_direction.trim().toUpperCase();
        if (!validDirections.some(vd => dir.includes(vd))) {
          addWarn('PLAN-EXTRUDE-DIR', `steps[${idx}].extrusion_direction`, `Extrusion direction "${s.extrusion_direction}" is non-standard`);
        }
      }
    });
  }

  // 6. Geometry-Aware Hole Validation
  const validAxes = ['X', 'Y', 'Z', '+X', '-X', '+Y', '-Y', '+Z', '-Z'];

  if (isArr(plan.holes)) {
    plan.holes.forEach((h, idx) => {
      const hId = h.id || `HOLE-${idx + 1}`;

      // A. Strict Coordinate Validation
      if (!isArr(h.center_xyz) || h.center_xyz.length !== 3 || !h.center_xyz.every(Number.isFinite)) {
        addErr('PLAN-HOLE-COORDS-INVALID', `holes[${idx}].center_xyz`,
          `Hole ${hId} center_xyz must be an array of exactly 3 finite numbers [x, y, z]`);
        return; // Cannot continue spatial checks without valid coordinates
      }

      const [hx, hy, hz] = h.center_xyz;

      // B. Diameter & Radius Validation
      if (typeof h.diameter !== 'number' || h.diameter <= 0 || !Number.isFinite(h.diameter)) {
        addErr('PLAN-HOLE-DIAM', `holes[${idx}].diameter`, `Hole ${hId} diameter must be positive and finite (found ${h.diameter})`);
      }
      const radius = typeof h.diameter === 'number' && h.diameter > 0 ? h.diameter / 2 : 0;

      // C. Axis Validation
      let axisStr = String(h.axis || '').trim().toUpperCase();
      if (!axisStr && h.reference_frame) {
        // Fallback axis inference from workplane/face if stated
        if (h.workplane === 'YZ') axisStr = 'X';
        else if (h.workplane === 'XZ') axisStr = 'Y';
        else if (h.workplane === 'XY') axisStr = 'Z';
      }
      if (!axisStr || !validAxes.includes(axisStr)) {
        addErr('PLAN-HOLE-AXIS-INVALID', `holes[${idx}].axis`, `Hole ${hId} axis "${h.axis}" is invalid; must be one of: ${validAxes.join(', ')}`);
      }
      const cleanAxis = axisStr.replace(/[+-]/g, '');

      // D. Depth Validation
      if (h.depth !== undefined && h.depth !== null) {
        if (typeof h.depth !== 'number' || h.depth <= 0 || !Number.isFinite(h.depth)) {
          addErr('PLAN-HOLE-DEPTH-INVALID', `holes[${idx}].depth`, `Hole ${hId} depth must be positive and finite (found ${h.depth})`);
        }
      }

      // E. Bounding Box Containment
      const xMin = bb.x_min !== undefined ? bb.x_min : 0;
      const xMax = bb.x_max !== undefined ? bb.x_max : bbX;
      const yMin = bb.y_min !== undefined ? bb.y_min : 0;
      const yMax = bb.y_max !== undefined ? bb.y_max : bbY;
      const zMin = bb.z_min !== undefined ? bb.z_min : 0;
      const zMax = bb.z_max !== undefined ? bb.z_max : bbZ;
      const eps = 0.5;

      if (hx < xMin - eps || hx > xMax + eps || hy < yMin - eps || hy > yMax + eps || hz < zMin - eps || hz > zMax + eps) {
        addErr('PLAN-HOLE-OUTSIDE-BB', `holes[${idx}].center_xyz`,
          `Hole ${hId} center [${hx}, ${hy}, ${hz}] lies outside expected bounding box X:[${xMin},${xMax}] Y:[${yMin},${yMax}] Z:[${zMin},${zMax}]`);
      }

      // F. Material Membership & Edge Clearance via Profile Projection
      if (primaryStep && isArr(primaryStep.profile_vertices) && primaryStep.profile_vertices.length >= 3) {
        const wp = String(primaryStep.workplane || 'XZ').toUpperCase().replace(/[<>+-]/g, '');
        let u = 0, v = 0, wCoord = 0;
        let wMin = 0, wMax = 0;

        if (wp === 'XZ') {
          u = hx; v = hz; wCoord = hy;
          wMin = yMin; wMax = yMax;
        } else if (wp === 'XY') {
          u = hx; v = hy; wCoord = hz;
          wMin = zMin; wMax = zMax;
        } else if (wp === 'YZ') {
          u = hy; v = hz; wCoord = hx;
          wMin = xMin; wMax = xMax;
        }

        const pip = pointInPolygon2D([u, v], primaryStep.profile_vertices);

        // Test if hole center lies in actual material
        if (!pip.inside) {
          addErr('PLAN-HOLE-NOT-IN-MATERIAL', `holes[${idx}].center_xyz`,
            `Hole ${hId} center [${hx}, ${hy}, ${hz}] projects to (${u}, ${v}) in profile plane ${wp}, which is in empty space outside the solid material`);
        } else {
          // Point is inside profile; check edge clearances
          const dPerimeter = distanceToPolygonPerimeter([u, v], primaryStep.profile_vertices);

          // If drilled along the extrusion axis (perpendicular to profile)
          const isPerpendicular = (wp === 'XZ' && cleanAxis === 'Y') || (wp === 'XY' && cleanAxis === 'Z') || (wp === 'YZ' && cleanAxis === 'X');
          if (isPerpendicular) {
            const clearance = dPerimeter - radius;
            if (clearance < -0.05) {
              addErr('PLAN-HOLE-EDGE-BREAKOUT', `holes[${idx}].center_xyz`,
                `Hole ${hId} (radius ${radius} mm) at (${u}, ${v}) breaks outside profile perimeter (distance: ${dPerimeter.toFixed(2)} mm, clearance: ${clearance.toFixed(2)} mm)`);
            } else if (clearance < 1.0) {
              addWarn('PLAN-HOLE-EDGE-MARGIN', `holes[${idx}].center_xyz`,
                `Hole ${hId} has minimal margin (< 1.0 mm) to profile perimeter`);
            }
          } else {
            // Hole drilled along an axis within the profile plane (e.g. through a wall)
            // Check clearance along the extrusion width direction wCoord
            const clearanceW1 = wCoord - wMin - radius;
            const clearanceW2 = wMax - wCoord - radius;
            if (clearanceW1 < -0.05 || clearanceW2 < -0.05) {
              addErr('PLAN-HOLE-EDGE-BREAKOUT', `holes[${idx}].center_xyz`,
                `Hole ${hId} (radius ${radius} mm) at width ${wCoord} breaks outside part boundary [${wMin}, ${wMax}] in extrusion direction`);
            }

            // Material thickness check along drill axis
            if (h.depth !== undefined && h.depth > 0) {
              const nominalThickness = typeof params.thickness === 'number' ? params.thickness : (typeof params.t === 'number' ? params.t : null);
              if (nominalThickness && h.depth > nominalThickness + 0.1 && !h.through) {
                addWarn('PLAN-HOLE-DEPTH-EXCEEDS-MATERIAL', `holes[${idx}].depth`,
                  `Hole ${hId} depth (${h.depth} mm) exceeds nominal wall thickness (${nominalThickness} mm)`);
              }
            }
          }
        }
      } else {
        // Fallback for non-profile geometries (e.g. primitive box steps)
        addWarn('PLAN-HOLE-UNVERIFIED-TOPOLOGY', `holes[${idx}]`,
          `Hole ${hId} material containment could not be proven with 2D profile projection; checked bounding box only`);

        // Check edge clearances along bounding box dimensions
        if (hy >= yMin && hy <= yMax && radius > 0) {
          const clearanceY1 = hy - yMin - radius;
          const clearanceY2 = yMax - hy - radius;
          if (clearanceY1 < -0.05 || clearanceY2 < -0.05) {
            addErr('PLAN-HOLE-EDGE-BREAKOUT', `holes[${idx}].center_xyz`,
              `Hole ${hId} (radius ${radius} mm) at Y=${hy} breaks outside part width [${yMin}, ${yMax}] (negative clearance)`);
          } else if (clearanceY1 < 1.0 || clearanceY2 < 1.0) {
            addWarn('PLAN-HOLE-EDGE-MARGIN', `holes[${idx}].center_xyz`,
              `Hole ${hId} has minimal edge margin (< 1.0 mm) to part boundary in Y`);
          }
        }
      }
    });
  }

  // 7. Fillet & Chamfer Validation
  if (isArr(plan.fillets_chamfers)) {
    const thickness = typeof params.thickness === 'number' ? params.thickness : (typeof params.t === 'number' ? params.t : null);

    plan.fillets_chamfers.forEach((fc, idx) => {
      const fcId = fc.id || `FC-${idx + 1}`;
      const isChamfer = String(fc.type || '').toLowerCase() === 'chamfer';
      let r = null;

      if (isChamfer) {
        if (typeof fc.size === 'number') r = fc.size;
        else if (typeof fc.distance === 'number') r = fc.distance;
      } else {
        if (typeof fc.radius === 'number') r = fc.radius;
        else if (typeof fc.size === 'number') r = fc.size;
      }

      if (r === null && typeof fc.size === 'string') {
        const m = fc.size.match(/[-+]?[0-9]*\.?[0-9]+/);
        if (m) r = parseFloat(m[0]);
      }

      if (r !== null) {
        if (!Number.isFinite(r) || r <= 0) {
          const errId = isChamfer ? 'PLAN-CHAMFER-NONPOSITIVE' : 'PLAN-FILLET-NONPOSITIVE';
          addErr(errId, `fillets_chamfers[${idx}].size`, `${isChamfer ? 'Chamfer' : 'Fillet'} ${fcId} dimension must be positive and finite (found ${r})`);
        } else if (thickness !== null && thickness > 0) {
          if (r > thickness + 0.01) {
            addErr('PLAN-FILLET-EXCEEDS-THICKNESS', `fillets_chamfers[${idx}].radius`,
              `${isChamfer ? 'Chamfer' : 'Fillet'} dimension (${r} mm) exceeds wall thickness (${thickness} mm), which risks topology collapse`, 'major');
          }
        }
      } else {
        addWarn('PLAN-FC-DIM-MISSING', `fillets_chamfers[${idx}]`, `${isChamfer ? 'Chamfer' : 'Fillet'} ${fcId} has unspecified size`);
      }
    });
  }

  // 8. Boolean Operations Consistency
  if (isArr(plan.boolean_operations)) {
    plan.boolean_operations.forEach((b, idx) => {
      if (isObj(b)) {
        if (b.target && stepIds.size > 0 && !stepIds.has(String(b.target)) && !stepIds.has('1')) {
          addWarn('PLAN-BOOL-REF', `boolean_operations[${idx}].target`, `Boolean operation target "${b.target}" does not match declared step IDs`);
        }
      }
    });
  }

  const valid = errors.length === 0;
  const summary = valid
    ? `Plan passed deterministic geometry validation (${warnings.length} warning(s)).`
    : `Plan rejected with ${errors.length} blocking error(s) and ${warnings.length} warning(s).`;

  return {
    valid,
    errors,
    warnings,
    summary,
    validated_at: new Date().toISOString(),
    disclaimer: 'Deterministic plan validation checks geometric constraints, material membership, and numerical consistency. It does NOT guarantee that the OpenCascade/CadQuery geometry kernel will succeed without topological errors.'
  };
}

// ==========================================
// LAYER 4: LEXICAL SCANNER & PYTHON PARSING
// ==========================================

/**
 * Strips comments from Python code while preserving all string literal contents.
 */
export function stripPythonCommentsOnly(code) {
  let out = '';
  let i = 0;
  const s = String(code || '');
  const n = s.length;

  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const isTriple = s.startsWith(c.repeat(3), i);
      const q = isTriple ? c.repeat(3) : c;
      out += q;
      i += q.length;
      while (i < n) {
        if (s[i] === '\\') {
          out += s[i];
          if (i + 1 < n) out += s[i + 1];
          i += 2;
          continue;
        }
        if (s.startsWith(q, i)) {
          out += q;
          i += q.length;
          break;
        }
        out += s[i];
        i++;
      }
      continue;
    }
    if (c === '#') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Strips both comments and string literal contents, leaving empty quotes ""
 * to represent executable tokens without false string matches.
 */
export function stripPythonCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  const s = String(code || '');
  const n = s.length;

  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const isTriple = s.startsWith(c.repeat(3), i);
      const q = isTriple ? c.repeat(3) : c;
      i += q.length;
      out += '""';
      while (i < n) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s.startsWith(q, i)) {
          i += q.length;
          break;
        }
        if (!isTriple && s[i] === '\n') {
          out += '\n';
          i++;
          break;
        }
        if (s[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    if (c === '#') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function scanPython(code) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '#') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const tri = code.startsWith(c.repeat(3), i);
      const q = tri ? c.repeat(3) : c;
      i += q.length;
      let closed = false;
      while (i < n) {
        if (code[i] === '\\') {
          i += 2;
          continue;
        }
        if (code.startsWith(q, i)) {
          i += q.length;
          closed = true;
          break;
        }
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
  const exec = stripPythonCommentsAndStrings(code);
  if (!/^[ \t]*import\s+cadquery\s+as\s+cq\b/m.test(exec))
    return { complete: false, reason: 'missing "import cadquery as cq"' };
  const sc = scanPython(code);
  if (!sc.ok) return { complete: false, reason: 'program is cut off or malformed (' + sc.reason + ')' };
  const lines = code.split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !l.trim().startsWith('#'));
  const last = lines[lines.length - 1] || '';
  if (/[,\\+\-*\/=:(\[{.]$/.test(last)) return { complete: false, reason: 'last line looks unfinished: ' + last.trim().slice(0, 60) };
  if (lines.length < 3) return { complete: false, reason: 'program is too short to be complete' };
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
  if (imports.length > 1) {
    body = body.slice(0, imports[1].index);
    repeated = true;
  }
  body = body.replace(/\s+$/, '') + '\n';
  return { code: body, fenceClosed, repeated, ...checkComplete(body) };
}

/** Streaming predicate: stop as soon as the first complete program is available. */
export function shouldStopStreaming(text, piece, tokens) {
  if (!(piece.includes('`') || piece.includes('cq') || tokens % 16 === 0)) return false;
  const ex = extractFirstProgram(text);
  return ex.complete && (ex.fenceClosed || ex.repeated);
}

// ==========================================
// LAYER 5: STATIC CADQUERY CHECKS (LEXICAL)
// ==========================================

export const INVALID_METHODS = [
  'extrude_bidir',
  'extrudeBidir',
  'extrude_both',
  'fillet_edges',
  'fillet_all',
  'chamfer_edges',
  'chamfer_all',
  'hole_at',
  'cutHole',
  'cut_hole',
  'add_hole',
  'CadQuery.Workplane',
  'cq.WorkPlane',
  'filletQ',
  'chamferQ',
  'cq.Query',
  'make_box',
  'create_box',
  'add_fillet'
];

/**
 * Tokenizes Python string literals into placeholders __STR_n__ while stripping comments,
 * enabling clean lexical inspection of executable call expressions and arguments.
 */
export function tokenizePythonStrings(code) {
  let codeWithoutComments = '';
  let i = 0;
  const s = String(code || '');
  const n = s.length;
  const stringMap = [];

  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const isTriple = s.startsWith(c.repeat(3), i);
      const q = isTriple ? c.repeat(3) : c;
      i += q.length;
      let strVal = '';
      while (i < n) {
        if (s[i] === '\\') {
          strVal += s[i];
          if (i + 1 < n) strVal += s[i + 1];
          i += 2;
          continue;
        }
        if (s.startsWith(q, i)) {
          i += q.length;
          break;
        }
        strVal += s[i];
        i++;
      }
      const token = `__STR_${stringMap.length}__`;
      stringMap.push(strVal);
      codeWithoutComments += token;
      continue;
    }
    if (c === '#') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    codeWithoutComments += c;
    i++;
  }
  return { codeTokens: codeWithoutComments, stringMap };
}

/**
 * Checks whether an export operation targeting the specified extension (.step or .stl)
 * is called in executable code (not commented-out and not merely embedded inside a string literal).
 */
export function hasExecutableExport(code, ext) {
  const { codeTokens, stringMap } = tokenizePythonStrings(code);
  const re = /(?:exportStep|exportStl|\.export|exporters\.export)\s*\(([\s\S]*?)\)/gi;
  let match;
  const targetExt = '.' + ext.toLowerCase();

  while ((match = re.exec(codeTokens)) !== null) {
    const args = match[1];
    const strMatches = args.match(/__STR_(\d+)__/g);
    if (strMatches) {
      for (const sm of strMatches) {
        const idx = parseInt(sm.replace(/\D/g, ''), 10);
        const val = stringMap[idx] || '';
        if (val.toLowerCase().includes(targetExt)) return true;
      }
    }
    if (ext.toLowerCase() === 'step' && /exportStep/i.test(match[0])) return true;
    if (ext.toLowerCase() === 'stl' && /exportStl/i.test(match[0])) return true;
  }
  return false;
}

/**
 * Checks executable code only (ignores comments and string literals).
 */
export function staticChecks(code) {
  const out = [];
  let nextId = 1;
  const add = (severity, category, evidence, explanation, fix) => {
    out.push({
      id: `STATIC-${String(nextId++).padStart(3, '0')}`,
      severity,
      category,
      evidence,
      explanation,
      expected: fix,
      actual: evidence,
      suggested_correction: fix,
      verification_status: 'confirmed',
      source: 'static-check'
    });
  };

  const { codeTokens } = tokenizePythonStrings(code);
  const execCode = stripPythonCommentsAndStrings(code);
  const lineOf = re => (code.split('\n').find(l => re.test(l)) || '').trim();

  // 1. Required import (in executable code)
  if (!/^[ \t]*import\s+cadquery\s+as\s+cq\b/m.test(execCode)) {
    add('blocking', 'syntax', 'ABSENT: import cadquery as cq', 'Required CadQuery import is missing in executable code.', 'Add "import cadquery as cq" at top.');
  }

  // 2. Forbidden / invented APIs (in executable code)
  for (const m of INVALID_METHODS) {
    const re = new RegExp(m.replace('.', '\\.') + '\\b');
    if (re.test(execCode)) {
      add('blocking', 'api', lineOf(re), `"${m}" is an invented/unsupported CadQuery API.`, 'Replace with standard CadQuery calls (extrude, hole, fillet, union, cut).');
    }
  }

  // 3. Workplane instantiation (in executable code)
  if (!/\bcq\.Workplane\s*\(/.test(execCode)) {
    add('blocking', 'geometry', 'ABSENT: cq.Workplane(', 'No cq.Workplane is instantiated in executable code.', 'Build geometry using cq.Workplane(...).');
  }

  // 4. STEP export verification (must be an executable call referencing a .step target)
  if (!hasExecutableExport(code, 'step')) {
    add('major', 'exports', 'ABSENT: STEP export', 'No executable STEP export call found (commented-out or string literals do not count).', 'Add cq.exporters.export(result, "part.step").');
  }

  // 5. STL export verification (must be an executable call referencing a .stl target)
  if (!hasExecutableExport(code, 'stl')) {
    add('major', 'exports', 'ABSENT: STL export', 'No executable STL export call found (commented-out or string literals do not count).', 'Add cq.exporters.export(result, "part.stl").');
  }

  // 6. Bracket and quote balance
  const sc = scanPython(code);
  if (!sc.ok) {
    add('blocking', 'syntax', 'ABSENT: balanced syntax', 'Syntax structure problem: ' + sc.reason + '.', 'Fix the unbalanced brackets/strings.');
  }

  // 7. Repeated imports / duplicated program
  if ((execCode.match(IMPORT_G) || []).length > 1) {
    add('blocking', 'maintainability', lineOf(/import\s+cadquery/), 'Program text is repeated (multiple imports).', 'Keep exactly one complete program.');
  }

  return out;
}

// ==========================================
// LAYER 6: INDEPENDENT CODE REVIEWER VALIDATION
// ==========================================

export const SEVERITIES = ['blocking', 'major', 'minor', 'info'];

export function validateReview(o) {
  const e = [];
  if (!isObj(o)) return ['root must be a JSON object'];
  if (typeof o.approved !== 'boolean') e.push('"approved" must be a boolean');
  if (!isArr(o.issues)) e.push('"issues" must be an array');
  else {
    o.issues.forEach((it, i) => {
      if (!isObj(it)) return e.push(`issues[${i}] must be an object`);
      if (typeof it.severity !== 'string' || !SEVERITIES.includes(it.severity.toLowerCase())) {
        e.push(`issues[${i}].severity must be one of: ${SEVERITIES.join(', ')}`);
      }
      for (const k of ['evidence', 'explanation', 'suggested_correction']) {
        if (typeof it[k] !== 'string' || !it[k].trim()) {
          e.push(`issues[${i}].${k} must be a non-empty string`);
        }
      }
    });
  }
  return e;
}

/**
 * Checks whether an ABSENT claim is actually true or a hallucination/false positive.
 * CRITICAL: Operates on EXECUTABLE code tokens; comments and string literals
 * do not satisfy required operations.
 */
export function verifyAbsentClaim(evidenceStr, code) {
  const m = String(evidenceStr || '').match(/^ABSENT:\s*(.+)$/i);
  if (!m) return { isAbsentClaim: false };
  const rawTarget = m[1].trim();
  const targetLower = rawTarget.toLowerCase();

  const { codeTokens } = tokenizePythonStrings(code);
  const execCode = stripPythonCommentsAndStrings(code);

  // 1. CadQuery import
  if (targetLower.includes('import') && /^[ \t]*import\s+cadquery\s+as\s+cq\b/m.test(execCode)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'import cadquery as cq is present in executable code' };
  }

  // 2. STEP export (must be an executable call, not in comment/string)
  if (targetLower.includes('step')) {
    if (hasExecutableExport(code, 'step')) {
      return { isAbsentClaim: true, isActuallyPresent: true, reason: 'STEP export is present in executable code' };
    }
  }

  // 3. STL export (must be an executable call, not in comment/string)
  if (targetLower.includes('stl')) {
    if (hasExecutableExport(code, 'stl')) {
      return { isAbsentClaim: true, isActuallyPresent: true, reason: 'STL export is present in executable code' };
    }
  }

  // 4. Hole operations (in executable code tokens)
  if (targetLower.includes('hole') && /(\.hole\s*\(|\.circle\s*\([^)]*\)\.extrude|cboreHole\s*\(|cskHole\s*\()/i.test(codeTokens)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'Hole feature is present in executable code' };
  }

  // 5. Fillet operations (in executable code tokens)
  if (targetLower.includes('fillet') && /\.fillet\s*\(/i.test(codeTokens)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'Fillet feature is present in executable code' };
  }

  // 6. Chamfer operations (in executable code tokens)
  if (targetLower.includes('chamfer') && /\.chamfer\s*\(/i.test(codeTokens)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'Chamfer feature is present in executable code' };
  }

  // 7. Workplane operations (in executable code tokens)
  if (targetLower.includes('workplane') && /\bcq\.Workplane\s*\(/i.test(codeTokens)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'cq.Workplane is present in executable code' };
  }

  // 8. Box operations (in executable code tokens)
  if (targetLower.includes('box') && /\.box\s*\(/i.test(codeTokens)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'box construction is present in executable code' };
  }

  // 9. Extrude operations (in executable code tokens)
  if (targetLower.includes('extrude') && /\.extrude\s*\(/i.test(codeTokens)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'extrude operation is present in executable code' };
  }

  // 10. Cut operations (in executable code tokens)
  if (targetLower.includes('cut') && /\.cut\s*\(/i.test(codeTokens)) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: 'cut operation is present in executable code' };
  }

  // 11. Generic token presence in executable code
  const cleanTarget = rawTarget.replace(/['"`]/g, '').trim();
  if (cleanTarget.length >= 3 && codeTokens.toLowerCase().includes(cleanTarget.toLowerCase())) {
    return { isAbsentClaim: true, isActuallyPresent: true, reason: `Target "${cleanTarget}" is present in executable code` };
  }

  return { isAbsentClaim: true, isActuallyPresent: false };
}

/**
 * Merges LLM reviewer findings with deterministic static checks.
 * STRICT SEVERITY POLICY:
 * - BLOCKING & MAJOR findings prevent approval.
 * - MINOR & INFO findings do not prevent approval.
 * - Deterministic static checks take precedence over LLM assertions.
 */
export function mergeReview(raw, staticIssues, code) {
  const nc = norm(code);
  const kept = [];
  const discarded = [];
  let nextIssueId = 1;

  for (const it of raw.issues || []) {
    const sev = SEVERITIES.includes(String(it.severity).toLowerCase())
      ? String(it.severity).toLowerCase()
      : 'minor';

    const ev = norm(it.evidence);
    const issueId = it.id || `ISSUE-${String(nextIssueId++).padStart(3, '0')}`;
    const category = it.category || 'general';

    const candidate = {
      id: issueId,
      severity: sev,
      category,
      evidence: it.evidence,
      explanation: it.explanation,
      expected: it.expected || it.suggested_correction || '',
      actual: it.actual || it.evidence || '',
      suggested_correction: it.suggested_correction,
      verification_status: 'confirmed',
      source: 'llm-reviewer'
    };

    const absentCheck = verifyAbsentClaim(ev, code);
    if (absentCheck.isAbsentClaim) {
      if (absentCheck.isActuallyPresent) {
        discarded.push({
          ...candidate,
          verification_status: 'discarded',
          discard_reason: `False ABSENT finding: ${absentCheck.reason}`
        });
      } else {
        kept.push(candidate);
      }
    } else {
      if (ev.length > 2 && nc.includes(ev)) {
        kept.push(candidate);
      } else {
        discarded.push({
          ...candidate,
          verification_status: 'discarded',
          discard_reason: 'evidence not found in code'
        });
      }
    }
  }

  // Merge static checks without duplicating existing issues
  for (const s of staticIssues) {
    if (!kept.some(k => norm(k.evidence) === norm(s.evidence))) {
      kept.push(s);
    }
  }

  // STRICT SEVERITY ENFORCEMENT: Deterministic checks prevent approval on blocking and major issues
  const hasBlocking = kept.some(i => i.severity === 'blocking');
  const hasMajor = kept.some(i => i.severity === 'major');
  const approved = !hasBlocking && !hasMajor;

  const blockingCount = kept.filter(i => i.severity === 'blocking').length;
  const majorCount = kept.filter(i => i.severity === 'major').length;
  const minorCount = kept.filter(i => i.severity === 'minor').length;
  const infoCount = kept.filter(i => i.severity === 'info').length;

  return {
    approved,
    summary: raw.summary || '',
    reviewer_said_approved: raw.approved,
    issues: kept,
    discarded_issues: discarded,
    blocking_count: blockingCount,
    major_count: majorCount,
    minor_count: minorCount,
    info_count: infoCount,
    note: 'Static/LLM review only. The code has NOT been executed.',
    reviewed_at: new Date().toISOString()
  };
}

// ==========================================
// LAYER 7: REPAIR ORCHESTRATION & STAGNATION DETECTION
// ==========================================

export function hashCode(str) {
  let hash = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Normalizes Python code for semantic comparison:
 * Strips comments outside strings, but PRESERVES string literal contents (even with #).
 */
export function normalizeCodeForComparison(code) {
  const noComments = stripPythonCommentsOnly(code);
  return noComments
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

export function isMeaningfulCodeChange(code1, code2) {
  const n1 = normalizeCodeForComparison(code1);
  const n2 = normalizeCodeForComparison(code2);
  return n1 !== n2;
}

/**
 * Analyzes a repair attempt to detect progress, stagnation, or regressions.
 */
export function analyzeRepairAttempt({
  beforeCode,
  afterCode,
  beforeIssues = [],
  afterReview = null,
  attempt = 1,
  maxRepairs = 3
}) {
  const hashBefore = hashCode(beforeCode);
  const hashAfter = hashCode(afterCode);
  const isIdentical = hashBefore === hashAfter;
  const meaningfulChange = isMeaningfulCodeChange(beforeCode, afterCode);

  const afterIssues = afterReview?.issues || [];
  const issueKey = i => `${i.category || 'gen'}:${i.severity || 'sev'}:${norm(i.evidence || i.explanation)}`;

  const beforeMap = new Map();
  for (const b of beforeIssues) beforeMap.set(issueKey(b), b);

  const resolved = [];
  const unresolved = [];
  const newIssues = [];

  const afterSeen = new Set();
  for (const a of afterIssues) {
    const k = issueKey(a);
    afterSeen.add(k);
    if (beforeMap.has(k)) {
      unresolved.push(a);
    } else {
      newIssues.push(a);
    }
  }

  for (const [k, b] of beforeMap.entries()) {
    if (!afterSeen.has(k)) {
      resolved.push(b);
    }
  }

  const hasNewCritical = newIssues.some(i => i.severity === 'blocking' || i.severity === 'major');
  const isApproved = !!afterReview?.approved;

  let outcome = 'in_progress';
  let stopReason = null;

  if (isApproved) {
    outcome = 'approved';
  } else if (isIdentical) {
    outcome = 'stagnation_identical_code';
    stopReason = 'Repair generated code byte-for-byte identical to the previous attempt.';
  } else if (!meaningfulChange) {
    outcome = 'stagnation_no_code_change';
    stopReason = 'Repair produced no meaningful Python code changes (only comments or whitespace differed).';
  } else if (resolved.length === 0 && unresolved.length > 0 && attempt >= 2) {
    outcome = 'stagnation_repeated_unresolved';
    stopReason = `Repair stalled: repeated all ${unresolved.length} unresolved issue(s) with 0 resolved issues.`;
  } else if (hasNewCritical && resolved.length === 0) {
    outcome = 'repair_regression';
    stopReason = `Repair regressed: introduced ${newIssues.filter(i => i.severity === 'blocking' || i.severity === 'major').length} new critical issue(s) without resolving prior issues.`;
  } else if (attempt >= maxRepairs) {
    outcome = 'max_attempts_reached';
    stopReason = `Reached maximum configured repair limit (${maxRepairs}).`;
  }

  return {
    attempt,
    hash_before: hashBefore,
    hash_after: hashAfter,
    is_identical: isIdentical,
    meaningful_change: meaningfulChange,
    resolved_count: resolved.length,
    unresolved_count: unresolved.length,
    new_issues_count: newIssues.length,
    resolved_issues: resolved,
    unresolved_issues: unresolved,
    new_issues: newIssues,
    outcome,
    should_stop: outcome !== 'in_progress',
    stop_reason: stopReason
  };
}
