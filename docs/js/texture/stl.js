// STL read/write. Pure functions over ArrayBuffers/typed arrays — no DOM, no
// three.js — so this module runs in the bake worker and in node tests.

// Parse binary or ASCII STL into a non-indexed position soup
// (Float32Array, 9 floats per triangle). Normals in the file are ignored;
// they're recomputed from geometry wherever needed.
export function parseSTL(buffer) {
  if (isBinarySTL(buffer)) return parseBinarySTL(buffer);
  return parseAsciiSTL(buffer);
}

function isBinarySTL(buffer) {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  // A well-formed binary STL is exactly header + 50 bytes per triangle.
  if (buffer.byteLength === 84 + triCount * 50) return true;
  // Fall back to sniffing for ASCII keywords near the start.
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)));
  return !/^\s*solid[\s\S]*facet/i.test(head);
}

function parseBinarySTL(buffer) {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    offset += 12; // skip stored normal
    for (let i = 0; i < 9; i++) {
      positions[t * 9 + i] = view.getFloat32(offset, true);
      offset += 4;
    }
    offset += 2; // attribute byte count
  }
  return positions;
}

function parseAsciiSTL(buffer) {
  const text = new TextDecoder().decode(buffer);
  const out = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(+m[1], +m[2], +m[3]);
  }
  if (out.length === 0 || out.length % 9 !== 0) {
    throw new Error(`ASCII STL parse failed: ${out.length} vertex coords (expected multiple of 9)`);
  }
  return new Float32Array(out);
}

// Write a binary STL from an indexed mesh. Face normals are computed from
// the triangle winding (right-hand rule), which slicers expect.
export function writeBinarySTL(positions, faces) {
  const triCount = Math.floor(faces.length / 3);
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = "textured mesh - Special-Gcode-Generator";
  for (let i = 0; i < header.length && i < 80; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triCount, true);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(offset, nx, true); offset += 4;
    view.setFloat32(offset, ny, true); offset += 4;
    view.setFloat32(offset, nz, true); offset += 4;
    for (const idx of [a, b, c]) {
      view.setFloat32(offset, positions[idx], true); offset += 4;
      view.setFloat32(offset, positions[idx + 1], true); offset += 4;
      view.setFloat32(offset, positions[idx + 2], true); offset += 4;
    }
    view.setUint16(offset, 0, true); offset += 2;
  }
  return buffer;
}
