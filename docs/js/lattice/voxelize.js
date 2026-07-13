// Mesh -> approximate signed distance field, the bridge that lets the
// lattice pipeline run on imported STL/3MF parts.
//
// Two-step approach chosen for browser speed (no per-voxel closest-point
// queries):
//  1. Inside/outside per voxel by column parity: for each XY grid column,
//     collect the z-crossings of every triangle over it (2D point-in-triangle
//     + plane interpolation), sort, and parity-fill. Triangles are bucketed
//     into a 2D grid first, so cost is O(tris + columns), not O(tris*columns).
//  2. Approximate distance by a two-pass 26-neighbor chamfer transform seeded
//     at the inside/outside boundary. Error is a few percent — fine for
//     shell bands and lattice clipping (nothing here needs exact distance).
//
// Pure typed-array code: runs in the worker and in node tests.

export function meshBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export const MAX_VOXEL_CELLS = 3_000_000;

export function voxelizeMesh(positions, faces, bounds, voxelMm) {
  const pad = 2 * voxelMm;
  const ox = bounds.min[0] - pad, oy = bounds.min[1] - pad, oz = bounds.min[2] - pad;
  const nx = Math.ceil((bounds.max[0] - bounds.min[0] + 2 * pad) / voxelMm);
  const ny = Math.ceil((bounds.max[1] - bounds.min[1] + 2 * pad) / voxelMm);
  const nz = Math.ceil((bounds.max[2] - bounds.min[2] + 2 * pad) / voxelMm);
  if (nx * ny * nz > MAX_VOXEL_CELLS) {
    const suggested = Math.cbrt(((bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]) * (bounds.max[2] - bounds.min[2])) / MAX_VOXEL_CELLS);
    throw new Error(
      `Part needs ${((nx * ny * nz) / 1e6).toFixed(1)}M voxels at ${voxelMm} mm — try voxel ≥ ${suggested.toFixed(1)} mm`,
    );
  }

  // Bucket triangles by the XY cells their projection overlaps.
  const buckets = new Array(nx * ny);
  const triCount = faces.length / 3;
  for (let t = 0; t < triCount; t++) {
    const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
    const minX = Math.min(positions[a], positions[b], positions[c]);
    const maxX = Math.max(positions[a], positions[b], positions[c]);
    const minY = Math.min(positions[a + 1], positions[b + 1], positions[c + 1]);
    const maxY = Math.max(positions[a + 1], positions[b + 1], positions[c + 1]);
    const ix0 = Math.max(0, Math.floor((minX - ox) / voxelMm - 0.5));
    const ix1 = Math.min(nx - 1, Math.ceil((maxX - ox) / voxelMm - 0.5));
    const iy0 = Math.max(0, Math.floor((minY - oy) / voxelMm - 0.5));
    const iy1 = Math.min(ny - 1, Math.ceil((maxY - oy) / voxelMm - 0.5));
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const key = iy * nx + ix;
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(t);
      }
    }
  }

  // Column parity fill at cell centers. Sample points get a tiny irrational
  // jitter so axis-aligned mesh edges don't land exactly on the ray.
  const jx = voxelMm * 1.3e-4, jy = voxelMm * 2.7e-4;
  const inside = new Uint8Array(nx * ny * nz);
  const crossings = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const tris = buckets[iy * nx + ix];
      if (!tris) continue;
      const px = ox + (ix + 0.5) * voxelMm + jx;
      const py = oy + (iy + 0.5) * voxelMm + jy;
      crossings.length = 0;
      for (const t of tris) {
        const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
        const ax = positions[a], ay = positions[a + 1];
        const bx = positions[b], by = positions[b + 1];
        const cxx = positions[c], cy = positions[c + 1];
        // 2D edge functions; accept if strictly one-sided (either winding)
        const e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const e1 = (cxx - bx) * (py - by) - (cy - by) * (px - bx);
        const e2 = (ax - cxx) * (py - cy) - (ay - cy) * (px - cxx);
        const inTri = (e0 > 0 && e1 > 0 && e2 > 0) || (e0 < 0 && e1 < 0 && e2 < 0);
        if (!inTri) continue;
        // barycentric z at (px, py)
        const area = e0 + e1 + e2;
        if (area === 0) continue;
        const z =
          (positions[a + 2] * e1 + positions[b + 2] * e2 + positions[c + 2] * e0) / area;
        crossings.push(z);
      }
      if (crossings.length < 2) continue;
      crossings.sort((p, q) => p - q);
      // parity fill: cells whose center lies between crossing pairs are inside
      const colBase = iy * nx + ix;
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const z0 = crossings[k], z1 = crossings[k + 1];
        let iz0 = Math.ceil((z0 - oz) / voxelMm - 0.5);
        let iz1 = Math.floor((z1 - oz) / voxelMm - 0.5);
        iz0 = Math.max(0, iz0);
        iz1 = Math.min(nz - 1, iz1);
        for (let iz = iz0; iz <= iz1; iz++) {
          inside[iz * ny * nx + colBase] = 1;
        }
      }
    }
  }

  return { inside, nx, ny, nz, ox, oy, oz, voxelMm };
}

