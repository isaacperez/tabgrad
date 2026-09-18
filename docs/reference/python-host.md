# Python host attachment and worker connection

This reference is for applications embedding Tabgrad's Python frontend.
It describes the separate browser entry `python.js` from the built static
distribution. Serve it with the matching JavaScript, CPU and `python/` assets;
the application supplies pinned Pyodide 314.0.6. Importing Tabgrad's direct
JavaScript root does not load Python integration or interpreter assets.
For motivation, read the [integration architecture](../architecture/python-integration.md)
and [worker connection](../components/python-worker-connection.md).

## Attach in the interpreter worker

`attachPython(interpreter, options?) -> Promise<PythonBinding>` borrows the
prepared interpreter and owns one runtime session. `options.manifestUrl?: URL`
locates the matching Python asset manifest; its default is
`python/manifest.json` relative to the emitted integration module. Attachment
validates and installs those assets transactionally. It does not load Pyodide,
create a worker or move an existing page interpreter.

The returned binding provides:

| Method | Result and contract |
| --- | --- |
| `runPythonAsync(source: string): Promise<void>` | Reserve one managed script, prepare CPU once before Python starts, execute in preserved host globals, and destroy any returned owned Python proxy before settlement. |
| `close(): Promise<void>` | Stop admission, join the accepted script, drain the session and remove owned installation state. Repeated calls share completion; interpreter and host globals remain. |

The host must not concurrently enter raw Pyodide or drive the local binding
around an active service. Scripts must join their background tasks. Closure
is cooperative; it cannot interrupt an infinite or externally stalled script.
Ordinary tensor methods such as `tolist()` do not require Python `await` or
JSPI. The JavaScript script-entry Promise has a different purpose.

## Connect the external host

`connectPythonWorker(port: MessagePort, signal?: AbortSignal): PythonBinding`
takes ownership of one dedicated host-side port and returns synchronously.
Transfer its peer to the application-owned interpreter worker. The returned
binding has the same two methods above, but reserves admission outside that
worker before posting any script. It rejects overlapping calls immediately
through their Promises, even when the worker cannot process messages.

There is no implicit readiness handshake or bootstrap loader. An entry may be
reserved before the service starts listening; delivery waits for the peer.
The application must observe bootstrap failure and signal connection loss,
rather than leaving an accepted call waiting for a service that never starts.
Closing before any script still requires an acknowledgment from the service.

`servePythonWorker(binding: PythonBinding, port: MessagePort, signal?: AbortSignal): Promise<void>`
installs the worker-side receiver over an already attached local binding. It
takes responsibility for that binding's cooperative close and owns the supplied
port. The Promise remains pending through the service lifetime and settles
after closure and port release. Observe its rejection, including failures of
cleanup or transport. Do not reuse the binding for independent managed entry
while it is served.

Both endpoints consume their supplied ports exclusively; do not attach other
protocol listeners, transfer them again or close them directly. A consumed port
cannot be reused. Supplying an already owned port or an already served binding
throws `PYTHON_CONNECTION_IN_USE` synchronously.

The optional signal reports connection loss, not script cancellation. An
already aborted signal establishes a failed connection. An abort on the host
rejects pending work without asserting remote cleanup; an abort in the worker
joins accepted work and attempts local binding cleanup before the service
rejects. The host owns failure detection and must signal known bootstrap or
worker failure and forced termination. If it cannot receive a protocol reply,
it forwards service failure over its own application channel. Neither silent
peer loss nor a hung script is automatically timed out or restarted.

## Compose the two endpoints

The essential application wiring is below. The message containing `port` is
application bootstrap, not a Tabgrad protocol message. The application handles
worker startup/errors separately from the dedicated port.

```javascript
// Application page: application-owned URL and failure reporting.
import { connectPythonWorker } from './tabgrad/python.js';

const lifetime = new AbortController();
const worker = new Worker('./interpreter-worker.js', { type: 'module' });
worker.addEventListener('error', event => lifetime.abort(new Error(event.message)));
worker.addEventListener('message', event => {
  if (event.data.kind === 'failure') lifetime.abort(new Error(event.data.message));
});
const channel = new MessageChannel();
const binding = connectPythonWorker(channel.port1, lifetime.signal);
worker.postMessage({ port: channel.port2 }, [channel.port2]);

try {
  await binding.runPythonAsync(`
import torch
a = torch.tensor([1.0, 2.0], dtype=torch.float32)
b = torch.tensor([3.0, 4.0], dtype=torch.float32)
print((a + b).tolist())
`);
} catch (error) {
  console.error('Script or preparation failed', error);
} finally {
  try { await binding.close(); }
  catch (error) { console.error('Closure was not acknowledged as successful', error); }
}
// The application still owns worker. Do not infer remote drain after a failed close.
```

```javascript
// interpreter-worker.js: static, pinned Pyodide files supplied by the application.
import { loadPyodide } from './pyodide/pyodide.mjs';
import { attachPython, servePythonWorker } from './tabgrad/python.js';

addEventListener('message', async event => {
  try {
    const interpreter = await loadPyodide({ indexURL: './pyodide/' });
    const binding = await attachPython(interpreter);
    await servePythonWorker(binding, event.data.port);
    // interpreter and its globals remain available to application code here.
  } catch (error) {
    postMessage({ kind: 'failure', message: String(error) });
  }
}, { once: true });
```

The expected Python output is `[4.0, 6.0]`. The production-artifact
[worker integration check](../../js-tests/browser/python-worker.html) exercises
this composition with a more explicit application readiness/result channel,
worker-local capability controls and lifecycle assertions. Application URLs,
stdout presentation and termination policy belong to the embedding host, not
to the connection helpers. If the application forcibly terminates its worker,
it first aborts the connection lifetime; it must not claim that this is
equivalent to successful `binding.close()`.

## Errors at each boundary

| Boundary | Reported behavior |
| --- | --- |
| Duplicate or incompatible attachment | `PYTHON_ALREADY_ATTACHED` or `UNSUPPORTED_PYODIDE`; asset and installation failures retain their existing codes. |
| Busy host entry | Rejected Promise with `PYTHON_ENTRY_BUSY`; source is not dispatched. |
| Entry after close or failed connection | Rejected Promise with `CLOSED_PYTHON_BINDING`. |
| Non-string host source | Rejected `TypeError` before dispatch when the connection is open and idle. |
| Known loss, malformed reply or failed send | `PYTHON_CONNECTION_LOST`; no remote drain acknowledgment is implied. |
| Script or cleanup failure received from the worker | `PythonWorkerError` diagnostic, preserving the remote name, message, stack and available cause/aggregate details. |

`PythonWorkerError` extends `Error`, but is not the original remote exception.
Its `code` and `details` preserve available Tabgrad diagnostics;
`executionContext` carries an available runtime diagnostic summary without the
executable program. Its `cause` and `errors` describe cause/aggregate
relationships. These fields are absent when the original failure did not
provide them. A Pyodide `PythonError` supplies its traceback, not a live Python
exception or automatic reconstruction of every nested JavaScript error.
Applications should not assume `instanceof TabgradError` across realms.

The supported CPU composition uses dedicated workers and message ports but
does not require shared memory or cross-origin isolation. GPU deployment has
separate requirements in the [observation architecture](../architecture/python-observation.md).
Exact browser evidence and public-operation limits remain bounded by the
[compatibility policy](../compatibility.md) and [Python tensor reference](python-tensors.md).
