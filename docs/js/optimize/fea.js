// Voxel finite-element analysis core (Stage C0): linear elasticity on a
// regular grid of 8-node hexahedral elements, solved matrix-free with
// Jacobi-preconditioned conjugate gradients. Pure typed-array code — runs in
// a worker and in node tests.
//
// Conventions:
//  - Grid of nx*ny*nz ELEMENTS; nodes on the (nx+1)(ny+1)(nz+1) lattice.
//  - Node id: (iz*(ny+1) + iy)*(nx+1) + ix. DOFs: 3*node + {0:x, 1:y, 2:z}.
//  - Every element shares one reference stiffness matrix KE (built once by
//    Gauss quadrature); per-element stiffness is KE scaled by Escale[e]
//    (SIMP feeds density^p * E here).
//  - Dirichlet BCs by projection: fixed DOFs are zeroed in all PCG vectors.

// Local corner order (offsets within an element) — matches xi/eta/zeta signs.
const CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

// 24x24 hex8 element stiffness for element size h (mm), modulus E, Poisson nu.
// Built by 2x2x2 Gauss quadrature of B^T D B. Strain order:
// [exx, eyy, ezz, gxy, gyz, gzx].
export function buildKE(E, nu, h) {
  const c = E / ((1 + nu) * (1 - 2 * nu));
  const D = [
    [c * (1 - nu), c * nu, c * nu, 0, 0, 0],
    [c * nu, c * (1 - nu), c * nu, 0, 0, 0],
    [c * nu, c * nu, c * (1 - nu), 0, 0, 0],
    [0, 0, 0, c * (1 - 2 * nu) / 2, 0, 0],
    [0, 0, 0, 0, c * (1 - 2 * nu) / 2, 0],
    [0, 0, 0, 0, 0, c * (1 - 2 * nu) / 2],
  ];
  const KE = new Float64Array(24 * 24);
  const g = 1 / Math.sqrt(3);
  const detJ = (h / 2) ** 3;
  const dScale = 2 / h; // dN/dx = dN/dxi * 2/h on a cube element

  for (const gx of [-g, g]) {
    for (const gy of [-g, g]) {
      for (const gz of [-g, g]) {
        // B matrix (6 x 24)
        const B = Array.from({ length: 6 }, () => new Float64Array(24));
        for (let i = 0; i < 8; i++) {
          const sx = CORNERS[i][0] * 2 - 1, sy = CORNERS[i][1] * 2 - 1, sz = CORNERS[i][2] * 2 - 1;
          const dNx = (sx * (1 + sy * gy) * (1 + sz * gz)) / 8 * dScale;
          const dNy = (sy * (1 + sx * gx) * (1 + sz * gz)) / 8 * dScale;
          const dNz = (sz * (1 + sx * gx) * (1 + sy * gy)) / 8 * dScale;
          const col = i * 3;
          B[0][col] = dNx;
          B[1][col + 1] = dNy;
          B[2][col + 2] = dNz;
          B[3][col] = dNy; B[3][col + 1] = dNx;
          B[4][col + 1] = dNz; B[4][col + 2] = dNy;
          B[5][col] = dNz; B[5][col + 2] = dNx;
        }
        // KE += B^T (D B) * detJ
        const DB = Array.from({ length: 6 }, () => new Float64Array(24));
        for (let r = 0; r < 6; r++) {
          for (let b = 0; b < 24; b++) {
            let sum = 0;
            for (let s = 0; s < 6; s++) sum += D[r][s] * B[s][b];
            DB[r][b] = sum;
          }
        }
        for (let a = 0; a < 24; a++) {
          for (let b = 0; b < 24; b++) {
            let sum = 0;
            for (let r = 0; r < 6; r++) sum += B[r][a] * DB[r][b];
            KE[a * 24 + b] += sum * detJ;
          }
        }
      }
    }
  }
  return KE;
}

export class VoxelFEA {
  constructor({ nx, ny, nz, h = 1, E = 1, nu = 0.3 }) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.h = h; this.E = E; this.nu = nu;
    this.nodeCount = (nx + 1) * (ny + 1) * (nz + 1);
    this.dofCount = this.nodeCount * 3;
    this.elemCount = nx * ny * nz;
    this.KE = buildKE(E, nu, h);

    // Element -> 8 corner base-DOF indices (node*3), precomputed for the
    // matvec hot loop. Local DOF a maps to edof[e*8 + floor(a/3)] + a%3.
    this.edof = new Int32Array(this.elemCount * 8);
    let p = 0;
    for (let ez = 0; ez < nz; ez++) {
      for (let ey = 0; ey < ny; ey++) {
        for (let ex = 0; ex < nx; ex++) {
          for (const [dx, dy, dz] of CORNERS) {
            const node = ((ez + dz) * (ny + 1) + (ey + dy)) * (nx + 1) + (ex + dx);
            this.edof[p++] = node * 3;
          }
        }
      }
    }

