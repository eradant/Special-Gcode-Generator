// Mesh geometry core for the texturizer: weld, adjacency, smart-select flood
// fill, conforming longest-edge-bisection refinement, and normal displacement.
// Pure typed-array functions — no three.js, no DOM — shared by the main
// thread, the bake worker, and node tests.

// Vertex index limit imposed by the numeric edge key (min * 2^32 + max must
// stay under 2^53). ~2M vertices is far beyond what the browser UI handles.
export const MAX_VERTICES = 1 << 21;

// Weld a non-indexed position soup (9 floats per tri) into an indexed mesh,
// merging vertices within `tolerance` mm and dropping degenerate triangles.
export function weld(soup, tolerance = 1e-4) {
  const inv = 1 / tolerance;
  const map = new Map();
  const outPos = [];
  const faceList = [];
  let next = 0;
  const cornerIdx = new Array(3);
  for (let c = 0; c < soup.length; c += 9) {
    for (let k = 0; k < 3; k++) {
      const x = soup[c + k * 3], y = soup[c + k * 3 + 1], z = soup[c + k * 3 + 2];
      const key = `${Math.round(x * inv)}_${Math.round(y * inv)}_${Math.round(z * inv)}`;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = next++;
        map.set(key, idx);
        outPos.push(x, y, z);
      }
      cornerIdx[k] = idx;
    }
    const [a, b, cc] = cornerIdx;
    if (a !== b && b !== cc && a !== cc) faceList.push(a, b, cc);
  }
  if (next > MAX_VERTICES) throw new Error(`Mesh too large: ${next} vertices (max ${MAX_VERTICES})`);
  return { positions: new Float32Array(outPos), faces: new Uint32Array(faceList) };
}

function edgeKey(a, b) {
  return a < b ? a * 0x100000000 + b : b * 0x100000000 + a;
}

// Map of edgeKey -> array of adjacent face indices.
export function buildEdgeMap(faces) {
  const edges = new Map();
  const faceCount = faces.length / 3;
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(faces[f * 3 + e], faces[f * 3 + ((e + 1) % 3)]);
      const list = edges.get(key);
      if (list) list.push(f); else edges.set(key, [f]);
    }
  }
  return edges;
}

// Edges not shared by exactly 2 faces — 0 means watertight/manifold edges.
export function countBoundaryEdges(faces) {
  let count = 0;
  for (const list of buildEdgeMap(faces).values()) {
    if (list.length !== 2) count++;
  }
  return count;
}

export function computeFaceNormals(positions, faces) {
  const faceCount = faces.length / 3;
  const normals = new Float32Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[f * 3] = nx / len;
    normals[f * 3 + 1] = ny / len;
    normals[f * 3 + 2] = nz / len;
  }
  return normals;
}

// Area-weighted smooth vertex normals (cross products accumulate unnormalized,
// so larger faces weigh more — the usual choice for displacement direction).
export function computeVertexNormals(positions, faces) {
  const normals = new Float32Array(positions.length);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      normals[i] += nx; normals[i + 1] += ny; normals[i + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
}

// Smart select: BFS across shared edges, continuing while the crossing is
// smooth (neighbor-to-neighbor normal angle <= angleDeg), so selection flows
// around curved surfaces but stops at creases. Sets faceSelected in place
// (value = 1 to select, 0 for erase-fill).
export function floodFillSelection(positions, faces, faceSelected, startFace, angleDeg, value = 1) {
  const faceNormals = computeFaceNormals(positions, faces);
  const edges = buildEdgeMap(faces);
  const cosThreshold = Math.cos((angleDeg * Math.PI) / 180);
  const visited = new Uint8Array(faces.length / 3);
  const queue = [startFace];
  visited[startFace] = 1;
  while (queue.length) {
    const f = queue.pop();
    faceSelected[f] = value;
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(faces[f * 3 + e], faces[f * 3 + ((e + 1) % 3)]);
      for (const nf of edges.get(key)) {
        if (visited[nf]) continue;
        const dot =
          faceNormals[f * 3] * faceNormals[nf * 3] +
          faceNormals[f * 3 + 1] * faceNormals[nf * 3 + 1] +
          faceNormals[f * 3 + 2] * faceNormals[nf * 3 + 2];
        if (dot >= cosThreshold) {
          visited[nf] = 1;
          queue.push(nf);
        }
      }
    }
  }
}

