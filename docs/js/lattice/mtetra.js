// Marching tetrahedra: sample a signed field on a uniform grid and extract
// the zero isosurface as a triangle soup (9 floats per tri, same shape STL
// parsing produces, ready for mesh-core.weld()).
//
// Chosen over marching cubes deliberately: no 256-case lookup tables to get
// wrong, and the uniform 6-tet cube split is conforming across cube faces
// (shared face diagonals match between neighbors), so the welded result is
// watertight by construction. Costs ~2x the triangles of marching cubes —
// acceptable for a mesh headed straight to a slicer.
//
// Triangle winding is fixed per-triangle by pointing the normal away from
// the inside (field < 0) corners, so the caller never depends on tet parity.

export const MAX_GRID_CELLS = 3_000_000;

// field(x, y, z) -> signed value (negative inside).
// bounds are padded by one voxel on every side so the surface never touches
// the grid boundary — that guarantees a closed mesh.
export function meshField(field, bounds, voxelMm) {
  const pad = voxelMm;
  const ox = bounds.min[0] - pad, oy = bounds.min[1] - pad, oz = bounds.min[2] - pad;
  const nx = Math.ceil((bounds.max[0] - bounds.min[0] + 2 * pad) / voxelMm);
  const ny = Math.ceil((bounds.max[1] - bounds.min[1] + 2 * pad) / voxelMm);
  const nz = Math.ceil((bounds.max[2] - bounds.min[2] + 2 * pad) / voxelMm);
  if (nx * ny * nz > MAX_GRID_CELLS) {
    throw new Error(
      `Grid of ${nx}×${ny}×${nz} = ${(nx * ny * nz / 1e6).toFixed(1)}M cells exceeds the ` +
      `${MAX_GRID_CELLS / 1e6}M limit — increase the voxel size`,
    );
  }

  // Sample the field at grid points.
  const px = nx + 1, py = ny + 1, pz = nz + 1;
  const values = new Float32Array(px * py * pz);
  for (let iz = 0; iz < pz; iz++) {
    for (let iy = 0; iy < py; iy++) {
      const rowBase = (iz * py + iy) * px;
      const y = oy + iy * voxelMm, z = oz + iz * voxelMm;
      for (let ix = 0; ix < px; ix++) {
        values[rowBase + ix] = field(ox + ix * voxelMm, y, z);
      }
    }
  }

  // Cube corner offsets (standard ordering), and the 6-tet split along the
  // c0-c6 main diagonal. Every tet contains that diagonal, so the split is
  // identical in every cube and conforming across faces.
  const corner = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const tets = [
    [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6],
    [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6],
  ];

  const out = []; // triangle soup

  const cx = new Float64Array(8), cy = new Float64Array(8), cz = new Float64Array(8);
  const cv = new Float64Array(8);

  // Interpolated crossing point on the edge between corners a and b.
  const crossing = (a, b) => {
    const t = cv[a] / (cv[a] - cv[b]);
    return [
      cx[a] + (cx[b] - cx[a]) * t,
      cy[a] + (cy[b] - cy[a]) * t,
      cz[a] + (cz[b] - cz[a]) * t,
    ];
  };

  // Emit a triangle wound so its normal points away from `ref` (an inside point).
  const emit = (p1, p2, p3, ref) => {
    const ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2];
    const vx = p3[0] - p1[0], vy = p3[1] - p1[1], vz = p3[2] - p1[2];
    const nxx = uy * vz - uz * vy, nyy = uz * vx - ux * vz, nzz = ux * vy - uy * vx;
    const rx = ref[0] - p1[0], ry = ref[1] - p1[1], rz = ref[2] - p1[2];
    if (nxx * rx + nyy * ry + nzz * rz > 0) {
      out.push(p1[0], p1[1], p1[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2]);
    } else {
      out.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
    }
  };

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        // Gather cube corner values; skip cubes with no sign change fast.
        // Values are snapped away from zero: when the surface passes exactly
        // through a grid point, crossings would otherwise land within the
        // weld tolerance of the corner, collapse to slivers, and get dropped
        // as degenerate — leaving holes. The snap displaces the surface by
        // ~SNAP/|gradient| ≈ a micron, far below print resolution.
        const SNAP = 1e-3;
        let anyNeg = false, anyPos = false;
        for (let c = 0; c < 8; c++) {
          const gx = ix + corner[c][0], gy = iy + corner[c][1], gz = iz + corner[c][2];
          const v = values[(gz * py + gy) * px + gx];
          cv[c] = Math.abs(v) < SNAP ? (v < 0 ? -SNAP : SNAP) : v;
          cx[c] = ox + gx * voxelMm;
          cy[c] = oy + gy * voxelMm;
          cz[c] = oz + gz * voxelMm;
          if (cv[c] < 0) anyNeg = true; else anyPos = true;
        }
        if (!anyNeg || !anyPos) continue;

        for (const [a, b, c, d] of tets) {
          const inside = [];
          const outside = [];
          for (const t of [a, b, c, d]) (cv[t] < 0 ? inside : outside).push(t);
          if (inside.length === 0 || inside.length === 4) continue;

          // Reference inside point for winding: centroid of inside corners.
          const ref = [0, 0, 0];
          for (const t of inside) { ref[0] += cx[t]; ref[1] += cy[t]; ref[2] += cz[t]; }
          ref[0] /= inside.length; ref[1] /= inside.length; ref[2] /= inside.length;

          if (inside.length === 1) {
            const [i0] = inside;
            emit(crossing(i0, outside[0]), crossing(i0, outside[1]), crossing(i0, outside[2]), ref);
          } else if (inside.length === 3) {
            const [o0] = outside;
            emit(crossing(inside[0], o0), crossing(inside[1], o0), crossing(inside[2], o0), ref);
          } else {
            // 2 inside / 2 outside: quad i0-o0, i0-o1, i1-o1, i1-o0
            const [i0, i1] = inside;
            const [o0, o1] = outside;
            const q0 = crossing(i0, o0), q1 = crossing(i0, o1);
            const q2 = crossing(i1, o1), q3 = crossing(i1, o0);
            emit(q0, q1, q2, ref);
            emit(q0, q2, q3, ref);
          }
        }
      }
    }
  }

  return new Float32Array(out);
}
