// Lattice worker: evaluate the part SDF on a grid, extract the isosurface,
// weld, and report mesh + stats. Off the main thread — generation takes
// seconds at fine voxel sizes.

import { makePartSDF, shapeBounds } from "./sdf.js";
import { meshField } from "./mtetra.js";
import { weld, countBoundaryEdges } from "../texture/mesh-core.js";
import { signedVolume } from "../terrain/terrain-core.js";

self.onmessage = (evt) => {
  const { params } = evt.data;
  try {
    post("status", "Sampling field + meshing…");
    const field = makePartSDF(params);
    const bounds = shapeBounds(params.shape);
    const soup = meshField(field, bounds, params.voxelMm);
    if (soup.length === 0) throw new Error("Empty result — check that wall/shell sizes are larger than the voxel size");

    post("status", "Welding…");
    const mesh = weld(soup);

    post("status", "Checking mesh…");
    const stats = {
      triCount: mesh.faces.length / 3,
      vertexCount: mesh.positions.length / 3,
      boundaryEdges: countBoundaryEdges(mesh.faces),
      volumeMm3: signedVolume(mesh.positions, mesh.faces),
    };
    self.postMessage(
      { kind: "done", positions: mesh.positions, faces: mesh.faces, stats },
      [mesh.positions.buffer, mesh.faces.buffer],
    );
  } catch (err) {
    self.postMessage({ kind: "error", message: err.message });
  }
};

function post(kind, message) {
  self.postMessage({ kind, message });
}
