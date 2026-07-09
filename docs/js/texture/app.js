// Mesh Texturizer UI: three.js viewport, paint-style region selection, and
// wiring to the bake worker. Geometry math lives in mesh-core.js; this file
// is DOM + rendering only.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { build3MF } from "../shared/export-3mf.js";
import { parseSTL, writeBinarySTL } from "./stl.js";
import { weld, floodFillSelection, countBoundaryEdges } from "./mesh-core.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// The working mesh is indexed (welded) and z-up in mm, like the STL. The
// render mesh is a non-indexed copy so selection can be colored per-face.

const state = {
  mesh: null, // { positions: Float32Array, faces: Uint32Array, faceSelected: Uint8Array }
  undoSnapshot: null,
  fileName: null,
  mode: "orbit", // orbit | smart | brush | erase
  smartAngleDeg: 30,
  brushRadiusMm: 6,
  seed: 42,
  image: null, // { width, height, data } for image texture
  imageName: null,
  baking: false,
};

// ---------------------------------------------------------------------------
// Viewport (mirrors the vase editor's look: same palette, grid, lighting)
// ---------------------------------------------------------------------------
const wrap = document.getElementById("viewport-wrap");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(180, 140, 220);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
wrap.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 40, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(150, 300, 150);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
fill.position.set(-150, 80, -100);
scene.add(fill);
scene.add(new THREE.GridHelper(400, 20, 0x333844, 0x22262e));

const material = new THREE.MeshStandardMaterial({
  metalness: 0.05,
  roughness: 0.5,
  vertexColors: true,
});

let renderMesh = null; // THREE.Mesh; rotated -90° X so the z-up model displays y-up

const BASE_COLOR = new THREE.Color(0x8fb7d8);
const SEL_COLOR = new THREE.Color(0xff9a5e);

