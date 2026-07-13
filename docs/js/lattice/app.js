// Generative Lattice UI: parameter panel, worker-driven generation, preview,
// and STL/3MF export. Geometry math lives in sdf.js / mtetra.js.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { shapeSolidVolume } from "./sdf.js";
import { MAX_VOXEL_CELLS, meshBounds } from "./voxelize.js";
import { parseSTL, writeBinarySTL } from "../texture/stl.js";
import { weld } from "../texture/mesh-core.js";
import { build3MF } from "../shared/export-3mf.js";
import { parse3MF } from "../shared/import-3mf.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const PLA_DENSITY_G_CM3 = 1.24;

const state = {
  mesh: null, // { positions, faces } — generated result
  imported: null, // { positions, faces, name } — loaded part (z-floored, XY-centered)
  wallViz: null, // per-vertex wall thickness (mm) when grading was active
  emphasis: [], // density attractors: { x, y, z, radius } in print space
  emphasisMode: false,
  stats: null,
  generating: false,
  lastParams: null,
};

// ---------------------------------------------------------------------------
// Viewport (same shell as the other tools)
// ---------------------------------------------------------------------------
const wrap = document.getElementById("viewport-wrap");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(120, 100, 140);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
wrap.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 15, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(150, 300, 150);
scene.add(key);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.35);
fillLight.position.set(-150, 80, -100);
scene.add(fillLight);
scene.add(new THREE.GridHelper(400, 20, 0x333844, 0x22262e));

const material = new THREE.MeshStandardMaterial({
  metalness: 0.05,
  roughness: 0.5,
  flatShading: true,
  vertexColors: true,
});

let latticeMesh = null;

// Marker root shares the print-space -> scene transform so emphasis markers
// can live at print coordinates directly.
const markerRoot = new THREE.Object3D();
markerRoot.rotation.x = -Math.PI / 2;
scene.add(markerRoot);

const BASE_COLOR = new THREE.Color(0x5eb4ff);
const THIN_COLOR = new THREE.Color(0x3a6ea5);
const THICK_COLOR = new THREE.Color(0xff9a5e);

