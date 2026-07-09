// Bake worker: refine selected region -> build displacement sampler ->
// displace -> report. Runs off the main thread so multi-hundred-k-triangle
// bakes don't freeze the UI. Pure module worker (no three.js).

import { refineSelection, computeVertexMask, displaceVertices, countBoundaryEdges } from "./mesh-core.js";
import { makeNoiseSampler } from "./noise.js";
import { makeImageSampler, computeBounds } from "./image-sampler.js";

self.onmessage = (evt) => {
  const { positions, faces, faceSelected, params, image } = evt.data;
  try {
    post("status", "Refining selected region…");
    const refined = refineSelection(positions, faces, faceSelected, params.resolutionMm);

    post("status", "Displacing…");
    const bounds = computeBounds(refined.positions);
    const sampleFn = params.textureType === "image"
      ? makeImageSampler(image, params.mapping, params.scaleMm, bounds)
      : makeNoiseSampler(params.textureType, params.seed, params.scaleMm);

    const mask = computeVertexMask(refined.positions.length / 3, refined.faces, refined.faceSelected);
    const displaced = displaceVertices(refined.positions, refined.faces, mask, sampleFn, params.depthMm, params.bias);

    post("status", "Checking mesh…");
    const boundaryEdges = countBoundaryEdges(refined.faces);

    self.postMessage(
      {
        kind: "done",
        positions: displaced,
        faces: refined.faces,
        faceSelected: refined.faceSelected,
        stats: {
          triCount: refined.faces.length / 3,
          vertexCount: displaced.length / 3,
          boundaryEdges,
        },
      },
      [displaced.buffer, refined.faces.buffer, refined.faceSelected.buffer],
    );
  } catch (err) {
    self.postMessage({ kind: "error", message: err.message });
  }
};

function post(kind, message) {
  self.postMessage({ kind, message });
}
