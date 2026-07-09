// Terrain Maker UI: heightmap import/resampling, live rebuild of the solid
// terrain mesh with hypsometric preview colors, and STL/3MF export.
// Geometry math lives in terrain-core.js; this file is DOM + rendering.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { processHeights, applySurfaceTexture, snapHeights, buildTerrainMesh } from "./terrain-core.js";
import { makeNoiseSampler } from "../texture/noise.js";
import { writeBinarySTL } from "../texture/stl.js";
import { build3MF } from "../shared/export-3mf.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  sourceBitmap: null, // ImageBitmap of the imported heightmap
  sourceName: null,
  demoSeed: null, // set instead of sourceBitmap for generated terrain
  rawGrid: null, // { data: Float32Array 0..1, W, H } at current resolution
  mesh: null, // { positions, faces } current built solid
  params: {
    widthMm: 180,
    peakMm: 35,
    baseMm: 3,
    resolution: 256,
    smoothPasses: 1,
    waterPct: 0,
    terrace: false,
    layerHeightMm: 0.2,
    textureType: "none",
    featureMm: 4,
    depthMm: 0.6,
    bedSize: 256,
  },
};

// ---------------------------------------------------------------------------
// Viewport (same shell/look as the other tools)
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
controls.target.set(0, 20, 0);
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
  metalness: 0.02,
  roughness: 0.85,
  vertexColors: true,
  flatShading: true,
});

let terrainMesh = null;

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
// Heightmap sources
// ---------------------------------------------------------------------------
// Resample the source (image or demo noise) into a raw 0..1 grid at the
// current resolution, preserving image aspect ratio. Image row 0 is north,
// grid row 0 is south, so rows are flipped.
function resampleSource() {
  const p = state.params;
  if (state.sourceBitmap) {
    const bmp = state.sourceBitmap;
    const aspect = bmp.width / bmp.height;
    const W = aspect >= 1 ? p.resolution : Math.max(8, Math.round(p.resolution * aspect));
    const H = aspect >= 1 ? Math.max(8, Math.round(p.resolution / aspect)) : p.resolution;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H).data;
    const data = new Float32Array(W * H);
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const s = ((H - 1 - iy) * W + ix) * 4; // flip rows: north stays up
        data[iy * W + ix] = (0.2126 * img[s] + 0.7152 * img[s + 1] + 0.0722 * img[s + 2]) / 255;
      }
    }
    state.rawGrid = { data, W, H };
  } else if (state.demoSeed !== null) {
    const W = state.params.resolution + 1, H = W;
    const sampler = makeNoiseSampler("perlin", state.demoSeed, 1);
    const data = new Float32Array(W * H);
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const v = sampler((ix / W) * 3.2, (iy / H) * 3.2, 0);
        data[iy * W + ix] = Math.pow(v, 1.4); // sharpen valleys, keep peaks
      }
    }
    state.rawGrid = { data, W, H };
  } else {
    state.rawGrid = null;
  }
}

// ---------------------------------------------------------------------------
// Rebuild pipeline (debounced)
// ---------------------------------------------------------------------------
function rebuild() {
  if (!state.rawGrid) return;
  const p = state.params;
  const { data, W, H } = state.rawGrid;
  const cellMm = p.widthMm / (W - 1);
  const waterFrac = p.waterPct / 100;

  let z = processHeights(data, W, H, {
    smoothPasses: p.smoothPasses,
    waterFrac,
    peakMm: p.peakMm,
  });
  const waterZMm = waterFrac > 0 ? waterFrac * p.peakMm : -Infinity;
  applySurfaceTexture(z, W, H, cellMm, {
    type: p.textureType,
    featureMm: p.featureMm,
    depthMm: p.depthMm,
    waterZMm,
    seed: 42,
  });
  if (p.terrace) snapHeights(z, p.layerHeightMm);

  state.mesh = buildTerrainMesh(z, W, H, cellMm, p.baseMm);
  // Terracing can snap lake surfaces slightly off the exact water level, so
  // widen the water-tint tolerance to half a layer in that case.
  const waterTol = p.terrace ? p.layerHeightMm * 0.6 : 1e-4;
  buildRenderMesh(z, W, H, waterZMm + waterTol);
  updateStats(W, H, cellMm);
  updateButtons();
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 200);
}

// Hypsometric preview tint: water blue, then green -> tan -> white with
// elevation. Bottom/base vertices stay neutral gray.
const WATER_C = new THREE.Color(0x3a6ea5);
const LOW_C = new THREE.Color(0x4a7c46);
const MID_C = new THREE.Color(0xa08858);
const HIGH_C = new THREE.Color(0xe8e9ec);
const BASE_C = new THREE.Color(0x555b66);

function buildRenderMesh(z, W, H, waterZMm) {
  const { positions, faces } = state.mesh;
  const p = state.params;
  const colors = new Float32Array(positions.length);
  const tmp = new THREE.Color();
  const topCount = W * H;
  for (let v = 0; v < positions.length / 3; v++) {
    if (v >= topCount) {
      tmp.copy(BASE_C);
    } else {
      const zv = z[v];
      if (zv <= waterZMm + 1e-4) {
        tmp.copy(WATER_C);
      } else {
        const t = Math.min(1, Math.max(0, zv / Math.max(1e-9, p.peakMm)));
        if (t < 0.55) tmp.lerpColors(LOW_C, MID_C, t / 0.55);
        else tmp.lerpColors(MID_C, HIGH_C, (t - 0.55) / 0.45);
      }
    }
    colors[v * 3] = tmp.r;
    colors[v * 3 + 1] = tmp.g;
    colors[v * 3 + 2] = tmp.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions.slice(), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(faces.slice(), 1));
  geometry.computeVertexNormals();
  if (terrainMesh) {
    terrainMesh.geometry.dispose();
    terrainMesh.geometry = geometry;
  } else {
    terrainMesh = new THREE.Mesh(geometry, material);
    terrainMesh.rotation.x = -Math.PI / 2; // print z-up -> scene y-up
    scene.add(terrainMesh);
  }
}