function buildRenderMesh() {
  const { positions, faces } = state.mesh;
  const triCount = faces.length / 3;
  const pos = new Float32Array(triCount * 9);
  for (let i = 0; i < faces.length; i++) {
    const v = faces[i] * 3;
    pos[i * 3] = positions[v];
    pos[i * 3 + 1] = positions[v + 1];
    pos[i * 3 + 2] = positions[v + 2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(triCount * 9), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundsTree();
  if (renderMesh) {
    renderMesh.geometry.disposeBoundsTree();
    renderMesh.geometry.dispose();
    renderMesh.geometry = geometry;
  } else {
    renderMesh = new THREE.Mesh(geometry, material);
    renderMesh.rotation.x = -Math.PI / 2; // print z-up -> scene y-up
    scene.add(renderMesh);
  }
  refreshMeshInfo();
  updateSelectionColors();
  updateStats();
}

function updateSelectionColors() {
  if (!renderMesh || !state.mesh) return;
  const { faceSelected } = state.mesh;
  const colors = renderMesh.geometry.getAttribute("color");
  for (let f = 0; f < faceSelected.length; f++) {
    const c = faceSelected[f] ? SEL_COLOR : BASE_COLOR;
    for (let k = 0; k < 3; k++) colors.setXYZ(f * 3 + k, c.r, c.g, c.b);
  }
  colors.needsUpdate = true;
  updateButtons();
}

function fitCameraToMesh() {
  const { positions } = state.mesh;
  let maxR = 0, maxZ = 0;
  for (let i = 0; i < positions.length; i += 3) {
    maxR = Math.max(maxR, Math.hypot(positions[i], positions[i + 1]));
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const dist = Math.max(80, (maxR + maxZ) * 1.6);
  camera.position.set(dist, dist * 0.7, dist);
  controls.target.set(0, maxZ * 0.4, 0);
  controls.update();
}

function resizeRenderer() {
  const rect = wrap.getBoundingClientRect();
  const w = Math.max(10, rect.width);
  const h = Math.max(10, rect.height);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// STL import
// ---------------------------------------------------------------------------
function loadSTL(buffer, name) {
  let soup;
  try {
    soup = parseSTL(buffer);
  } catch (err) {
    alert(`Could not parse STL: ${err.message}`);
    return;
  }
  let mesh;
  try {
    mesh = weld(soup);
  } catch (err) {
    alert(err.message);
    return;
  }
  // Recenter: XY around origin, base on z=0, so it sits on the grid like a print.
  const { positions } = mesh;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= cx;
    positions[i + 1] -= cy;
    positions[i + 2] -= minZ;
  }
  state.mesh = { ...mesh, faceSelected: new Uint8Array(mesh.faces.length / 3) };
  state.undoSnapshot = null;
  state.fileName = name;
  document.getElementById("dropHint").style.display = "none";
  buildRenderMesh();
  fitCameraToMesh();
  setStatus("");
}

const importBtn = document.getElementById("importBtn");
const importInput = document.getElementById("importInput");
importBtn.addEventListener("click", () => importInput.click());
importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (file) loadSTL(await file.arrayBuffer(), file.name);
  importInput.value = "";
});

wrap.addEventListener("dragover", (evt) => evt.preventDefault());
wrap.addEventListener("drop", async (evt) => {
  evt.preventDefault();
  const file = [...evt.dataTransfer.files].find((f) => /\.stl$/i.test(f.name));
  if (file) loadSTL(await file.arrayBuffer(), file.name);
});

// ---------------------------------------------------------------------------
// Selection tools
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true; // bvh accelerated
const pointer = new THREE.Vector2();
let painting = false;
let brushDirty = false;
let lastBrushPoint = null;

function raycastAt(evt) {
  if (!renderMesh) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(renderMesh, false);
  return hits.length ? hits[0] : null;
}

function brushAt(hit, value) {
  // Hit point in mesh-local (z-up) space; select faces whose centroid is in range.
  const local = renderMesh.worldToLocal(hit.point.clone());
  const { positions, faces, faceSelected } = state.mesh;
  const r2 = state.brushRadiusMm * state.brushRadiusMm;
  for (let f = 0; f < faceSelected.length; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const dx = (positions[a] + positions[b] + positions[c]) / 3 - local.x;
    const dy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 - local.y;
    const dz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 - local.z;
    if (dx * dx + dy * dy + dz * dz <= r2) faceSelected[f] = value;
  }
  brushDirty = true;
  requestAnimationFrame(() => {
    if (brushDirty) { brushDirty = false; updateSelectionColors(); }
  });
}

renderer.domElement.addEventListener("pointerdown", (evt) => {
  if (evt.button !== 0 || state.mode === "orbit" || state.baking) return;
  const hit = raycastAt(evt);
  if (!hit) return;
  if (state.mode === "smart") {
    floodFillSelection(
      state.mesh.positions, state.mesh.faces, state.mesh.faceSelected,
      hit.faceIndex, state.smartAngleDeg, evt.shiftKey ? 0 : 1,
    );
    updateSelectionColors();
  } else {
    painting = true;
    renderer.domElement.setPointerCapture(evt.pointerId);
    brushAt(hit, state.mode === "erase" ? 0 : 1);
  }
});

renderer.domElement.addEventListener("pointermove", (evt) => {
  if (!painting) return;
  const hit = raycastAt(evt);
  if (hit) brushAt(hit, state.mode === "erase" ? 0 : 1);
});

renderer.domElement.addEventListener("pointerup", () => { painting = false; });
renderer.domElement.addEventListener("pointercancel", () => { painting = false; });

const modeButtons = {
  orbit: document.getElementById("modeOrbit"),
  smart: document.getElementById("modeSmart"),
  brush: document.getElementById("modeBrush"),
  erase: document.getElementById("modeErase"),
};
function setMode(mode) {
  state.mode = mode;
  for (const [name, btn] of Object.entries(modeButtons)) {
    btn.classList.toggle("on", name === mode);
  }
  // In paint modes the left button paints; orbit stays on right/middle.
  controls.mouseButtons.LEFT = mode === "orbit" ? THREE.MOUSE.ROTATE : -1;
  renderer.domElement.style.cursor = mode === "orbit" ? "default" : "crosshair";
}
for (const [name, btn] of Object.entries(modeButtons)) {
  btn.addEventListener("click", () => setMode(name));
}

const angleSlider = document.getElementById("angleSlider");
const angleValue = document.getElementById("angleValue");
angleSlider.addEventListener("input", () => {
  state.smartAngleDeg = +angleSlider.value;
  angleValue.textContent = `${state.smartAngleDeg}°`;
});

const brushSlider = document.getElementById("brushSlider");
const brushValue = document.getElementById("brushValue");
brushSlider.addEventListener("input", () => {
  state.brushRadiusMm = +brushSlider.value;
  brushValue.textContent = `${state.brushRadiusMm} mm`;
});

document.getElementById("selectAllBtn").addEventListener("click", () => {
  if (!state.mesh) return;
  state.mesh.faceSelected.fill(1);
  updateSelectionColors();
});
document.getElementById("clearSelBtn").addEventListener("click", () => {
  if (!state.mesh) return;
  state.mesh.faceSelected.fill(0);
  updateSelectionColors();
});

// ---------------------------------------------------------------------------
// Texture params + bake
// ---------------------------------------------------------------------------
const textureType = document.getElementById("textureType");
const imageBtn = document.getElementById("imageBtn");
const imageInput = document.getElementById("imageInput");
const mappingType = document.getElementById("mappingType");
const mappingAxis = document.getElementById("mappingAxis");
const scaleInput = document.getElementById("scaleInput");
const depthInput = document.getElementById("depthInput");
const directionSelect = document.getElementById("directionSelect");
const resolutionInput = document.getElementById("resolutionInput");
const bakeBtn = document.getElementById("bakeBtn");
const undoBtn = document.getElementById("undoBtn");
const exportStlBtn = document.getElementById("exportStlBtn");
const export3mfBtn = document.getElementById("export3mfBtn");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");

textureType.addEventListener("change", () => {
  const isImage = textureType.value === "image";
  imageBtn.disabled = !isImage;
  mappingType.disabled = !isImage;
  mappingAxis.disabled = !isImage;
  updateButtons();
});

imageBtn.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  state.image = { width: data.width, height: data.height, data: data.data };
  state.imageName = file.name;
  imageBtn.textContent = file.name.length > 18 ? file.name.slice(0, 15) + "…" : file.name;
  imageInput.value = "";
  updateButtons();
});

