// Terrain geometry core: heightfield processing (smoothing, water level,
// layer-height terracing, surface texture) and closed-solid mesh generation.
// Pure typed-array functions — no three.js, no DOM — testable in node.
//
// Heightfield convention: Float32Array of W*H samples, row-major, iy=0 at the
// model's south (min Y) edge. The UI flips image rows on sampling so image
// "up" (north) stays up.

import { makeNoiseSampler } from "../texture/noise.js";

// Normalize raw samples to 0..1, apply box-blur smoothing, flatten below the
// water level, and scale to millimeters. Returns z in mm, 0..peakMm.
export function processHeights(raw, W, H, { smoothPasses = 0, waterFrac = 0, peakMm = 40 }) {
  let h = Float32Array.from(raw);

  // normalize to use the full 0..1 range (heightmaps rarely span it exactly)
  let min = Infinity, max = -Infinity;
  for (const v of h) { if (v < min) min = v; if (v > max) max = v; }
  const range = Math.max(1e-9, max - min);
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - min) / range;

  for (let pass = 0; pass < smoothPasses; pass++) {
    const src = h;
    h = new Float32Array(h.length);
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = ix + dx, y = iy + dy;
            if (x < 0 || x >= W || y < 0 || y >= H) continue;
            sum += src[y * W + x];
            n++;
          }
        }
        h[iy * W + ix] = sum / n;
      }
    }
  }

  if (waterFrac > 0) {
    for (let i = 0; i < h.length; i++) if (h[i] < waterFrac) h[i] = waterFrac;
  }

  for (let i = 0; i < h.length; i++) h[i] *= peakMm;
  return h;
}

// Local slope magnitude (dz per mm of horizontal travel) via central
// differences. Used to weight the rock texture toward steep faces.
export function computeSlopes(zMm, W, H, cellMm) {
  const slopes = new Float32Array(W * H);
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const xm = zMm[iy * W + Math.max(0, ix - 1)];
      const xp = zMm[iy * W + Math.min(W - 1, ix + 1)];
      const ym = zMm[Math.max(0, iy - 1) * W + ix];
      const yp = zMm[Math.min(H - 1, iy + 1) * W + ix];
      const dzdx = (xp - xm) / (2 * cellMm);
      const dzdy = (yp - ym) / (2 * cellMm);
      slopes[iy * W + ix] = Math.hypot(dzdx, dzdy);
    }
  }
  return slopes;
}

// 2.5D surface texture on the heightfield (in place). Reuses the texturizer's
// noise samplers — this is the Milestone 1/2 synergy from the roadmap.
//  - "rock":   ridged noise weighted by slope, applied above the water level
//  - "ripple": gentle billow noise on water surfaces only
export function applySurfaceTexture(zMm, W, H, cellMm, { type, featureMm = 4, depthMm = 0.6, waterZMm = 0, seed = 42 }) {
  if (!type || type === "none") return zMm;
  const eps = 1e-4;
  if (type === "rock") {
    const sampler = makeNoiseSampler("ridged", seed, featureMm);
    const slopes = computeSlopes(zMm, W, H, cellMm);
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const i = iy * W + ix;
        if (zMm[i] <= waterZMm + eps) continue;
        const mask = Math.min(1, slopes[i] / 0.7);
        zMm[i] += (sampler(ix * cellMm, iy * cellMm, zMm[i]) - 0.5) * depthMm * mask;
      }
    }
  } else if (type === "ripple") {
    const sampler = makeNoiseSampler("billow", seed, featureMm);
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const i = iy * W + ix;
        if (zMm[i] > waterZMm + eps) continue;
        zMm[i] += (sampler(ix * cellMm, iy * cellMm, 0) - 0.5) * depthMm;
      }
    }
  }
  return zMm;
}

// Quantize heights to layer-height multiples ("terracing"): every plateau
// lands exactly on a layer boundary, so the print gets crisp contour steps
// instead of ragged partial-layer slopes. Applied AFTER texture so the
// texture terraces too.
export function snapHeights(zMm, layerHeightMm) {
  if (!(layerHeightMm > 0)) return zMm;
  for (let i = 0; i < zMm.length; i++) {
    zMm[i] = Math.round(zMm[i] / layerHeightMm) * layerHeightMm;
  }
  return zMm;
}

// Build a closed, watertight solid from the heightfield: top surface at
// baseMm + z, flat bottom at z=0, vertical walls around the perimeter.
// Centered on XY origin. All faces wound outward (CCW seen from outside).
export function buildTerrainMesh(zMm, W, H, cellMm, baseMm) {
  const widthMm = (W - 1) * cellMm;
  const depthMm = (H - 1) * cellMm;
  const x0 = -widthMm / 2, y0 = -depthMm / 2;
  const vertCount = W * H * 2; // top grid + mirrored bottom grid
  const positions = new Float32Array(vertCount * 3);
  const bottomOffset = W * H;
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const i = iy * W + ix;
      const x = x0 + ix * cellMm, y = y0 + iy * cellMm;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = baseMm + zMm[i];
      const j = bottomOffset + i;
      positions[j * 3] = x;
      positions[j * 3 + 1] = y;
      positions[j * 3 + 2] = 0;
    }
  }

  const quadCount = (W - 1) * (H - 1);
  const wallQuadCount = 2 * (W - 1) + 2 * (H - 1);
  const faces = new Uint32Array((quadCount * 2 * 2 + wallQuadCount * 2) * 3);
  let fi = 0;
  const tri = (a, b, c) => { faces[fi++] = a; faces[fi++] = b; faces[fi++] = c; };

  for (let iy = 0; iy < H - 1; iy++) {
    for (let ix = 0; ix < W - 1; ix++) {
      const a = iy * W + ix, b = iy * W + ix + 1;
      const c = (iy + 1) * W + ix + 1, d = (iy + 1) * W + ix;
      // top: CCW seen from +z
      tri(a, b, c);
      tri(a, c, d);
      // bottom: reversed
      tri(bottomOffset + a, bottomOffset + c, bottomOffset + b);
      tri(bottomOffset + a, bottomOffset + d, bottomOffset + c);
    }
  }

  // Walls: for each directed boundary edge p->q of the top surface (in top
  // face winding order), the outward-facing wall is (qT,pT,pB),(qT,pB,qB).
  const wall = (p, q) => {
    tri(q, p, bottomOffset + p);
    tri(q, bottomOffset + p, bottomOffset + q);
  };
  for (let ix = 0; ix < W - 1; ix++) {
    wall(ix, ix + 1); // south edge, west->east
    wall((H - 1) * W + ix + 1, (H - 1) * W + ix); // north edge, east->west
  }
  for (let iy = 0; iy < H - 1; iy++) {
    wall(iy * W + W - 1, (iy + 1) * W + W - 1); // east edge, south->north
    wall((iy + 1) * W, iy * W); // west edge, north->south
  }

  return { positions, faces };
}

// Signed volume of a closed mesh (positive when faces wind outward).
// Used by tests and as a cheap orientation sanity check.
export function signedVolume(positions, faces) {
  let vol = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    vol +=
      (positions[a] * (positions[b + 1] * positions[c + 2] - positions[c + 1] * positions[b + 2]) -
        positions[b] * (positions[a + 1] * positions[c + 2] - positions[c + 1] * positions[a + 2]) +
        positions[c] * (positions[a + 1] * positions[b + 2] - positions[b + 1] * positions[a + 2])) / 6;
  }
  return vol;
}
