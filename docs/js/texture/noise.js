// Seedable 3D procedural noise for texture displacement. All samplers map
// world position -> [0, 1]. The four types mirror OrcaSlicer's fuzzy-skin
// noise menu (Perlin-style fBM, Billow, Ridged, Voronoi) so results feel
// familiar to slicer users. 3D noise needs no UV mapping — it just samples
// at the vertex position, which is what makes it robust on arbitrary meshes.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simplex noise 3D (Gustavson's public-domain reference, seedable), in [-1,1].
function makeSimplex3D(seed) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  const grad3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  ]);
  const F3 = 1 / 3, G3 = 1 / 6;

  return (xin, yin, zin) => {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const gi = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (grad3[gi] * x0 + grad3[gi + 1] * y0 + grad3[gi + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const gi = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (grad3[gi] * x1 + grad3[gi + 1] * y1 + grad3[gi + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const gi = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (grad3[gi] * x2 + grad3[gi + 1] * y2 + grad3[gi + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const gi = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (grad3[gi] * x3 + grad3[gi + 1] * y3 + grad3[gi + 2] * z3);
    }
    return 32 * n;
  };
}

// Fractal Brownian motion over simplex, still roughly [-1,1].
function makeFBM(seed, octaves = 3, lacunarity = 2, gain = 0.5) {
  const noise = makeSimplex3D(seed);
  let ampSum = 0;
  for (let o = 0, a = 1; o < octaves; o++, a *= gain) ampSum += a;
  return (x, y, z) => {
    let sum = 0, amp = 1, freq = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / ampSum;
  };
}

// 3D cellular (Voronoi) F1 distance, normalized to [0,1].
function makeVoronoi3D(seed) {
  const base = seed >>> 0;
  const hash = (ix, iy, iz, salt) => {
    let h = base ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ Math.imul(salt, 144665);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let f1 = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cx = ix + dx, cy = iy + dy, cz = iz + dz;
          const px = cx + hash(cx, cy, cz, 1);
          const py = cy + hash(cx, cy, cz, 2);
          const pz = cz + hash(cx, cy, cz, 3);
          const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
          if (d < f1) f1 = d;
        }
      }
    }
    return Math.min(1, Math.sqrt(f1));
  };
}

// type: "perlin" | "billow" | "ridged" | "voronoi"
// scaleMm sets the feature size; sampler input is world position in mm.
export function makeNoiseSampler(type, seed, scaleMm) {
  const s = 1 / Math.max(1e-6, scaleMm);
  switch (type) {
    case "billow": {
      const fbm = makeFBM(seed);
      return (x, y, z) => Math.min(1, Math.abs(fbm(x * s, y * s, z * s)) * 1.6);
    }
    case "ridged": {
      const fbm = makeFBM(seed);
      return (x, y, z) => Math.max(0, 1 - Math.abs(fbm(x * s, y * s, z * s)) * 1.6);
    }
    case "voronoi": {
      const vor = makeVoronoi3D(seed);
      return (x, y, z) => vor(x * s, y * s, z * s);
    }
    case "perlin":
    default: {
      const fbm = makeFBM(seed);
      return (x, y, z) => Math.min(1, Math.max(0, fbm(x * s, y * s, z * s) * 0.75 + 0.5));
    }
  }
}