// Conforming refinement by longest-edge bisection. Every split edge splits
// ALL faces adjacent to it (selected or not), so no T-junctions are ever
// created and the mesh stays watertight. Runs in passes: each pass splits an
// independent set of the longest over-length edges (at most one split per
// face per pass), then rebuilds adjacency. Child faces inherit selection.
export function refineSelection(positions, faces, faceSelected, maxEdgeLen, maxFaces = 2_000_000) {
  let pos = Array.from(positions);
  let f = Array.from(faces);
  let sel = Array.from(faceSelected);
  const maxLenSq = maxEdgeLen * maxEdgeLen;

  for (let pass = 0; pass < 64; pass++) {
    const faceCount = f.length / 3;
    if (faceCount >= maxFaces) break;
    const edges = buildEdgeMap(new Uint32Array(f));

    // Candidate edges: longer than target and touching at least one selected face.
    const candidates = [];
    for (const [key, faceList] of edges) {
      if (!faceList.some((fi) => sel[fi])) continue;
      const a = Math.floor(key / 0x100000000), b = key % 0x100000000;
      const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
      const lenSq = dx * dx + dy * dy + dz * dz;
      if (lenSq > maxLenSq) candidates.push({ key, a, b, faceList, lenSq });
    }
    if (candidates.length === 0) break;
    candidates.sort((x, y) => y.lenSq - x.lenSq);

    // Independent set: at most one split edge per face this pass.
    const faceLocked = new Uint8Array(faceCount);
    const splitOfFace = new Map(); // face index -> accepted edge
    const midOfEdge = new Map(); // edge key -> new vertex index
    for (const cand of candidates) {
      if (cand.faceList.some((fi) => faceLocked[fi])) continue;
      const mid = pos.length / 3;
      pos.push(
        (pos[cand.a * 3] + pos[cand.b * 3]) / 2,
        (pos[cand.a * 3 + 1] + pos[cand.b * 3 + 1]) / 2,
        (pos[cand.a * 3 + 2] + pos[cand.b * 3 + 2]) / 2,
      );
      midOfEdge.set(cand.key, mid);
      for (const fi of cand.faceList) {
        faceLocked[fi] = 1;
        splitOfFace.set(fi, cand.key);
      }
    }
    if (pos.length / 3 > MAX_VERTICES) throw new Error("Refinement exceeded vertex limit — raise the resolution value");

    const newFaces = [];
    const newSel = [];
    for (let fi = 0; fi < faceCount; fi++) {
      const v0 = f[fi * 3], v1 = f[fi * 3 + 1], v2 = f[fi * 3 + 2];
      const key = splitOfFace.get(fi);
      if (key === undefined) {
        newFaces.push(v0, v1, v2);
        newSel.push(sel[fi]);
        continue;
      }
      const mid = midOfEdge.get(key);
      // Find which of the three edges is being split; children keep winding.
      if (edgeKey(v0, v1) === key) newFaces.push(v0, mid, v2, mid, v1, v2);
      else if (edgeKey(v1, v2) === key) newFaces.push(v1, mid, v0, mid, v2, v0);
      else newFaces.push(v2, mid, v1, mid, v0, v1);
      newSel.push(sel[fi], sel[fi]);
    }
    f = newFaces;
    sel = newSel;
  }

  return {
    positions: new Float32Array(pos),
    faces: new Uint32Array(f),
    faceSelected: new Uint8Array(sel),
  };
}

// Per-vertex displacement mask: 1 only where every adjacent face is selected.
// Vertices on the selection boundary stay at 0, so unselected geometry is
// untouched and the texture tapers to zero over exactly one edge ring.
export function computeVertexMask(vertexCount, faces, faceSelected) {
  const mask = new Uint8Array(vertexCount).fill(1);
  const touched = new Uint8Array(vertexCount);
  for (let f = 0; f < faces.length / 3; f++) {
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k];
      touched[v] = 1;
      if (!faceSelected[f]) mask[v] = 0;
    }
  }
  for (let v = 0; v < vertexCount; v++) if (!touched[v]) mask[v] = 0;
  return mask;
}

// Displace masked vertices along their smooth normals.
// sampleFn(x, y, z) must return a value in [0, 1]; `bias` shifts it so
// 0 = emboss only (outward), 1 = engrave only (inward), 0.5 = centered.
export function displaceVertices(positions, faces, mask, sampleFn, depthMm, bias) {
  const normals = computeVertexNormals(positions, faces);
  const out = new Float32Array(positions);
  for (let v = 0; v < positions.length / 3; v++) {
    if (!mask[v]) continue;
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const d = depthMm * (sampleFn(x, y, z) - bias);
    out[v * 3] = x + normals[v * 3] * d;
    out[v * 3 + 1] = y + normals[v * 3 + 1] * d;
    out[v * 3 + 2] = z + normals[v * 3 + 2] * d;
  }
  return out;
}
