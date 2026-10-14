const parameters = new URLSearchParams(location.search);
const token = parameters.get("token");
const mode = parameters.get("mode");

function check(condition, message) { if (!condition) throw new Error(message); }

async function send(endpoint, value) {
  const response = await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error("Application reporting failed.");
}

async function directExample() {
  await import("/vendor/tabgrad/index.js");
  await send("/__phase", { phase: "assets-loaded" });
  await send("/__phase", { phase: "runtime-started" });
  const logs = [];
  const originalLog = console.log;
  console.log = value => logs.push(value);
  let diagnostics;
  try { ({ diagnostics } = await import("/documented-example.mjs")); }
  finally { console.log = originalLog; }
  check(JSON.stringify(logs) === "[[11],[3,4]]", "Documented values or gradients differ.");
  return { logs, diagnostics };
}

async function prerequisiteFailure() {
  const { createWebGpuWorker } = await import("/vendor/tabgrad/python.js");
  await send("/__phase", { phase: "assets-loaded" });
  await send("/__phase", { phase: "runtime-started" });
  try {
    const workerUrl = new URL("/vendor/tabgrad/webgpu-worker.js", location.origin);
    workerUrl.hostname = "localhost";
    const controller = await createWebGpuWorker(mode === "origin" ? { workerUrl } : {});
    await controller.close();
  } catch (error) {
    check(mode === "origin" ? error.name === "SecurityError" : error.code === "UNSUPPORTED_DEVICE",
      "GPU hosting failed for an unexpected reason.");
    return { rejected: true, code: mode === "origin" ? error.name : error.code };
  }
  throw new Error("Unsupported GPU hosting reported success.");
}

class ApplicationWorkerEvents {
  pending = new Map();
  constructor(worker, lifetime) {
    this.lifetime = lifetime;
    worker.addEventListener("error", event => this.fail(new Error(event.message)));
    worker.addEventListener("message", ({ data }) => {
      if (data.kind === "failure") { this.fail(new Error(data.message)); return; }
      const event = this.pending.get(data.kind);
      this.pending.delete(data.kind);
      event?.resolve(data);
    });
  }
  fail(error) {
    this.lifetime.abort(error);
    for (const event of this.pending.values()) event.reject(error);
    this.pending.clear();
  }
  next(kind) {
    const promise = new Promise((resolve, reject) => { this.pending.set(kind, { resolve, reject }); });
    // Setup failures can arrive before either event is awaited.
    void promise.catch(() => undefined);
    return promise;
  }
}

async function pythonExample() {
  const { connectPythonWorker, createWebGpuWorker } = await import("/vendor/tabgrad/python.js");
  const lifetime = new AbortController();
  let controller;
  let worker;
  let client;
  try {
    if (mode === "gpu") controller = await createWebGpuWorker({ signal: lifetime.signal });
    worker = new Worker(new URL("./python-worker.mjs", import.meta.url), { type: "module" });
    const events = new ApplicationWorkerEvents(worker, lifetime);
    const ready = events.next("ready");
    const finished = events.next("finished");
    const channel = new MessageChannel();
    client = connectPythonWorker(channel.port1, lifetime.signal);
    worker.postMessage({ port: channel.port2, webgpu: controller?.connection },
      [channel.port2, ...(controller?.transferables ?? [])]);
    const environment = await ready;
    check(environment.sharedIdentity, "Direct and Python entries duplicated the runtime.");
    await send("/__phase", { phase: "assets-loaded" });
    await send("/__phase", { phase: "runtime-started" });
    await client.runPythonAsync(`
import torch, gc
def package_example():
    device = '${mode === "gpu" ? "webgpu" : "cpu"}'
    x = torch.tensor([1., 2.], dtype=torch.float32, device=device, requires_grad=True)
    weights = torch.tensor([3., 4.], dtype=torch.float32, device=device)
    loss = (x * weights).sum()
    gradient, = torch.autograd.grad(loss, (x,))
    assert loss.tolist() == 11. and gradient.tolist() == [3., 4.]
    assert str(gradient.device) == device
    return 11
answer = package_example()
gc.collect()
`);
    await client.close();
    const completion = await finished;
    await controller?.close();
    return { environment, completion };
  } catch (error) {
    lifetime.abort(error);
    throw error;
  } finally {
    try { await client?.close(); }
    finally {
      try { await controller?.close(); }
      finally { worker?.terminate(); }
    }
  }
}

try {
  await send("/__phase", { phase: "application-started" });
  const result = mode === "direct" ? await directExample()
    : mode === "prerequisite" || mode === "origin" ? await prerequisiteFailure() : await pythonExample();
  await send("/__phase", { phase: "runtime-finished" });
  await send("/__result", { ok: true, mode, ...result });
} catch (error) {
  await send("/__result", { ok: false, error: { message: String(error), code: error?.code } });
}
