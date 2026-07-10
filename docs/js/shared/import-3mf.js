// Minimal 3MF reader: unzips the package, finds the model XML, and extracts
// all object meshes as a triangle soup (Float32Array, 9 floats per tri —
// the same shape parseSTL produces, ready for mesh-core.weld()).
//
// v1 limitations (documented, acceptable for single-part maker files):
// component/build transforms are ignored and all objects are concatenated
// in model coordinates. Regex-based XML parsing (no DOMParser) so this runs
// in workers and node tests too.

import { unzipSync, strFromU8 } from "fflate";

export function parse3MF(arrayBuffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(arrayBuffer));
  } catch (err) {
    throw new Error(`Not a valid 3MF (zip) file: ${err.message}`);
  }
  const modelKey = Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!modelKey) throw new Error("No 3D model found inside the 3MF package");
  const xml = strFromU8(files[modelKey]);

  const out = [];
  const meshRe = /<mesh[\s>][\s\S]*?<\/mesh>/g;
  const vertexRe = /<vertex\s+([^>]*?)\/?>/g;
  const triangleRe = /<triangle\s+([^>]*?)\/?>/g;
  const attr = (s, name) => {
    const m = s.match(new RegExp(`${name}="([^"]+)"`));
    return m ? +m[1] : NaN;
  };

  let meshMatch;
  while ((meshMatch = meshRe.exec(xml)) !== null) {
    const block = meshMatch[0];
    const verts = [];
    let m;
    while ((m = vertexRe.exec(block)) !== null) {
      verts.push(attr(m[1], "x"), attr(m[1], "y"), attr(m[1], "z"));
    }
    while ((m = triangleRe.exec(block)) !== null) {
      const v1 = attr(m[1], "v1"), v2 = attr(m[1], "v2"), v3 = attr(m[1], "v3");
      for (const v of [v1, v2, v3]) {
        out.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
      }
    }
  }
  if (out.length === 0) throw new Error("3MF contained no triangles");
  const soup = new Float32Array(out);
  if (!soup.every(Number.isFinite)) throw new Error("3MF mesh contained invalid coordinates");
  return soup;
}
