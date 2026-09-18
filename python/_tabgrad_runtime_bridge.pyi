"""Consumed contracts of the private JavaScript module, not a Python engine."""

from array import array
from collections.abc import Sequence
from typing import Protocol

class RuntimeTensor(Protocol):
    @property
    def shape(self) -> Sequence[int]: ...
    @property
    def dtype(self) -> str: ...
    @property
    def device(self) -> str: ...
    def add(self, right: RuntimeTensor) -> RuntimeTensor: ...
    def close(self) -> None: ...

class RuntimeFailure(Protocol):
    code: str

class RuntimeException(Protocol):
    # Pyodide 314.0.6 exposes this on JsException at runtime, but omits it
    # from its distributed declaration. Real interpreter tests cover it.
    js_error: RuntimeFailure

class ObservedArray(Protocol):
    def to_py(self) -> memoryview: ...

def observe(handle: RuntimeTensor) -> ObservedArray: ...
def tensorFromBuffer(buffer: array[float]) -> RuntimeTensor: ...

session: object