// Uniform base color normally; when the worker returned a wall-thickness
// field, color thin->thick as blue->orange (the nTop-style field readout).
function buildVertexColors(vertexCount) {
  const colors = new Float32Array(vertexCount * 3);
  const viz = state.wallViz;
  let lo = Infinity, hi = -Infinity;
  if (viz) {
    for (const v of viz) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const graded = viz && hi - lo > 1e-6;
  const tmp = new THREE.Color();
  for (let v = 0; v < vertexCount; v++) {
    if (graded) tmp.lerpColors(THIN_COLOR, THICK_COLOR, (viz[v] - lo) / (hi - lo));
    else tmp.copy(BASE_COLOR);
    colors[v * 3] = tmp.r;
    colors[v * 3 + 1] = tmp.g;
    colors[v * 3 + 2] = tmp.b;
  }
  return colors;
}

function buildRenderMesh() {
  const { positions, faces } = state.mesh;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(buildVertexColors(positions.length / 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(faces.slice(), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundsTree(); // emphasis-point picking
  if (latticeMesh) {
    latticeMesh.geometry.disposeBoundsTree();
    latticeMesh.geometry.dispose();
    latticeMesh.geometry = geometry;
  } else {
    latticeMesh = new THREE.Mesh(geometry, material);
    latticeMesh.rotation.x = -Math.PI / 2; // print z-up -> scene y-up
    scene.add(latticeMesh);
  }
}

function fitCamera(shape) {
  const size = Math.max(
    shape.width || shape.diameter || 60,
    shape.depth || shape.diameter || 60,
    shape.height || shape.diameter || 30,
  );
  const dist = Math.max(100, size * 2.2);
  camera.position.set(dist * 0.8, dist * 0.7, dist * 0.8);
  controls.target.set(0, (shape.height || shape.diameter || 30) * 0.4, 0);
  controls.update();
}

function resizeRenderer() {
  const rect = wrap.getBoundingClientRect();
  renderer.setSize(Math.max(10, rect.width), Math.max(10, rect.height), false);
  camera.aspect = Math.max(10, rect.width) / Math.max(10, rect.height);
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
const shapeSelect = document.getElementById("shapeSelect");
const widthControl = document.getElementById("widthControl");
const depthControl = document.getElementById("depthControl");
const diameterControl = document.getElementById("diameterControl");
const heightControl = document.getElementById("heightControl");
const latticeSelect = document.getElementById("latticeSelect");
const generateBtn = document.getElementById("generateBtn");
const exportStlBtn = document.getElementById("exportStlBtn");
const export3mfBtn = document.getElementById("export3mfBtn");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");

function syncShapeControls() {
  const t = shapeSelect.value;
  widthControl.style.display = t === "box" ? "" : "none";
  depthControl.style.display = t === "box" ? "" : "none";
  diameterControl.style.display = t === "box" || t === "imported" ? "none" : "";
  heightControl.style.display = t === "sphere" || t === "imported" ? "none" : "";
}
shapeSelect.addEventListener("change", () => {
  syncShapeControls();
  // Switching back to a primitive or to the import shows the relevant preview.
  if (shapeSelect.value === "imported" && state.imported && !state.generating) {
    previewImported();
  }
});

// ---------------------------------------------------------------------------
// STL/3MF import: parse -> weld -> recenter (XY origin, floor z=0) -> preview
// ---------------------------------------------------------------------------
const importBtn = document.getElementById("importBtn");
const importInput = document.getElementById("importInput");

async function loadPartFile(file) {
  let soup;
  try {
    const buffer = await file.arrayBuffer();
    soup = /\.3mf$/i.test(file.name) ? parse3MF(buffer) : parseSTL(buffer);
  } catch (err) {
    alert(`Could not read ${file.name}: ${err.message}`);
    return;
  }
  let mesh;
  try {
    mesh = weld(soup);
  } catch (err) {
    alert(err.message);
    return;
  }
  const { positions } = mesh;
  const b = meshBounds(positions);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= cx;
    positions[i + 1] -= cy;
    positions[i + 2] -= b.min[2];
  }
  state.imported = { ...mesh, name: file.name };

  const importedOption = shapeSelect.querySelector('option[value="imported"]');
  importedOption.disabled = false;
  importedOption.textContent = `Imported: ${file.name.length > 22 ? file.name.slice(0, 19) + "…" : file.name}`;
  shapeSelect.value = "imported";
  syncShapeControls();
  previewImported();

  // Voxel-size guidance so Generate doesn't immediately hit the grid cap.
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const minVoxel = Math.cbrt((size[0] * size[1] * size[2]) / MAX_VOXEL_CELLS);
  const voxelInput = document.getElementById("voxelInput");
  if (+voxelInput.value < minVoxel) {
    voxelInput.value = (Math.ceil(minVoxel * 10) / 10).toFixed(1);
    statusEl.textContent = `Part is ${size[0].toFixed(0)}×${size[1].toFixed(0)}×${size[2].toFixed(0)} mm — voxel raised to ${voxelInput.value} mm to fit the grid limit`;
  } else {
    statusEl.textContent = `Loaded ${file.name} (${(mesh.faces.length / 3).toLocaleString()} tris) — set lattice params and Generate`;
  }
}

function previewImported() {
  state.mesh = { positions: state.imported.positions, faces: state.imported.faces };
  state.wallViz = null;
  state.stats = null;
  buildRenderMesh();
  statsEl.textContent = `${state.imported.name}\n${(state.imported.faces.length / 3).toLocaleString()} tris (imported part — not yet latticed)`;
  const b = meshBounds(state.imported.positions);
  fitCamera({ width: b.max[0] - b.min[0], depth: b.max[1] - b.min[1], height: b.max[2] });
  exportStlBtn.disabled = true;
  export3mfBtn.disabled = true;
}

importBtn.addEventListener("click", () => importInput.click());
importInput.addEventListener("change", () => {
  if (importInput.files[0]) loadPartFile(importInput.files[0]);
  importInput.value = "";
});

// ---------------------------------------------------------------------------
// Emphasis points: click the displayed mesh to drop density attractors
// ---------------------------------------------------------------------------
const emphasisBtn = document.getElementById("emphasisBtn");
const clearEmphasisBtn = document.getElementById("clearEmphasisBtn");
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const pointer = new THREE.Vector2();
const markerGeometry = new THREE.SphereGeometry(1.6, 12, 8);
const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff9a5e, wireframe: true });

function setEmphasisMode(on) {
  state.emphasisMode = on;
  emphasisBtn.classList.toggle("on", on);
  controls.mouseButtons.LEFT = on ? -1 : THREE.MOUSE.ROTATE;
  renderer.domElement.style.cursor = on ? "crosshair" : "default";
}

emphasisBtn.addEventListener("click", () => setEmphasisMode(!state.emphasisMode));

function updateEmphasisButtons() {
  clearEmphasisBtn.disabled = state.emphasis.length === 0;
  clearEmphasisBtn.textContent = `Clear points (${state.emphasis.length})`;
}

renderer.domElement.addEventListener("pointerdown", (evt) => {
  if (!state.emphasisMode || evt.button !== 0 || !latticeMesh) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(latticeMesh, false);
  if (!hits.length) return;
  const local = latticeMesh.worldToLocal(hits[0].point.clone()); // print space (z-up)
  const radius = num("emphasisRadiusInput", 2, 60, 12);
  state.emphasis.push({ x: local.x, y: local.y, z: local.z, radius });
  const marker = new THREE.Mesh(markerGeometry, markerMaterial);
  marker.position.copy(local);
  markerRoot.add(marker);
  updateEmphasisButtons();
  statusEl.textContent = `${state.emphasis.length} emphasis point${state.emphasis.length > 1 ? "s" : ""} — Generate to apply`;
});

clearEmphasisBtn.addEventListener("click", () => {
  state.emphasis = [];
  markerRoot.clear();
  updateEmphasisButtons();
});
wrap.addEventListener("dragover", (evt) => evt.preventDefault());
wrap.addEventListener("drop", (evt) => {
  evt.preventDefault();
  const file = [...evt.dataTransfer.files].find((f) => /\.(stl|3mf)$/i.test(f.name));
  if (file) loadPartFile(file);
});

function num(id, min, max, fallback) {
  const v = +document.getElementById(id).value;
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

const surfaceBiasSlider = document.getElementById("surfaceBiasSlider");
const surfaceBiasValue = document.getElementById("surfaceBiasValue");
surfaceBiasSlider.addEventListener("input", () => {
  const v = +surfaceBiasSlider.value;
  surfaceBiasValue.textContent = v === 0 ? "off" : v.toFixed(2);
});

const zGradientSlider = document.getElementById("zGradientSlider");
const zGradientValue = document.getElementById("zGradientValue");
zGradientSlider.addEventListener("input", () => {
  const v = +zGradientSlider.value;
  zGradientValue.textContent = v === 0 ? "off" : v > 0 ? `${v.toFixed(2)} (bottom)` : `${(-v).toFixed(2)} (top)`;
});

function collectParams() {
  const type = shapeSelect.value;
  const shape =
    type === "box"
      ? { type, width: num("widthInput", 10, 250, 60), depth: num("depthInput", 10, 250, 60), height: num("heightInput", 5, 250, 30) }
      : type === "cylinder"
        ? { type, diameter: num("diameterInput", 10, 250, 50), height: num("heightInput", 5, 250, 30) }
        : type === "sphere"
          ? { type, diameter: num("diameterInput", 10, 250, 50) }
          : { type: "imported" };
  const wallMm = num("wallInput", 0.4, 6, 1.2);
  return {
    shape,
    latticeType: latticeSelect.value,
    cellMm: num("cellInput", 3, 40, 10),
    wallMm,
    shellMm: num("shellInput", 0, 6, 1.2),
    capMm: num("capInput", 0, 6, 1),
    voxelMm: num("voxelInput", 0.3, 2, 0.7),
    grading: {
      wallMm,
      wallMaxMm: Math.max(wallMm, num("wallMaxInput", 0.4, 8, 2.4)),
      surfaceBias: num("surfaceBiasSlider", 0, 1, 0),
      surfaceDepthMm: num("biasDepthInput", 1, 30, 6),
      zGradient: num("zGradientSlider", -1, 1, 0),
      emphasis: state.emphasis,
    },
  };
}

// ---------------------------------------------------------------------------
// Generation via worker
// ---------------------------------------------------------------------------
const worker = new Worker(new URL("./lattice-worker.js", import.meta.url), { type: "module" });

worker.onmessage = (evt) => {
  const msg = evt.data;
  if (msg.kind === "status") { statusEl.textContent = msg.message; return; }
  state.generating = false;
  generateBtn.disabled = false;
  if (msg.kind === "error") {
    statusEl.textContent = `Failed: ${msg.message}`;
    return;
  }
  state.mesh = { positions: msg.positions, faces: msg.faces };
  state.wallViz = msg.wallViz || null;
  state.stats = msg.stats;
  buildRenderMesh();
  updateStats();
  statusEl.textContent = "";
  exportStlBtn.disabled = false;
  export3mfBtn.disabled = false;
};

generateBtn.addEventListener("click", () => {
  if (state.generating) return;
  const params = collectParams();
  const isImported = params.shape.type === "imported";
  if (isImported && !state.imported) {
    statusEl.textContent = "Import an STL/3MF first";
    return;
  }
  if (params.voxelMm > params.wallMm / 2 && params.latticeType !== "none") {
    statusEl.textContent = `Note: voxel ${params.voxelMm} mm is coarse for ${params.wallMm} mm walls — generating anyway`;
  } else {
    statusEl.textContent = "Generating…";
  }
  state.generating = true;
  state.lastParams = params;
  generateBtn.disabled = true;
  if (isImported) {
    // Send copies: the originals stay usable for re-generation and preview.
    const positions = state.imported.positions.slice();
    const faces = state.imported.faces.slice();
    worker.postMessage(
      { params, imported: { positions, faces } },
      [positions.buffer, faces.buffer],
    );
    const b = meshBounds(state.imported.positions);
    fitCamera({ width: b.max[0] - b.min[0], depth: b.max[1] - b.min[1], height: b.max[2] });
  } else {
    worker.postMessage({ params });
    fitCamera(params.shape);
  }
});

// ---------------------------------------------------------------------------
// Stats + export
// ---------------------------------------------------------------------------
function updateStats() {
  const s = state.stats;
  const p = state.lastParams;
  if (!s || !p) { statsEl.textContent = ""; return; }
  const solidVol = s.solidVolumeMm3 ?? shapeSolidVolume(p.shape);
  const pct = (s.volumeMm3 / solidVol) * 100;
  const grams = (s.volumeMm3 / 1000) * PLA_DENSITY_G_CM3;
  const solidGrams = (solidVol / 1000) * PLA_DENSITY_G_CM3;
  const rows = [
    `${s.triCount.toLocaleString()} tris · ${s.vertexCount.toLocaleString()} verts`,
    `volume ${(s.volumeMm3 / 1000).toFixed(1)} cm³ · ~${grams.toFixed(0)} g PLA (solid would be ${solidGrams.toFixed(0)} g)`,
    `${pct.toFixed(0)}% of solid — ${(100 - pct).toFixed(0)}% material saved`,
    s.boundaryEdges === 0 ? "watertight" : `⚠ ${s.boundaryEdges} boundary edges`,
  ];
  if (state.wallViz) {
    rows.push(`graded wall ${p.grading.wallMm.toFixed(1)}–${p.grading.wallMaxMm.toFixed(1)} mm (blue = thin, orange = thick)`);
  }
  statsEl.textContent = rows.join("\n");
}

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
  const p = state.lastParams;
  const base = p.shape.type === "imported" && state.imported
    ? state.imported.name.replace(/\.(stl|3mf)$/i, "")
    : p.shape.type;
  return `${base}-${p.latticeType === "none" ? "shelled" : p.latticeType}.${ext}`;
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
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("resize", resizeRenderer);
resizeRenderer();
animate();
