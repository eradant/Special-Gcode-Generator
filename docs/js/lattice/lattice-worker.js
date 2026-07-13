// Lattice worker: evaluate the part SDF on a grid, extract the isosurface,
// weld, and report mesh + stats. Off the main thread — generation takes
// seconds at fine voxel sizes.

import { makeShapeSDF, composePartSDF, shapeBounds, makeWallField } from "./sdf.js";
import { buildImportedSDF } from "./voxelize.js";
import { meshField } from "./mtetra.js";
import { weld, countBoundaryEdges } from "../texture/mesh-core.js";
import { signedVolume } from "../terrain/terrain-core.js";

// Grading counts as active only if some source can actually raise the wall
// above its base value.
function gradingActive(g) {
  return !!g && g.wallMaxMm > g.wallMm &&
    (g.surfaceBias > 0 || g.zGradient !== 0 || (g.emphasis && g.emphasis.length > 0));
}

self.onmessage = (evt) => {
  const { params, imported } = evt.data;
  try {
    let shapeF, bounds, solidVolumeMm3 = null;
    if (imported) {
      post("status", "Voxelizing imported part…");
      solidVolumeMm3 = signedVolume(imported.positions, imported.faces);
      const built = buildImportedSDF(imported.positions, imported.faces, params.voxelMm);
      bounds = built.bounds;
      shapeF = built.sdf;
    } else {
      shapeF = makeShapeSDF(params.shape);
      bounds = shapeBounds(params.shape);
    }

    let wallFn = null;
    if (params.latticeType !== "none" && gradingActive(params.grading)) {
      wallFn = makeWallField(params.grading, shapeF, bounds.min[2], bounds.max[2]);
    }
    const field = composePartSDF(shapeF, bounds.min[2], bounds.max[2], { ...params, wallFn });

    post("status", "Sampling field + meshing…");
    const soup = meshField(field, bounds, params.voxelMm);
    if (soup.length === 0) throw new Error("Empty result — check that wall/shell sizes are larger than the voxel size");

    post("status", "Welding…");
    const mesh = weld(soup);

    // Per-vertex wall thickness for the field-visualization coloring.
    let wallViz = null;
    if (wallFn) {
      wallViz = new Float32Array(mesh.positions.length / 3);
      for (let v = 0; v < wallViz.length; v++) {
        wallViz[v] = wallFn(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      }
    }

    post("status", "Checking mesh…");
    const stats = {
      triCount: mesh.faces.length / 3,
      vertexCount: mesh.positions.length / 3,
      boundaryEdges: countBoundaryEdges(mesh.faces),
      volumeMm3: signedVolume(mesh.positions, mesh.faces),
      solidVolumeMm3, // original part volume when generating from an import
    };
    const transfer = [mesh.positions.buffer, mesh.faces.buffer];
    if (wallViz) transfer.push(wallViz.buffer);
    self.postMessage(
      { kind: "done", positions: mesh.positions, faces: mesh.faces, wallViz, stats },
      transfer,
    );
  } catch (err) {
    self.postMessage({ kind: "error", message: err.message });
  }
};

function post(kind, message) {
  self.postMessage({ kind, message });
}
