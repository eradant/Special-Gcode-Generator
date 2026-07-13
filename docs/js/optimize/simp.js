// SIMP topology optimization (Stage C1), the method behind nTop/Fusion-style
// generative structures, in its published-standard form (top3d family):
// density per element, penalized stiffness E(rho) = Emin + rho^p (E0 - Emin),
// compliance sensitivities from the FE solution, sensitivity filtering for
// minimum feature size, optimality-criteria update under a volume constraint.
//
// Pure typed-array code over the VoxelFEA core — runs in a worker and node.

import { VoxelFEA } from "./fea.js";

// domain[e]: 0 = void (outside the part, never material), 1 = designable,
// 2 = frozen solid (load pads, anchors, keep-out bosses — always material).
export const DOMAIN_VOID = 0;
export const DOMAIN_DESIGN = 1;
export const DOMAIN_SOLID = 2;

export function optimize({
  nx, ny, nz,
  h = 1,
  E = 1000,
  nu = 0.3,
  domain, // Uint8Array(nx*ny*nz), see constants above
  fixedNodes, // array of node dof specs: { ix, iy, iz, axes?: [0,1,2] }
  loads, // array of { ix, iy, iz, fx, fy, fz } nodal forces
  volFrac = 0.3,
  penal = 3,
  rMin = 1.5, // filter radius in elements (minimum feature size)
  maxIter = 40,
  moveLimit = 0.2,
  tolChange = 0.01,
  cgTol = 1e-5,
  cgMaxIter = 3000,
  onIteration = null, // (info) => {}; return false to abort early
}) {
  // KE is built with unit modulus; the real E lives in Escale so element
  // energies from fea.elementEnergy are unit-stiffness (what the SIMP
  // sensitivity formula wants).
  const fea = new VoxelFEA({ nx, ny, nz, h, E: 1, nu });
  const elemCount = fea.elemCount;
  if (!domain) {
    domain = new Uint8Array(elemCount).fill(DOMAIN_DESIGN);
  }

  for (const fix of fixedNodes) fea.fixNode(fix.ix, fix.iy, fix.iz, fix.axes || [0, 1, 2]);

  const f = new Float64Array(fea.dofCount);
  for (const ld of loads) {
    const d = fea.nodeIndex(ld.ix, ld.iy, ld.iz) * 3;
    f[d] += ld.fx || 0;
    f[d + 1] += ld.fy || 0;
    f[d + 2] += ld.fz || 0;
  }

  const Emin = 1e-9 * E;

  // Densities
  const x = new Float64Array(elemCount);
  let designCount = 0;
  for (let e = 0; e < elemCount; e++) {
    if (domain[e] === DOMAIN_DESIGN) { x[e] = volFrac; designCount++; }
    else if (domain[e] === DOMAIN_SOLID) x[e] = 1;
    else x[e] = 0;
  }
  if (designCount === 0) throw new Error("No designable elements in the domain");

  // Filter neighborhoods: offsets within rMin (element units), precomputed.
  const filterOffsets = [];
  const rCeil = Math.ceil(rMin - 1e-9);
  for (let dz = -rCeil; dz <= rCeil; dz++) {
    for (let dy = -rCeil; dy <= rCeil; dy++) {
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        const dist = Math.hypot(dx, dy, dz);
        if (dist < rMin) filterOffsets.push([dx, dy, dz, rMin - dist]);
      }
    }
  }
  const eIndex = (ex, ey, ez) => (ez * ny + ey) * nx + ex;

  const Escale = new Float64Array(elemCount);
  const dc = new Float64Array(elemCount);
  const dcFiltered = new Float64Array(elemCount);
  const xNew = new Float64Array(elemCount);
  let u = null;
  const complianceHistory = [];
  let change = 1;
  let iter = 0;

  for (iter = 1; iter <= maxIter; iter++) {
    // 1. FE solve at current densities (warm-started)
    for (let e = 0; e < elemCount; e++) {
      Escale[e] = domain[e] === DOMAIN_VOID ? 0 : Emin + x[e] ** penal * (E - Emin);
    }
    const solved = fea.solve(f, Escale, { tol: cgTol, maxIter: cgMaxIter, u0: u });
    u = solved.u;

    // 2. Compliance + sensitivities
    let compliance = 0;
    for (let i = 0; i < f.length; i++) compliance += f[i] * u[i];
    complianceHistory.push(compliance);
    for (let e = 0; e < elemCount; e++) {
      if (domain[e] !== DOMAIN_DESIGN) { dc[e] = 0; continue; }
      const energy = fea.elementEnergy(u, e); // unit-stiffness u_e^T KE u_e
      dc[e] = -penal * x[e] ** (penal - 1) * (E - Emin) * energy;
    }

    // 3. Sensitivity filter (classic): weighted average of x*dc over the
    // neighborhood, divided by x_e — enforces minimum feature size.
    for (let ez = 0; ez < nz; ez++) {
      for (let ey = 0; ey < ny; ey++) {
        for (let ex = 0; ex < nx; ex++) {
          const e = eIndex(ex, ey, ez);
          if (domain[e] !== DOMAIN_DESIGN) { dcFiltered[e] = 0; continue; }
          let sum = 0, wSum = 0;
          for (const [dx, dy, dz, w] of filterOffsets) {
            const jx = ex + dx, jy = ey + dy, jz = ez + dz;
            if (jx < 0 || jx >= nx || jy < 0 || jy >= ny || jz < 0 || jz >= nz) continue;
            const j = eIndex(jx, jy, jz);
            if (domain[j] !== DOMAIN_DESIGN) continue;
            sum += w * x[j] * dc[j];
            wSum += w;
          }
          dcFiltered[e] = sum / (Math.max(1e-3, x[e]) * Math.max(1e-9, wSum));
        }
      }
    }

    // 4. Optimality-criteria update with bisection on the volume multiplier
    let l1 = 0, l2 = 1e9;
    const targetVol = volFrac * designCount;
    while (l2 - l1 > 1e-9 * (l1 + l2 + 1e-12)) {
      const lmid = (l1 + l2) / 2;
      let vol = 0;
      for (let e = 0; e < elemCount; e++) {
        if (domain[e] !== DOMAIN_DESIGN) { xNew[e] = x[e]; continue; }
        const be = Math.sqrt(Math.max(0, -dcFiltered[e]) / lmid);
        let v = x[e] * be;
        v = Math.min(x[e] + moveLimit, Math.max(x[e] - moveLimit, v));
        v = Math.min(1, Math.max(0.001, v));
        xNew[e] = v;
        vol += v;
      }
      if (vol > targetVol) l1 = lmid; else l2 = lmid;
    }

    change = 0;
    for (let e = 0; e < elemCount; e++) {
      if (domain[e] === DOMAIN_DESIGN) change = Math.max(change, Math.abs(xNew[e] - x[e]));
      x[e] = xNew[e];
    }

    if (onIteration) {
      const keepGoing = onIteration({
        iter, compliance, change,
        cgIterations: solved.iterations,
        density: x,
      });
      if (keepGoing === false) break;
    }
    if (change < tolChange) break;
  }

  return {
    density: x,
    domain,
    compliance: complianceHistory[complianceHistory.length - 1],
    complianceHistory,
    iterations: iter,
    change,
    u,
    fea,
  };
}