// Closest distance from point p to triangle (a, b, c) — Ericson's method.
function pointTriangleDistance(px, py, pz, positions, a, b, c) {
  const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
  const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
  const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return Math.hypot(apx - t * abx, apy - t * aby, apz - t * abz);
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return Math.hypot(apx - t * acx, apy - t * acy, apz - t * acz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(px - (bx + t * (cx - bx)), py - (by + t * (cy - by)), pz - (bz + t * (cz - bz)));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return Math.hypot(
    px - (ax + abx * v + acx * w),
    py - (ay + aby * v + acy * w),
    pz - (az + abz * v + acz * w),
  );
}

// Signed approximate distance (mm) per voxel: negative inside. Near the
// surface (within `bandVoxels` voxels) distances are EXACT point-triangle
// distances, so the reconstructed skin lands on the true mesh surface instead
// of a half-voxel-quantized approximation — this is what keeps imported parts
// dimensionally accurate. Away from the band, a two-pass 26-neighbor chamfer
// transform propagates the band values (nothing deep inside needs accuracy).
export function distanceTransform(vox, positions = null, faces = null, bandVoxels = 2) {
  const { inside, nx, ny, nz, ox, oy, oz, voxelMm } = vox;
  const n = nx * ny * nz;
  const dist = new Float32Array(n).fill(Infinity);
  const idx = (ix, iy, iz) => (iz * ny + iy) * nx + ix;

  if (positions && faces) {
    // Exact narrow band: for each triangle, visit cells in its dilated bbox.
    const band = bandVoxels * voxelMm;
    for (let t = 0; t < faces.length / 3; t++) {
      const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
      const minX = Math.min(positions[a], positions[b], positions[c]) - band;
      const maxX = Math.max(positions[a], positions[b], positions[c]) + band;
      const minY = Math.min(positions[a + 1], positions[b + 1], positions[c + 1]) - band;
      const maxY = Math.max(positions[a + 1], positions[b + 1], positions[c + 1]) + band;
      const minZ = Math.min(positions[a + 2], positions[b + 2], positions[c + 2]) - band;
      const maxZ = Math.max(positions[a + 2], positions[b + 2], positions[c + 2]) + band;
      const ix0 = Math.max(0, Math.floor((minX - ox) / voxelMm - 0.5));
      const ix1 = Math.min(nx - 1, Math.ceil((maxX - ox) / voxelMm - 0.5));
      const iy0 = Math.max(0, Math.floor((minY - oy) / voxelMm - 0.5));
      const iy1 = Math.min(ny - 1, Math.ceil((maxY - oy) / voxelMm - 0.5));
      const iz0 = Math.max(0, Math.floor((minZ - oz) / voxelMm - 0.5));
      const iz1 = Math.min(nz - 1, Math.ceil((maxZ - oz) / voxelMm - 0.5));
      for (let iz = iz0; iz <= iz1; iz++) {
        const pz = oz + (iz + 0.5) * voxelMm;
        for (let iy = iy0; iy <= iy1; iy++) {
          const py = oy + (iy + 0.5) * voxelMm;
          for (let ix = ix0; ix <= ix1; ix++) {
            const px = ox + (ix + 0.5) * voxelMm;
            const d = pointTriangleDistance(px, py, pz, positions, a, b, c);
            const i = idx(ix, iy, iz);
            if (d < dist[i]) dist[i] = d;
          }
        }
      }
    }
  } else {
    // Fallback seeding: half a voxel at cells whose 6-neighborhood crosses
    // the inside/outside boundary.
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const i = idx(ix, iy, iz);
          const v = inside[i];
          if (
            (ix > 0 && inside[i - 1] !== v) || (ix < nx - 1 && inside[i + 1] !== v) ||
            (iy > 0 && inside[i - nx] !== v) || (iy < ny - 1 && inside[i + nx] !== v) ||
            (iz > 0 && inside[i - nx * ny] !== v) || (iz < nz - 1 && inside[i + nx * ny] !== v)
          ) {
            dist[i] = 0.5 * voxelMm;
          }
        }
      }
    }
  }

  // Chamfer neighbor offsets with euclidean weights (half-set for each pass).
  const offsets = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx < 0)))) {
          offsets.push([dx, dy, dz, Math.hypot(dx, dy, dz) * voxelMm]);
        }
      }
    }
  }

  const relax = (ix, iy, iz, sign) => {
    const i = idx(ix, iy, iz);
    let d = dist[i];
    for (const [dx, dy, dz, w] of offsets) {
      const x = ix + sign * dx, y = iy + sign * dy, z = iz + sign * dz;
      if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) continue;
      const cand = dist[idx(x, y, z)] + w;
      if (cand < d) d = cand;
    }
    dist[i] = d;
  };

  for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) relax(ix, iy, iz, 1);
  for (let iz = nz - 1; iz >= 0; iz--) for (let iy = ny - 1; iy >= 0; iy--) for (let ix = nx - 1; ix >= 0; ix--) relax(ix, iy, iz, -1);

  for (let i = 0; i < n; i++) {
    if (inside[i]) dist[i] = -dist[i];
    else if (!Number.isFinite(dist[i])) dist[i] = 1e6; // empty grid corner case
  }
  return dist;
}

