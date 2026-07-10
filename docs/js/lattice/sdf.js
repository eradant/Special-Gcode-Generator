// Signed distance fields for the lattice tool. Convention: negative inside,
// positive outside, distances in mm. Shapes sit on z=0 (print orientation),
// centered on the XY origin. Pure functions — testable in node.
//
// TPMS lattice fields (gyroid, Schwarz P, Schwarz D) are approximate SDFs:
// the raw implicit value is rescaled by L/2π (the average gradient magnitude
// of these functions is ~2π/L), which makes the wall-thickness parameter
// track real millimeters closely enough for printing.

export function makeShapeSDF(shape) {
  if (shape.type === "cylinder") {
    const r = shape.diameter / 2, h = shape.height;
    return (x, y, z) => {
      const dr = Math.hypot(x, y) - r;
      const dz = Math.abs(z - h / 2) - h / 2;
      const ax = Math.max(dr, 0), az = Math.max(dz, 0);
      return Math.hypot(ax, az) + Math.min(Math.max(dr, dz), 0);
    };
  }
  if (shape.type === "sphere") {
    const r = shape.diameter / 2;
    return (x, y, z) => Math.hypot(x, y, z - r) - r;
  }
  // box (default)
  const hx = shape.width / 2, hy = shape.depth / 2, hz = shape.height / 2;
  return (x, y, z) => {
    const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z - hz) - hz;
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0), az = Math.max(qz, 0);
    return Math.hypot(ax, ay, az) + Math.min(Math.max(qx, qy, qz), 0);
  };
}

export function shapeBounds(shape) {
  if (shape.type === "cylinder") {
    const r = shape.diameter / 2;
    return { min: [-r, -r, 0], max: [r, r, shape.height] };
  }
  if (shape.type === "sphere") {
    const r = shape.diameter / 2;
    return { min: [-r, -r, 0], max: [r, r, shape.diameter] };
  }
  return {
    min: [-shape.width / 2, -shape.depth / 2, 0],
    max: [shape.width / 2, shape.depth / 2, shape.height],
  };
}

export function shapeSolidVolume(shape) {
  if (shape.type === "cylinder") return Math.PI * (shape.diameter / 2) ** 2 * shape.height;
  if (shape.type === "sphere") return (4 / 3) * Math.PI * (shape.diameter / 2) ** 3;
  return shape.width * shape.depth * shape.height;
}

// TPMS implicit surfaces, thickened to solid walls of ~wallMm.
// Returns negative inside the wall material.
export function makeLatticeSDF(type, cellMm, wallMm) {
  const k = (2 * Math.PI) / cellMm;
  const scale = 1 / k; // implicit value -> approx mm
  const half = wallMm / 2;
  if (type === "schwarz") {
    return (x, y, z) =>
      Math.abs(Math.cos(k * x) + Math.cos(k * y) + Math.cos(k * z)) * scale - half;
  }
  if (type === "diamond") {
    return (x, y, z) => {
      const sx = Math.sin(k * x), sy = Math.sin(k * y), sz = Math.sin(k * z);
      const cx = Math.cos(k * x), cy = Math.cos(k * y), cz = Math.cos(k * z);
      return Math.abs(sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz) * scale - half;
    };
  }
  // gyroid (default)
  return (x, y, z) =>
    Math.abs(
      Math.sin(k * x) * Math.cos(k * y) +
      Math.sin(k * y) * Math.cos(k * z) +
      Math.sin(k * z) * Math.cos(k * x),
    ) * scale - half;
}

// Compose the final part field:
//  - lattice type "none": the solid shape (hollowed if shellMm > 0)
//  - otherwise: lattice walls clipped to the shape, unioned with an outer
//    shell of shellMm (0 = open-cell lattice showing at the surface) and
//    optional solid top/bottom caps of capMm.
export function makePartSDF({ shape, latticeType, cellMm, wallMm, shellMm, capMm }) {
  const shapeF = makeShapeSDF(shape);
  const bounds = shapeBounds(shape);
  const zTop = bounds.max[2];

  if (!latticeType || latticeType === "none") {
    if (shellMm > 0) {
      // hollow: keep a band of shellMm inside the surface
      return (x, y, z) => {
        const s = shapeF(x, y, z);
        return Math.max(s, -(s + shellMm));
      };
    }
    return shapeF;
  }

  const latticeF = makeLatticeSDF(latticeType, cellMm, wallMm);
  return (x, y, z) => {
    const s = shapeF(x, y, z);
    let d = Math.max(s, latticeF(x, y, z)); // lattice clipped to shape
    if (shellMm > 0) d = Math.min(d, Math.max(s, -(s + shellMm))); // outer shell
    if (capMm > 0) {
      // caps: solid shape within capMm of the bottom or top
      const capRegion = Math.min(z - capMm, (zTop - capMm) - z); // negative inside either cap band
      d = Math.min(d, Math.max(s, capRegion));
    }
    return d;
  };
}
