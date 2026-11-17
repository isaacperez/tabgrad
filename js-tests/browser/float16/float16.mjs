import { createRuntimeSession, createWebGpuRuntimeSession } from '/index.js';
import { halfJavaScriptCases } from '/helpers/float16-cases.mjs';
const parameters = new URLSearchParams(location.search), token = parameters.get('token');
const language = parameters.get('language') ?? 'javascript', device = parameters.get('device') ?? 'cpu';
async function send(endpoint, result) {
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) });
  if (!response.ok) throw Error(`Report failed: ${response.status}`);
}
let session, worker, controller;
try {
  await send('/__phase', { phase: 'application-started' });
  const reference = await (await fetch('/helpers/float16-oracle.json')).json();
  await send('/__phase', { phase: 'assets-loaded' });
  await send('/__phase', { phase: 'runtime-started' });
  let result;
  if (language === 'python') {
    const { createWebGpuWorker } = await import('/python.js');
    if (device === 'webgpu') controller = await createWebGpuWorker();
    worker = new Worker('/float16/python-worker.mjs', { type: 'module' });
    result = await new Promise((resolve, reject) => {
      worker.addEventListener('error', event => reject(Error(event.message)), { once: true });
      worker.addEventListener('message', ({ data }) => data.ok ? resolve(data) : reject(Error(data.error)), { once: true });
      worker.postMessage({ reference, device, ...(controller ? { webgpu: controller.connection } : {}) }, controller?.transferables ?? []);
    });
  } else {
    session = device === 'webgpu' ? await createWebGpuRuntimeSession() : createRuntimeSession();
    const cases = await halfJavaScriptCases(session, reference, device);
    const beforeClose = session.diagnostics();
    await session.close();
    result = { ok: true, cases, beforeClose, final: session.diagnostics() };
  }
  if (controller) { await controller.close(); result.controller = controller.diagnostics(); }
  worker?.terminate(); worker = undefined;
  await send('/__phase', { phase: 'runtime-finished' });
  await send('/__result', { ...result, language, device });
} catch (error) {
  await send('/__result', { ok: false, language, device, error: { message: String(error), stack: error.stack } });
} finally { worker?.terminate(); await session?.close(); await controller?.close(); }
