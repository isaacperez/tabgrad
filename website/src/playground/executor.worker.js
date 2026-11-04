// Application-owned playground host. Each worker accepts exactly one script.
const OUTPUT_LIMIT = 64000;
const LINE_LIMIT = 1000;
let outputCharacters = 0;
let outputLines = 0;
let outputLimited = false;
let sendToHost;
let assets;

function send(message) {
  sendToHost(message);
}

function stage(text) {
  send({ kind: 'stage', text });
}

function display(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return String(value);
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

function writeOutput(stream, text) {
  if (outputLimited) return;
  text = String(text);
  const remaining = OUTPUT_LIMIT - outputCharacters;
  const lineCount = text.split('\n').length;
  // Count the newline added by the output renderer as part of the text budget.
  const characters = text.length + 1;
  if (remaining <= 0 || outputLines + lineCount > LINE_LIMIT || characters > remaining) {
    outputLimited = true;
    send({ kind: 'output-limit', text: 'Output truncated at 64,000 characters or 1,000 lines. Stop if the program keeps running.' });
    return;
  }
  outputCharacters += characters;
  outputLines += lineCount;
  send({ kind: 'output', stream, text });
}

function describe(error) {
  let message;
  try {
    // Firefox's stack contains locations without the Error name/message.
    const detail = error?.message;
    const summary = typeof detail === 'string' ? `${error?.name ?? 'Error'}: ${detail}` : String(error);
    const stack = error?.stack;
    message = typeof stack === 'string' && stack
      ? (stack.includes(summary) ? stack : summary + '\n' + stack) : summary;
  } catch {
    message = 'An error occurred; its diagnostic could not be read.';
  }
  return message.length > 8000 ? message.slice(0, 8000) + '\n[error truncated]' : message;
}

function describeErrors(error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  let text = '';
  for (const item of errors) {
    const next = (text ? '\n\n' : '') + describe(item);
    if (text.length + next.length > 8000) {
      return (text + next).slice(0, 8000) + '\n[additional error text truncated]';
    }
    text += next;
  }
  return text;
}

function gpuResources(value) {
  if (value === null) return null;
  return {
    state: value.state,
    adapter: { vendor: value.adapter.vendor, architecture: value.adapter.architecture,
      device: value.adapter.device, description: value.adapter.description,
      isFallbackAdapter: typeof value.adapter.isFallbackAdapter === 'boolean' ? value.adapter.isFallbackAdapter : null },
    ownedBufferBytes: value.ownedBufferBytes, peakOwnedBufferBytes: value.peakOwnedBufferBytes,
    pendingSubmissions: value.pendingSubmissions, unknownCompletionBytes: value.unknownCompletionBytes,
    kernelCalls: value.kernelCalls, uploadBytes: value.uploadBytes, readbackBytes: value.readbackBytes,
  };
}

function javascriptResources(read, device, programMilliseconds, cpuSample) {
  const value = read();
  const data = { language: 'javascript', device, gpuAcquired: value.webgpu !== null, programMilliseconds,
    cpu: cpuSample ?? { wasmMemoryBytes: value.wasmMemoryBytes, peakAllocationBytes: value.highWaterAllocationBytes, kernelCalls: value.kernelCalls },
    gpu: gpuResources(value.webgpu) };
  send({ kind: 'resources', data });
  return data.cpu;
}

async function javascript(source, device) {
  stage('Loading Tabgrad…');
  const api = await import(assets.runtimeBase + 'index.js');
  if (device === 'webgpu') stage('Preparing GPU…');
  const session = device === 'webgpu' ? await api.createWebGpuRuntimeSession() : api.createRuntimeSession();
  // Capture trusted public observations before edited code can replace methods.
  const close = session.close.bind(session);
  const read = session.diagnostics.bind(session);
  const now = performance.now.bind(performance);
  const console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error'].map(
    level => [level, (...values) => writeOutput(level, values.map(display).join(' '))],
  )));
  const errors = [];
  let programMilliseconds = null;
  let cpuSample;
  try {
    javascriptResources(read, device, null);
    stage(device === 'webgpu' ? 'GPU ready · running JavaScript…' : 'Running JavaScript on CPU…');
    const started = now();
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction('session', 'console', '"use strict";\n' + source)(session, console);
    } finally { programMilliseconds = now() - started; }
  } catch (error) { errors.push(error); }
  try { cpuSample = javascriptResources(read, device, programMilliseconds); }
  catch (error) { errors.push(error); }
  try {
    stage('Finishing…');
    await close();
  } catch (error) { errors.push(error); }
  try { javascriptResources(read, device, programMilliseconds, cpuSample); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Execution or cleanup failed');
  return { cleanup: 'acknowledged' };
}