    this.fixed = new Uint8Array(this.dofCount);
  }

  nodeIndex(ix, iy, iz) {
    return (iz * (this.ny + 1) + iy) * (this.nx + 1) + ix;
  }

  elemIndex(ex, ey, ez) {
    return (ez * this.ny + ey) * this.nx + ex;
  }

  fixNode(ix, iy, iz, axes = [0, 1, 2]) {
    const n = this.nodeIndex(ix, iy, iz) * 3;
    for (const a of axes) this.fixed[n + a] = 1;
  }

  project(v) {
    for (let i = 0; i < v.length; i++) if (this.fixed[i]) v[i] = 0;
  }

  // y = K(Escale) * u, with fixed DOFs projected out.
  matvec(y, u, Escale) {
    y.fill(0);
    const { KE, edof } = this;
    const ue = new Float64Array(24);
    for (let e = 0; e < this.elemCount; e++) {
      const s = Escale[e];
      if (s === 0) continue;
      const base = e * 8;
      for (let i = 0; i < 8; i++) {
        const d = edof[base + i];
        ue[i * 3] = u[d];
        ue[i * 3 + 1] = u[d + 1];
        ue[i * 3 + 2] = u[d + 2];
      }
      for (let a = 0; a < 24; a++) {
        let sum = 0;
        const row = a * 24;
        for (let b = 0; b < 24; b++) sum += KE[row + b] * ue[b];
        y[edof[base + (a / 3) | 0] + (a % 3)] += s * sum;
      }
    }
    this.project(y);
  }

  // Jacobi preconditioner diagonal for the current Escale.
  buildDiagonal(Escale) {
    const diag = new Float64Array(this.dofCount);
    const { KE, edof } = this;
    for (let e = 0; e < this.elemCount; e++) {
      const s = Escale[e];
      if (s === 0) continue;
      const base = e * 8;
      for (let a = 0; a < 24; a++) {
        diag[edof[base + (a / 3) | 0] + (a % 3)] += s * KE[a * 24 + a];
      }
    }
    for (let i = 0; i < diag.length; i++) {
      if (this.fixed[i] || diag[i] <= 0) diag[i] = 1;
    }
    return diag;
  }

  // Preconditioned CG. f: Float64Array(dofCount). Returns { u, iterations,
  // relResidual }. Pass u0 to warm-start (SIMP reuses the previous solve).
  solve(f, Escale, { tol = 1e-6, maxIter = 3000, u0 = null } = {}) {
    const n = this.dofCount;
    const u = u0 ? Float64Array.from(u0) : new Float64Array(n);
    this.project(u);
    const b = Float64Array.from(f);
    this.project(b);

    const diag = this.buildDiagonal(Escale);
    const r = new Float64Array(n);
    const z = new Float64Array(n);
    const p = new Float64Array(n);
    const q = new Float64Array(n);

    this.matvec(q, u, Escale);
    for (let i = 0; i < n; i++) r[i] = b[i] - q[i];
    let bNorm = 0;
    for (let i = 0; i < n; i++) bNorm += b[i] * b[i];
    bNorm = Math.sqrt(bNorm) || 1;

    for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; p[i] = z[i]; }
    let rz = 0;
    for (let i = 0; i < n; i++) rz += r[i] * z[i];

    let iterations = 0;
    let relResidual = Infinity;
    for (let it = 0; it < maxIter; it++) {
      iterations = it + 1;
      this.matvec(q, p, Escale);
      let pq = 0;
      for (let i = 0; i < n; i++) pq += p[i] * q[i];
      if (pq <= 0) break; // numerical breakdown / singular subspace
      const alpha = rz / pq;
      let rNorm = 0;
      for (let i = 0; i < n; i++) {
        u[i] += alpha * p[i];
        r[i] -= alpha * q[i];
        rNorm += r[i] * r[i];
      }
      relResidual = Math.sqrt(rNorm) / bNorm;
      if (relResidual < tol) break;
      let rzNew = 0;
      for (let i = 0; i < n; i++) {
        z[i] = r[i] / diag[i];
        rzNew += r[i] * z[i];
      }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    return { u, iterations, relResidual };
  }

  // Per-element strain energy u_e^T KE u_e for a UNIT stiffness scale —
  // SIMP's compliance sensitivity is -p * rho^(p-1) * E0 * this.
  elementEnergy(u, e) {
    const { KE, edof } = this;
    const base = e * 8;
    const ue = new Float64Array(24);
    for (let i = 0; i < 8; i++) {
      const d = edof[base + i];
      ue[i * 3] = u[d];
      ue[i * 3 + 1] = u[d + 1];
      ue[i * 3 + 2] = u[d + 2];
    }
    let energy = 0;
    for (let a = 0; a < 24; a++) {
      let sum = 0;
      const row = a * 24;
      for (let b = 0; b < 24; b++) sum += KE[row + b] * ue[b];
      energy += ue[a] * sum;
    }
    return energy;
  }
}