document.getElementById("rerollBtn").addEventListener("click", () => {
  state.seed = Math.floor(Math.random() * 1e9);
  setStatus(`Seed ${state.seed} — bake to apply`);
});

const worker = new Worker(new URL("./bake-worker.js", import.meta.url), { type: "module" });
worker.onmessage = (evt) => {
  const msg = evt.data;
  if (msg.kind === "status") { setStatus(msg.message); return; }
  state.baking = false;
  if (msg.kind === "error") {
    setStatus(`Bake failed: ${msg.message}`);
    updateButtons();
    return;
  }
  state.mesh = {
    positions: msg.positions,
    faces: msg.faces,
    faceSelected: msg.faceSelected,
  };
  buildRenderMesh();
  const wt = msg.stats.boundaryEdges === 0 ? "watertight" : `⚠ ${msg.stats.boundaryEdges} boundary edges`;
  setStatus(`Baked: ${msg.stats.triCount.toLocaleString()} tris, ${wt}`);
};

bakeBtn.addEventListener("click", () => {
  if (!state.mesh || state.baking) return;
  const selCount = state.mesh.faceSelected.reduce((a, b) => a + b, 0);
  if (selCount === 0) { setStatus("Nothing selected — paint a region first"); return; }
  if (textureType.value === "image" && !state.image) { setStatus("Choose an image first"); return; }

  state.undoSnapshot = {
    positions: state.mesh.positions.slice(),
    faces: state.mesh.faces.slice(),
    faceSelected: state.mesh.faceSelected.slice(),
  };
  state.baking = true;
  updateButtons();
  setStatus("Baking…");

  const payload = {
    positions: state.mesh.positions,
    faces: state.mesh.faces,
    faceSelected: state.mesh.faceSelected,
    params: {
      textureType: textureType.value,
      seed: state.seed,
      scaleMm: clampNum(scaleInput, 0.5, 100, 4),
      depthMm: clampNum(depthInput, 0.05, 10, 0.8),
      bias: +directionSelect.value,
      resolutionMm: clampNum(resolutionInput, 0.2, 5, 0.6),
      mapping: { type: mappingType.value, axis: mappingAxis.value },
    },
    image: textureType.value === "image" ? state.image : null,
  };
  worker.postMessage(payload, [payload.positions.buffer, payload.faces.buffer, payload.faceSelected.buffer]);
  // Buffers were transferred; keep a usable copy locally until the bake returns.
  state.mesh = {
    positions: state.undoSnapshot.positions.slice(),
    faces: state.undoSnapshot.faces.slice(),
    faceSelected: state.undoSnapshot.faceSelected.slice(),
  };
});