async function python(source, device) {
  stage('Loading Tabgrad…');
  const { attachPython } = await import(assets.runtimeBase + 'python.js');
  stage('Loading Python in your browser…');
  const { loadPyodide } = await import(assets.pyodideBase + 'pyodide.mjs');
  const interpreter = await loadInterpreter(loadPyodide);
  stage('Preparing Tabgrad for Python…');
  if (device === 'webgpu' && assets.webgpu?.connectionType !== 'tabgrad-webgpu') throw new Error('The GPU connection is missing.');
  const binding = await attachPython(interpreter, device === 'webgpu' ? { webgpu: assets.webgpu } : {});
  const now = performance.now.bind(performance);
  const errors = [];
  let programMilliseconds = null;
  send({ kind: 'resources', data: { language: 'python', device, gpuAcquired: device === 'webgpu', programMilliseconds, cpu: null, gpu: null } });
  try {
    interpreter.globals.set('__playground_source', source);
    stage(device === 'webgpu' ? 'GPU enabled · running Python…' : 'Running Python on CPU…');
    const started = now();
    try { await binding.runPythonAsync('exec(compile(__playground_source, "<playground>", "exec"), {"__name__": "__main__"})'); }
    finally { programMilliseconds = now() - started; }
  } catch (error) { errors.push(error); }
  try { stage('Finishing…'); await binding.close(); }
  catch (error) { errors.push(error); }
  try { interpreter.globals.delete('__playground_source'); }
  catch (error) { errors.push(error); }
  send({ kind: 'resources', data: { language: 'python', device, gpuAcquired: device === 'webgpu', programMilliseconds, cpu: null, gpu: null } });
  if (errors.length) throw new AggregateError(errors, 'Execution or cleanup failed');
  return { cleanup: 'acknowledged' };
}

function superviseInstantiation(original) {
  return async (...args) => {
    try { return await Reflect.apply(original, WebAssembly, args); }
    catch (error) {
      send({ kind: 'failure', text: 'Python WebAssembly could not load.\n' + describe(error), cleanup: 'unconfirmed' });
      throw error;
    }
  };
}

async function loadInterpreter(loadPyodide) {
  // Pyodide 314.0.6 catches instantiation failure and only warns, leaving its
  // startup Promise pending. Observe native failures during this one bootstrap;
  // restore the original functions before attaching Tabgrad or running a script.
  const originals = new Map();
  try {
    if (typeof WebAssembly.instantiateStreaming !== 'function') {
      throw new Error('This browser cannot initialize the pinned Python WebAssembly runtime.');
    }
    for (const name of ['instantiate', 'instantiateStreaming']) {
      if (typeof WebAssembly[name] !== 'function') continue;
      originals.set(name, WebAssembly[name]);
      WebAssembly[name] = superviseInstantiation(WebAssembly[name]);
    }
    return await loadPyodide({
      indexURL: assets.pyodideBase,
      stdout: text => writeOutput('stdout', text),
      stderr: text => writeOutput('stderr', text),
    });
  } finally {
    for (const [name, original] of originals) WebAssembly[name] = original;
  }
}

async function start({ data }) {
  try {
    if (!data || !['python', 'javascript'].includes(data.language) || !['cpu', 'webgpu'].includes(data.device) || typeof data.source !== 'string') {
      throw new Error('Invalid playground request');
    }
    const result = await (data.language === 'python' ? python(data.source, data.device) : javascript(data.source, data.device));
    send({ kind: 'done', ...result });
  } catch (error) {
    send({ kind: 'failure', text: describeErrors(error) });
  }
}

function receive(event) {
  const port = event.data?.port;
  if (!(port instanceof MessagePort)) throw new Error('Missing playground control port');
  // The editable script has the global worker postMessage, not this private port.
  sendToHost = port.postMessage.bind(port);
  const runtimeBase = new URL(event.data?.runtimeBase, self.location.origin);
  const pyodideBase = new URL(event.data?.pyodideBase, self.location.origin);
  if (runtimeBase.origin !== self.location.origin || pyodideBase.origin !== self.location.origin
      || !runtimeBase.pathname.startsWith('/vendor/tabgrad/') || !pyodideBase.pathname.startsWith('/vendor/pyodide/')
      || runtimeBase.search || runtimeBase.hash || pyodideBase.search || pyodideBase.hash) {
    send({ kind: 'failure', text: 'Invalid same-origin playground asset locations.' });
    return;
  }
  assets = { runtimeBase: runtimeBase.href, pyodideBase: pyodideBase.href, webgpu: event.data.webgpu };
  void start(event);
}

addEventListener('message', receive, { once: true });
// A loader can reject an internal Promise without settling its public startup
// Promise. Report that failure instead of leaving the page in a loading state.
addEventListener('unhandledrejection', event => {
  event.preventDefault();
  send({ kind: 'failure', text: describe(event.reason), cleanup: 'unconfirmed' });
});
