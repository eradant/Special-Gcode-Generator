// Minimal 3MF writer shared by the mesh tools. Produces a zip (via fflate)
// with the core-spec model XML — enough for Bambu Studio / OrcaSlicer import.

import { zipSync, strToU8 } from "fflate";

// positions: Float32Array (mm), faces: Uint32Array. Returns a Uint8Array zip.
export function build3MF(positions, faces) {
  const verts = [];
  for (let i = 0; i < positions.length; i += 3) {
    verts.push(`<vertex x="${positions[i]}" y="${positions[i + 1]}" z="${positions[i + 2]}"/>`);
  }
  const tris = [];
  for (let i = 0; i < faces.length; i += 3) {
    tris.push(`<triangle v1="${faces[i]}" v2="${faces[i + 1]}" v3="${faces[i + 2]}"/>`);
  }
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    `<resources><object id="1" type="model"><mesh>\n` +
    `<vertices>${verts.join("")}</vertices>\n` +
    `<triangles>${tris.join("")}</triangles>\n` +
    `</mesh></object></resources>\n` +
    `<build><item objectid="1"/></build>\n</model>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "3D/3dmodel.model": strToU8(model),
  });
}