undoBtn.addEventListener("click", () => {
  if (!state.undoSnapshot || state.baking) return;
  state.mesh = state.undoSnapshot;
  state.undoSnapshot = null;
  buildRenderMesh();
  setStatus("Reverted to pre-bake mesh");
});

function clampNum(input, min, max, fallback) {
  const v = +input.value;
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function download(buffer, name, type) {
  const blob = new Blob([buffer], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportName(ext) {
  const base = (state.fileName || "mesh").replace(/\.stl$/i, "");
  return `${base}-textured.${ext}`;
}

exportStlBtn.addEventListener("click", () => {
  if (!state.mesh) return;
  download(writeBinarySTL(state.mesh.positions, state.mesh.faces), exportName("stl"), "model/stl");
});

export3mfBtn.addEventListener("click", () => {
  if (!state.mesh) return;
  download(build3MF(state.mesh.positions, state.mesh.faces), exportName("3mf"), "model/3mf");
});

// ---------------------------------------------------------------------------
// Stats / status
// ---------------------------------------------------------------------------
function setStatus(text) {
  statusEl.textContent = text;
}

// Boundary count and dimensions are O(mesh) to compute, so they're cached
// here on mesh change; updateStats (which runs on every brush frame for the
// selection count) only does a cheap flag scan.
function refreshMeshInfo() {
  const { positions, faces } = state.mesh;
  let maxX = 0, maxY = 0, maxZ = 0;
  for (let i = 0; i < positions.length; i += 3) {
    maxX = Math.max(maxX, Math.abs(positions[i]) * 2);
    maxY = Math.max(maxY, Math.abs(positions[i + 1]) * 2);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  state.meshInfo = { maxX, maxY, maxZ, boundary: countBoundaryEdges(faces) };
}

function updateStats() {
  if (!state.mesh || !state.meshInfo) { statsEl.textContent = ""; return; }
  const { positions, faces, faceSelected } = state.mesh;
  const { maxX, maxY, maxZ, boundary } = state.meshInfo;
  const selCount = faceSelected.reduce((a, b) => a + b, 0);
  statsEl.textContent = [
    `${state.fileName || ""}`,
    `${(faces.length / 3).toLocaleString()} tris · ${(positions.length / 3).toLocaleString()} verts · ${maxX.toFixed(0)}×${maxY.toFixed(0)}×${maxZ.toFixed(0)} mm`,
    boundary === 0 ? "watertight" : `⚠ ${boundary} boundary edges (may not slice cleanly)`,
    selCount ? `${selCount.toLocaleString()} faces selected` : "no selection",
  ].filter(Boolean).join("\n");
}

function updateButtons() {
  const has = !!state.mesh && !state.baking;
  bakeBtn.disabled = !has;
  exportStlBtn.disabled = !has;
  export3mfBtn.disabled = !has;
  undoBtn.disabled = !state.undoSnapshot || state.baking;
  if (state.mesh) updateStats();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("resize", resizeRenderer);
resizeRenderer();
setMode("orbit");
updateButtons();
animate();
