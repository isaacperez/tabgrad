# Tabgrad

Tabgrad is an independent browser-native tensor runtime for running Python
locally with a PyTorch-compatible API on WebGPU and CPU.

Tabgrad is not affiliated with or endorsed by the PyTorch Foundation. It is an
independent implementation of a documented subset of the PyTorch Python API for
browser execution.

## Purpose

Tabgrad is designed to let people write familiar Python tensor and neural
network code in a browser while keeping execution on their own device. It does
not run the official PyTorch runtime or require a server to execute tensor
operations.

Tabgrad supports both inference and training through a tensor
runtime, automatic differentiation, and CPU and WebGPU backends implemented by
Tabgrad.

## Python experience

Code running inside an environment controlled by Tabgrad uses familiar
PyTorch imports:

```python
import torch
import torch.nn as nn
import torch.nn.functional as F

x = torch.tensor([-1.0, 2.0], requires_grad=True)
y = torch.relu(x)
y.sum().backward()
```

In that environment, `torch` refers to Tabgrad's compatibility layer, not to
the official PyTorch package. Public packages and distributions use the
Tabgrad name and are not published as `torch`.

## Execution model

Pyodide executes the user's Python code in the browser. A Python compatibility
layer exposes the supported API and connects Python calls to the Tabgrad tensor
runtime. The Tabgrad runtime performs tensor operations and automatic
differentiation on its CPU or WebGPU backend.

Pyodide provides the Python interpreter and the connection between Python and
JavaScript. It does not provide PyTorch or call Tabgrad automatically. Tabgrad
must provide and maintain that integration.

The tensor runtime can also be used directly from JavaScript without Pyodide.
Pyodide is required for the Python experience in the browser, but it is not the
tensor runtime itself.

## Compatibility

Compatibility is a testable claim about a documented subset of PyTorch. For an
operation described as compatible, Tabgrad should match the relevant PyTorch
behavior, including shapes, data types, values, gradients, and errors.

Unsupported behavior must fail clearly. Tabgrad must not silently substitute a
different operation or move work from WebGPU to CPU without making that choice
explicit.

The official PyTorch runtime may be used during development as a test oracle.
It is not a Tabgrad runtime dependency.

The format and evidence required for compatibility claims are defined in
[`docs/compatibility.md`](docs/compatibility.md).

## Principles

- User code and tensor data remain on the user's device unless the user
  explicitly requests an external operation.
- Tabgrad must implement and maintain its tensor runtime independently.
- CPU behavior provides a reference for checking WebGPU behavior.
- Compatibility claims are documented and verified by tests.
- Third-party code is reused only when its license permits reuse and its origin
  and required attribution are documented.
- The core should remain small enough to understand, test, and maintain.

## License

Tabgrad is licensed under the [Apache License 2.0](LICENSE).