// Trilinear sampler over the signed distance grid. Coordinates outside the
// grid return a large positive value (definitely outside the part).
export function makeGridSDF(vox, dist) {
  const { nx, ny, nz, ox, oy, oz, voxelMm } = vox;
  return (x, y, z) => {
    const fx = (x - ox) / voxelMm - 0.5;
    const fy = (y - oy) / voxelMm - 0.5;
    const fz = (z - oz) / voxelMm - 0.5;
    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) {
      return voxelMm * 4; // outside the padded grid
    }
    const ix = Math.min(nx - 2, Math.floor(fx));
    const iy = Math.min(ny - 2, Math.floor(fy));
    const iz = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const i000 = (iz * ny + iy) * nx + ix;
    const i100 = i000 + 1, i010 = i000 + nx, i110 = i010 + 1;
    const i001 = i000 + nx * ny, i101 = i001 + 1, i011 = i001 + nx, i111 = i011 + 1;
    const c00 = dist[i000] * (1 - tx) + dist[i100] * tx;
    const c10 = dist[i010] * (1 - tx) + dist[i110] * tx;
    const c01 = dist[i001] * (1 - tx) + dist[i101] * tx;
    const c11 = dist[i011] * (1 - tx) + dist[i111] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };
}

// One-call convenience: imported mesh -> { sdf, bounds } ready for
// composePartSDF + meshField.
export function buildImportedSDF(positions, faces, voxelMm) {
  const bounds = meshBounds(positions);
  const vox = voxelizeMesh(positions, faces, bounds, voxelMm);
  const dist = distanceTransform(vox, positions, faces);
  return { sdf: makeGridSDF(vox, dist), bounds };
}
