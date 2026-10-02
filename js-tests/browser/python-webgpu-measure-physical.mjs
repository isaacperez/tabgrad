// Diagnostic-only inclusive physical phases. Never used for decision timings.
const initialization = [];
function holdInitialization(event) {
  if (event.data.kind === "initialize") {
    initialization.push(event.data);
    event.stopImmediatePropagation();
  }
}
addEventListener("message", holdInitialization);
const [{ WebGpuBackend }, { ExecutionTicket }] = await Promise.all([
  import("/webgpu-backend.js"), import("/execution-ticket.js"),
]);

function record(name, started, failed = false) {
  postMessage({ kind: "test-physical-phase", name, milliseconds: performance.now() - started, failed });
}

function observe(promise, name, started) {
  void promise.then(() => record(name, started), () => record(name, started, true));
}

for (const name of ["prepare", "execute", "read", "release"]) {
  const original = WebGpuBackend.prototype[name];
  WebGpuBackend.prototype[name] = function (...arguments_) {
    const started = performance.now();
    let result;
    try { result = Reflect.apply(original, this, arguments_); }
    catch (error) { record(name, started, true); throw error; }
    if (result instanceof ExecutionTicket) {
      observe(result.result, `${name}Result`, started);
      observe(result.drained, `${name}Drain`, started);
    } else if (result instanceof Promise) observe(result, name, started);
    else record(name, started);
    return result;
  };
}
await import("/webgpu-worker.js");
removeEventListener("message", holdInitialization);
for (const data of initialization) dispatchEvent(new MessageEvent("message", { data }));
