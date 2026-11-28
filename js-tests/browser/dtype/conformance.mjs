import { createRuntimeSession, createWebGpuRuntimeSession } from '/index.js';
import { compactJavaScriptCases } from '/helpers/compact-float-cases.mjs';
import { checkJavaScriptBooleanMask } from '/helpers/boolean-mask-cases.mjs';
import { checkJavaScriptArgmax } from '/helpers/integer-argmax-cases.mjs';
import { checkJavaScriptIndexSelection } from "/helpers/index-selection-cases.mjs";
const parameters = new URLSearchParams(location.search), token = parameters.get('token');
const language = parameters.get('language') ?? 'javascript', device = parameters.get('device') ?? 'cpu';
const grid = parameters.get('grid') === 'true';
const dtype = parameters.get('dtype');
const fractionBits = Number(parameters.get('fractionBits'));
const arithmetic = parameters.get('arithmetic');
const booleanMask = parameters.get('booleanMask') === 'true';
const integerArgmax = parameters.get('integerArgmax') === 'true';
const indexSelection = parameters.get('indexSelection') === 'true';
const variant = parameters.get('variant');
async function send(endpoint, result) {
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) });
  if (!response.ok) throw Error(`Report failed: ${response.status}`);
}
let session, worker, controller;
try {
  await send('/__phase', { phase: 'application-started' });
  const reference = await (await fetch('/helpers/compact-float-oracle.json')).json();
  await send('/__phase', { phase: 'assets-loaded' });
  await send('/__phase', { phase: 'runtime-started' });
  let result;
  if (language === 'python') {
    const { createWebGpuWorker } = await import('/python.js');
    if (device === 'webgpu') controller = await createWebGpuWorker(grid
      ? { workerUrl: new URL('/dtype/gpu-device.mjs', location.href) } : {});
    worker = new Worker('/dtype/python-worker.mjs', { type: 'module' });
    result = await new Promise((resolve, reject) => {
      worker.addEventListener('error', event => reject(Error(event.message)), { once: true });
      worker.addEventListener('message', ({ data }) => data.ok ? resolve(data) : reject(Error(data.error)), { once: true });
      worker.postMessage({ reference, dtype, fractionBits, device, variant, arithmetic, grid, booleanMask, integerArgmax, indexSelection, ...(controller ? { webgpu: controller.connection } : {}) }, controller?.transferables ?? []);
    });
  } else {
    if (grid) {
      const { restrictGpuDispatch } = await import('/dtype/restrict-gpu.mjs');
      restrictGpuDispatch();
    }
    if (variant !== null) {
      const { selectCpuProfile } = await import('/helpers/cpu-profile.mjs');
      selectCpuProfile(variant);
    }
    session = device === 'webgpu' ? await createWebGpuRuntimeSession() : createRuntimeSession();
    const cases = await compactJavaScriptCases(session, reference, device, dtype, fractionBits, arithmetic);
    if (booleanMask) await checkJavaScriptBooleanMask(session, device, grid);
    if (integerArgmax) await checkJavaScriptArgmax(session, device);
    if (indexSelection) await checkJavaScriptIndexSelection(session, device);
    const beforeClose = session.diagnostics();
    await session.close();
    result = { ok: true, cases, beforeClose, final: session.diagnostics(), booleanMask };
  }
  if (controller) { await controller.close(); result.controller = controller.diagnostics(); }
  worker?.terminate(); worker = undefined;
  await send('/__phase', { phase: 'runtime-finished' });
  await send('/__result', { ...result, language, device, dtype, grid, integerArgmax, indexSelection });
} catch (error) {
  await send('/__result', { ok: false, language, device, error: { message: String(error), stack: error.stack } });
} finally { worker?.terminate(); await session?.close(); await controller?.close(); }