function fitCamera() {
  const p = state.params;
  const dist = Math.max(120, p.widthMm * 1.4);
  camera.position.set(dist * 0.8, dist * 0.7, dist * 0.8);
  controls.target.set(0, (p.baseMm + p.peakMm) * 0.4, 0);
  controls.update();
}

// ---------------------------------------------------------------------------
// Import / demo
// ---------------------------------------------------------------------------
async function loadImage(file) {
  try {
    state.sourceBitmap = await createImageBitmap(file);
  } catch (err) {
    alert(`Could not read image: ${err.message}`);
    return;
  }
  state.sourceName = file.name;
  state.demoSeed = null;
  document.getElementById("dropHint").style.display = "none";
  resampleSource();
  rebuild();
  fitCamera();
}

const importBtn = document.getElementById("importBtn");
const importInput = document.getElementById("importInput");
importBtn.addEventListener("click", () => importInput.click());
importInput.addEventListener("change", () => {
  if (importInput.files[0]) loadImage(importInput.files[0]);
  importInput.value = "";
});

wrap.addEventListener("dragover", (evt) => evt.preventDefault());
wrap.addEventListener("drop", (evt) => {
  evt.preventDefault();
  const file = [...evt.dataTransfer.files].find((f) => /image\//.test(f.type));
  if (file) loadImage(file);
});

document.getElementById("demoBtn").addEventListener("click", () => {
  state.demoSeed = Math.floor(Math.random() * 1e9);
  state.sourceBitmap = null;
  state.sourceName = `demo-${state.demoSeed}`;
  document.getElementById("dropHint").style.display = "none";
  resampleSource();
  rebuild();
  fitCamera();
});

// ---------------------------------------------------------------------------
// Controls wiring
// ---------------------------------------------------------------------------
function bindNumber(id, key, min, max) {
  const el = document.getElementById(id);
  el.addEventListener("input", () => {
    const v = +el.value;
    if (!Number.isFinite(v)) return;
    state.params[key] = Math.max(min, Math.min(max, v));
    scheduleRebuild();
  });
}

bindNumber("widthInput", "widthMm", 20, 400);
bindNumber("peakInput", "peakMm", 1, 150);
bindNumber("baseInput", "baseMm", 0.4, 20);
bindNumber("layerHeightInput", "layerHeightMm", 0.08, 0.4);
bindNumber("featureInput", "featureMm", 1, 30);
bindNumber("depthInput", "depthMm", 0.1, 3);
bindNumber("bedSizeInput", "bedSize", 100, 400);

const resolutionSlider = document.getElementById("resolutionSlider");
const resolutionValue = document.getElementById("resolutionValue");
resolutionSlider.addEventListener("input", () => {
  state.params.resolution = +resolutionSlider.value;
  resolutionValue.textContent = `${state.params.resolution}`;
  resampleSource();
  scheduleRebuild();
});

const smoothSlider = document.getElementById("smoothSlider");
const smoothValue = document.getElementById("smoothValue");
smoothSlider.addEventListener("input", () => {
  state.params.smoothPasses = +smoothSlider.value;
  smoothValue.textContent = state.params.smoothPasses === 1 ? "1 pass" : `${state.params.smoothPasses} passes`;
  scheduleRebuild();
});

const waterSlider = document.getElementById("waterSlider");
const waterValue = document.getElementById("waterValue");
waterSlider.addEventListener("input", () => {
  state.params.waterPct = +waterSlider.value;
  waterValue.textContent = state.params.waterPct === 0 ? "off" : `${state.params.waterPct}%`;
  scheduleRebuild();
});

document.getElementById("terraceCheck").addEventListener("change", (evt) => {
  state.params.terrace = evt.target.checked;
  scheduleRebuild();
});

document.getElementById("textureSelect").addEventListener("change", (evt) => {
  state.params.textureType = evt.target.value;
  scheduleRebuild();
});

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

const exportStlBtn = document.getElementById("exportStlBtn");
const export3mfBtn = document.getElementById("export3mfBtn");

function exportName(ext) {
  const base = (state.sourceName || "terrain").replace(/\.[a-z0-9]+$/i, "");
  return `${base}-terrain.${ext}`;
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
// Stats
// ---------------------------------------------------------------------------
const statsEl = document.getElementById("stats");

function updateStats(W, H, cellMm) {
  const p = state.params;
  const depthMm = (H - 1) * cellMm;
  const totalH = p.baseMm + p.peakMm;
  const layers = Math.ceil(totalH / p.layerHeightMm);
  const rows = [
    state.sourceName || "",
    `${W}×${H} grid · ${(state.mesh.faces.length / 3).toLocaleString()} tris`,
    `${p.widthMm.toFixed(0)}×${depthMm.toFixed(0)}×${totalH.toFixed(1)} mm · ~${layers} layers @ ${p.layerHeightMm} mm`,
  ];
  if (p.widthMm > p.bedSize - 10 || depthMm > p.bedSize - 10) {
    rows.push(`⚠ footprint is tight on the ${p.bedSize}×${p.bedSize} bed`);
  }
  statsEl.textContent = rows.filter(Boolean).join("\n");
}

function updateButtons() {
  const has = !!state.mesh;
  exportStlBtn.disabled = !has;
  export3mfBtn.disabled = !has;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("resize", resizeRenderer);
resizeRenderer();
updateButtons();
animate();
