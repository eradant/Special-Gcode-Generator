// Surface polish for marching-tetrahedra output: move every vertex onto the
// field's true zero level (Newton steps along the numeric gradient), then
// optionally run tangential smoothing passes (Laplacian average followed by
// reprojection, so smoothing improves triangle quality without shrinking the
// part or pulling it off the surface).
//
// Topology is untouched — only vertex positions move — so watertightness is
// preserved by construction. Steps are clamped to the voxel size to stay
// stable across the C1 creases that min/max SDF composition creates.

export function polishMesh(positions, faces, field, voxelMm, { projectPasses = 2, smoothPasses = 2 } = {}) {
  const out = Float32Array.from(positions);
  const vertCount = out.length / 3;
  const eps = voxelMm * 0.25;
  const maxStep = voxelMm;

  const projectVertex = (v) => {
    let x = out[v * 3], y = out[v * 3 + 1], z = out[v * 3 + 2];
    for (let it = 0; it < 2; it++) {
      const f = field(x, y, z);
      if (Math.abs(f) < voxelMm * 0.005) break;
      const gx = (field(x + eps, y, z) - field(x - eps, y, z)) / (2 * eps);
      const gy = (field(x, y + eps, z) - field(x, y - eps, z)) / (2 * eps);
      const gz = (field(x, y, z + eps) - field(x, y, z - eps)) / (2 * eps);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (g2 < 1e-12) break;
      let sx = (f * gx) / g2, sy = (f * gy) / g2, sz = (f * gz) / g2;
      const len = Math.hypot(sx, sy, sz);
      if (len > maxStep) {
        const k = maxStep / len;
        sx *= k; sy *= k; sz *= k;
      }
      x -= sx; y -= sy; z -= sz;
    }
    out[v * 3] = x; out[v * 3 + 1] = y; out[v * 3 + 2] = z;
  };

  for (let pass = 0; pass < projectPasses; pass++) {
    for (let v = 0; v < vertCount; v++) projectVertex(v);
  }

  if (smoothPasses > 0) {
    // Vertex adjacency (unique neighbors via accumulation — duplicates from
    // shared faces just weight the average slightly, which is harmless).
    const neighborSum = new Float32Array(vertCount * 3);
    const neighborCount = new Uint32Array(vertCount);
    for (let pass = 0; pass < smoothPasses; pass++) {
      neighborSum.fill(0);
      neighborCount.fill(0);
      for (let f = 0; f < faces.length; f += 3) {
        for (let e = 0; e < 3; e++) {
          const a = faces[f + e], b = faces[f + ((e + 1) % 3)];
          neighborSum[a * 3] += out[b * 3];
          neighborSum[a * 3 + 1] += out[b * 3 + 1];
          neighborSum[a * 3 + 2] += out[b * 3 + 2];
          neighborCount[a]++;
          neighborSum[b * 3] += out[a * 3];
          neighborSum[b * 3 + 1] += out[a * 3 + 1];
          neighborSum[b * 3 + 2] += out[a * 3 + 2];
          neighborCount[b]++;
        }
      }
      for (let v = 0; v < vertCount; v++) {
        const n = neighborCount[v];
        if (n === 0) continue;
        // Half-step toward the neighborhood average, clamped to the voxel size.
        let dx = neighborSum[v * 3] / n - out[v * 3];
        let dy = neighborSum[v * 3 + 1] / n - out[v * 3 + 1];
        let dz = neighborSum[v * 3 + 2] / n - out[v * 3 + 2];
        const len = Math.hypot(dx, dy, dz) * 0.5;
        const k = len > maxStep ? (0.5 * maxStep) / len : 0.5;
        out[v * 3] += dx * k;
        out[v * 3 + 1] += dy * k;
        out[v * 3 + 2] += dz * k;
      }
      // Pull smoothed vertices back onto the surface.
      for (let v = 0; v < vertCount; v++) projectVertex(v);
    }
  }

  return out;
}
