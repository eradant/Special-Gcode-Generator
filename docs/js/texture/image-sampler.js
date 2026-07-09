// Greyscale image displacement sampler with tiling + bilinear filtering.
// Pure functions (no DOM) so the bake worker and node tests share them.
//
// mapping.type: "planar" (project along axis) | "cylindrical" | "spherical",
// wrapped around mapping.axis through the mesh bounding-box center.
// scaleMm = size of one image tile on the surface. Returns f(x,y,z) -> [0,1].

export function computeBounds(positions) {
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

export function makeImageSampler(image, mapping, scaleMm, bounds) {
  const { width, height, data } = image; // RGBA bytes
  const luminanceAt = (px, py) => {
    const i = (py * width + px) * 4;
    return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  };
  const sampleUV = (u, v) => {
    // tile-wrap, bilinear
    let fx = (((u % 1) + 1) % 1) * (width - 1);
    let fy = (((v % 1) + 1) % 1) * (height - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    fx -= x0; fy -= y0;
    return (
      luminanceAt(x0, y0) * (1 - fx) * (1 - fy) +
      luminanceAt(x1, y0) * fx * (1 - fy) +
      luminanceAt(x0, y1) * (1 - fx) * fy +
      luminanceAt(x1, y1) * fx * fy
    );
  };

  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const axis = mapping.axis || "z";
  // Remap so `a` is along the mapping axis and (b, c) span the plane around it.
  const remap = axis === "x"
    ? (x, y, z) => [x - cx, y - cy, z - cz]
    : axis === "y"
      ? (x, y, z) => [y - cy, z - cz, x - cx]
      : (x, y, z) => [z - cz, x - cx, y - cy];

  const sizes = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  const avgRadius = Math.max(1e-6, (sizes[0] + sizes[1] + sizes[2]) / 3 / 2);
  // Sizes in remapped (a, b, c) order, so UVs can anchor at the model's min
  // corner instead of wrapping at the world origin — makes tile placement
  // predictable regardless of where the model sits.
  const remappedSizes = axis === "x"
    ? [sizes[0], sizes[1], sizes[2]]
    : axis === "y"
      ? [sizes[1], sizes[2], sizes[0]]
      : [sizes[2], sizes[0], sizes[1]];
  const aOff = remappedSizes[0] / 2, bOff = remappedSizes[1] / 2, cOff = remappedSizes[2] / 2;

  if (mapping.type === "cylindrical") {
    // Integer repeat count around the circumference so the tile seam matches.
    const repeats = Math.max(1, Math.round((2 * Math.PI * avgRadius) / scaleMm));
    return (x, y, z) => {
      const [a, b, c] = remap(x, y, z);
      const theta = Math.atan2(c, b) / (2 * Math.PI) + 0.5;
      return sampleUV(theta * repeats, (a + aOff) / scaleMm);
    };
  }
  if (mapping.type === "spherical") {
    const repeats = Math.max(1, Math.round((2 * Math.PI * avgRadius) / scaleMm));
    const repeatsV = Math.max(1, Math.round((Math.PI * avgRadius) / scaleMm));
    return (x, y, z) => {
      const [a, b, c] = remap(x, y, z);
      const r = Math.hypot(a, b, c) || 1e-9;
      const theta = Math.atan2(c, b) / (2 * Math.PI) + 0.5;
      const phi = Math.acos(Math.max(-1, Math.min(1, a / r))) / Math.PI;
      return sampleUV(theta * repeats, phi * repeatsV);
    };
  }
  // planar: project along the axis onto the (b, c) plane
  return (x, y, z) => {
    const [, b, c] = remap(x, y, z);
    return sampleUV((b + bOff) / scaleMm, (c + cOff) / scaleMm);
  };
}
