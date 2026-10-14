# Browser package installation

Tabgrad is an independent browser-native tensor runtime with direct JavaScript
and optional Python interfaces. It implements the documented subset of the
PyTorch API; it does not distribute the official PyTorch runtime.

## Install the inspected files

Install a supplied, inspected candidate tarball with package scripts disabled:

```console
npm install ./path/to/tabgrad-package.tgz --ignore-scripts --no-audit --no-fund
```

The candidate retains its source manifest's name, version and private flag.
This is an offline installation path, not evidence that the name/version is
published in a registry or that a publisher controls that namespace. An actual
release follows the [release policy](https://github.com/isaacperez/tabgrad/blob/main/docs/releases.md).

Copy the installed package's complete `dist/` tree into an application-owned
static directory, such as `/vendor/tabgrad/`. The prepared candidate also
provides the identical tree at `package/dist/`. Serve JavaScript as modules,
JSON as JSON and WebAssembly as `application/wasm` in a secure context. Preserve
the tree and update or restore the complete matched set together.

| Package entry | Role |
| --- | --- |
| `@tabgrad/tabgrad` | Direct JavaScript interface and types |
| `@tabgrad/tabgrad/python` | Optional Python integration and types |
| `@tabgrad/tabgrad/webgpu-worker` | Resource URL for the compatible physical worker; do not execute it in the application realm |
| `@tabgrad/tabgrad/assets/manifest.json` | CPU asset manifest |
| `@tabgrad/tabgrad/assets/wasm/*` | CPU binaries |
| `@tabgrad/tabgrad/assets/python/*` | Python source and installation manifest |

These aliases describe the inspected candidate's development identity. Private
implementation paths and the standalone testing entry are not public entries.
In plain browser code, use explicit static module URLs or an application
import map. A package alias alone does not teach a browser to resolve npm names.
Arbitrary bundler/CDN transformations are not qualified by this installation.

## Run direct JavaScript

```javascript
import { createRuntimeSession } from "/vendor/tabgrad/index.js";

const session = createRuntimeSession();
const x = session.tensor([1, 2], { requiresGrad: true });
const weights = session.tensor([3, 4]);
const product = x.mul(weights);
const loss = product.sum();
const [gradient] = session.grad(loss, [x]);
try {
  console.log(Array.from(await loss.toArray())); // [11]
  console.log(Array.from(await gradient.toArray())); // [3, 4]
} finally {
  gradient.close(); loss.close(); product.close(); weights.close(); x.close();
  await session.close();
}
```

The direct entry does not load Python or an interpreter. Defaults remain CPU;
GPU selection is explicit, with no silent fallback. Consult the
[JavaScript reference](https://github.com/isaacperez/tabgrad/blob/main/docs/javascript-api.md)
for signatures, errors, supported operations and lifetimes.

## Attach application-owned Python

The application supplies the admitted Pyodide version and owns its interpreter
worker, startup and failure reporting. Import `python.js` from the same tree
and attach the borrowed interpreter through the
[host contract](https://github.com/isaacperez/tabgrad/blob/main/docs/reference/python-host.md).
Pyodide is neither a dependency bundled here nor an automatic loader.

For managed GPU use, acquire `createWebGpuWorker()` outside the interpreter
worker, transfer its single-use connection, and join cooperative binding close
followed by controller close. The physical worker entry must have the caller
document's origin. Secure cross-origin isolation and a supported real WebGPU
adapter are required; module CORS does not replace the worker origin rule.

The distribution and package version do not replace the CPU ABI, Python bridge
or Pyodide admission checks. Missing, corrupt or incompatible assets fail
explicitly. Hash validation covers recorded asset bytes; it is not a signature
or universal detection of arbitrary mixed releases. Numerical, browser and GPU
support retain the limits of the
[compatibility record](https://github.com/isaacperez/tabgrad/blob/main/docs/compatibility.md).
