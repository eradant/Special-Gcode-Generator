// Generative Lattice UI: parameter panel, worker-driven generation, preview,
// and STL/3MF export. Geometry math lives in sdf.js / mtetra.js.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { shapeSolidVolume } from "./sdf.js";
import { writeBinarySTL } from "../texture/stl.js";
import { build3MF } from "../shared/export-3mf.js";

const PLA_DENSITY_G_CM3 = 1.24;

const state = {
  mesh: null, // { positions, faces }
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
  color: 0x5eb4ff,
  metalness: 0.05,
  roughness: 0.5,
  flatShading: true,
});

let latticeMesh = null;

function buildRenderMesh() {
  const { positions, faces } = state.mesh;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
  geometry.setIndex(new THREE.BufferAttribute(faces.slice(), 1));
  geometry.computeVertexNormals();
  if (latticeMesh) {
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

shapeSelect.addEventListener("change", () => {
  const t = shapeSelect.value;
  widthControl.style.display = t === "box" ? "" : "none";
  depthControl.style.display = t === "box" ? "" : "none";
  diameterControl.style.display = t === "box" ? "none" : "";
  heightControl.style.display = t === "sphere" ? "none" : "";
});

function num(id, min, max, fallback) {
  const v = +document.getElementById(id).value;
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function collectParams() {
  const type = shapeSelect.value;
  const shape =
    type === "box"
      ? { type, width: num("widthInput", 10, 250, 60), depth: num("depthInput", 10, 250, 60), height: num("heightInput", 5, 250, 30) }
      : type === "cylinder"
        ? { type, diameter: num("diameterInput", 10, 250, 50), height: num("heightInput", 5, 250, 30) }
        : { type, diameter: num("diameterInput", 10, 250, 50) };
  return {
    shape,
    latticeType: latticeSelect.value,
    cellMm: num("cellInput", 3, 40, 10),
    wallMm: num("wallInput", 0.4, 6, 1.2),
    shellMm: num("shellInput", 0, 6, 1.2),
    capMm: num("capInput", 0, 6, 1),
    voxelMm: num("voxelInput", 0.3, 2, 0.7),
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
  if (params.voxelMm > params.wallMm / 2 && params.latticeType !== "none") {
    statusEl.textContent = `Note: voxel ${params.voxelMm} mm is coarse for ${params.wallMm} mm walls — generating anyway`;
  } else {
    statusEl.textContent = "Generating…";
  }
  state.generating = true;
  state.lastParams = params;
  generateBtn.disabled = true;
  worker.postMessage({ params });
  fitCamera(params.shape);
});

// ---------------------------------------------------------------------------
// Stats + export
// ---------------------------------------------------------------------------
function updateStats() {
  const s = state.stats;
  const p = state.lastParams;
  if (!s || !p) { statsEl.textContent = ""; return; }
  const solidVol = shapeSolidVolume(p.shape);
  const pct = (s.volumeMm3 / solidVol) * 100;
  const grams = (s.volumeMm3 / 1000) * PLA_DENSITY_G_CM3;
  const solidGrams = (solidVol / 1000) * PLA_DENSITY_G_CM3;
  statsEl.textContent = [
    `${s.triCount.toLocaleString()} tris · ${s.vertexCount.toLocaleString()} verts`,
    `volume ${(s.volumeMm3 / 1000).toFixed(1)} cm³ · ~${grams.toFixed(0)} g PLA (solid would be ${solidGrams.toFixed(0)} g)`,
    `${pct.toFixed(0)}% of solid — ${(100 - pct).toFixed(0)}% material saved`,
    s.boundaryEdges === 0 ? "watertight" : `⚠ ${s.boundaryEdges} boundary edges`,
  ].join("\n");
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
  return `${p.latticeType === "none" ? "shape" : p.latticeType}-${p.shape.type}.${ext}`;
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
