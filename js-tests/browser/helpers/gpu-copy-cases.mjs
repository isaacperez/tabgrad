import { completeRuntimeSession } from "/runtime/runtime.js";
import { getTestRuntimeOwnership } from "/testing.js";

function check(condition, message) { if (!condition) throw new Error(message); }

/** Real GPU values plus conditional registered-owner bounds; no RSS/VRAM claim. */
export async function checkGpuCopy(session) {
  const rows = [];
  const tensor = (data, options = {}) => session.tensor(data, { device: "webgpu", ...options });
  for (const shape of [[], [0], [2, 0, 3], [1], [2, 3], [65]]) {
    const length = shape.reduce((n, d) => n * d, 1);
    const bits = Uint32Array.from({ length }, (_, i) => [0x80000000, 1, 0x7fc12345, 0x7f800000, 0xff800000][i % 5]);
    const source = tensor(new Float32Array(bits.buffer), { shape }), p = tensor(new Float32Array(length), { shape }), alias = p.view(shape);
    try {
      const stored = new Uint32Array((await source.toArray()).buffer);
      check(p.copy_(source) === p, "GPU copy changed identity");
      const copied = new Uint32Array((await alias.toArray()).buffer);
      check(copied.every((word, i) => word === stored[i]), "GPU copy changed stored bits");
      p.copy_(p);
      check(new Uint32Array((await p.toArray()).buffer).every((word, i) => word === stored[i]), "GPU self-copy changed stored bits");
    } finally { source.close(); p.close(); alias.close(); }
  }
  {
    const source = tensor([7, 9]), p = tensor([2, 3]), zero = tensor([0, 0]);
    await source.toArray(); await p.toArray();
    const old = p.add(zero), before = session.diagnostics().webgpu;
    try {
      p.copy_(source); await completeRuntimeSession(session);
      const after = session.diagnostics().webgpu;
      for (const key of ["kernelCalls", "uploadBytes", "readbackBytes", "ownedBufferBytes"]) {
        check(after[key] === before[key], `Resident copy changed ${key}`);
      }
      check(JSON.stringify([...await old.toArray()]) === "[2,3]", "GPU copy overwrote entitled old value");
      const next = tensor([11, 13]);
      try { source.copy_(next); check(JSON.stringify([...await p.toArray()]) === "[7,9]", "GPU source update changed destination"); }
      finally { next.close(); }
    } finally { source.close(); p.close(); zero.close(); old.close(); }
  }
  {
    const x = tensor([2, 4], { requiresGrad: true }), source = tensor([7, 9], { requiresGrad: true }), p = x.add(x), seed = tensor([NaN, Infinity]);
    p.copy_(source); const [zero, passed] = session.grad(p, [x, source], seed);
    try {
      check(zero.device === "webgpu" && new Uint32Array((await zero.toArray()).buffer).every(word => word === 0), "Nonfinite GPU copy gradient is not positive zero");
      const values = await passed.toArray(); check(Number.isNaN(values[0]) && values[1] === Infinity, "Copy source derivative changed");
    } finally { for (const value of [x, source, p, seed, zero, passed]) value.close(); }
  }
  for (const [dimension, levels] of [["payload", [0, 1, 65, 1024]], ["aliases", [0, 1, 4]], ["queued", [1, 4, 16]], ["repetitions", [1, 8, 32]]]) {
    for (const level of levels) {
      const length = dimension === "payload" ? level : 65, aliasCount = dimension === "aliases" ? level : 0;
      const queued = dimension === "queued" ? level : 1, repetitions = dimension === "repetitions" ? level : 8;
      const p = tensor(new Float32Array(length)), increment = tensor(new Float32Array(length).fill(1)), aliases = Array.from({ length: aliasCount }, () => p.view([length]));
      try {
        for (let r = 0; r < repetitions; r++) {
          for (let q = 0; q < queued; q++) { const next = p.add(increment); p.copy_(next); next.close(); }
          check((await p.toArray()).every(value => value === (r + 1) * queued), "Repeated GPU copy values changed");
          await completeRuntimeSession(session);
          const owners = getTestRuntimeOwnership(session), diagnostics = session.diagnostics();
          check(owners.backings === 2 && owners.valueReferences === 2 && owners.controlReferences === 1, "Completed copies retained snapshots/controls");
          check(owners.pendingCopies === 0 && diagnostics.liveRequestLeases === 0, "Completed copy retained a request");
          check(diagnostics.webgpu.ownedBufferBytes === Math.max(8, 8 * length), "Completed copy retained GPU backing");
        }
        rows.push({ dimension, level, owners: getTestRuntimeOwnership(session) });
      } finally { p.close(); increment.close(); for (const alias of aliases) alias.close(); }
    }
  }
  for (const repetitions of [1, 8, 32]) {
    const p = tensor(new Float32Array(65).fill(1), { requiresGrad: true }), alias = p.view([65]), coefficient = tensor(new Float32Array(65).fill(-0.25));
    try {
      for (let r = 0; r < repetitions; r++) {
        const square = p.mul(p), loss = square.sum(), [gradient] = session.grad(loss, [p]);
        const scaled = session.noGrad(() => gradient.mul(coefficient)), next = session.noGrad(() => p.add(scaled));
        session.noGrad(() => p.copy_(next));
        for (const value of [square, loss, gradient, scaled, next]) value.close();
        check((await alias.toArray()).every(value => value === 2 ** (-(r + 1))), "GPU parameter update changed values");
        await completeRuntimeSession(session);
        const owners = getTestRuntimeOwnership(session), diagnostics = session.diagnostics();
        check(owners.backings === 2 && owners.valueReferences === 2 && owners.controlReferences === 1, "GPU parameter retained prior updates");
        check(diagnostics.liveSavedValues === 0 && diagnostics.liveDerivativeNodes === 2 && diagnostics.liveRequestLeases === 0, "GPU parameter retained temporary history/work");
      }
      rows.push({ repetitions, owners: getTestRuntimeOwnership(session) });
    } finally { p.close(); alias.close(); coefficient.close(); }
  }
  return rows;
}
