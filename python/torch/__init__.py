"""Tabgrad's Python compatibility package, attached to one runtime session."""

from __future__ import annotations

from array import array
from collections.abc import Iterable
from math import prod
from operator import index
from types import NotImplementedType
from typing import SupportsIndex, cast, overload
from weakref import finalize

# JavaScript registers this module; its checked .pyi has no Python source file.
import _tabgrad_runtime_bridge as _bridge  # pyright: ignore[reportMissingModuleSource]
from pyodide.ffi import JsException

_runtime_session = _bridge.session


class Size(tuple[int, ...]):
    """Immutable Python presentation of dimensions supplied by the runtime."""

    __slots__ = ()

    def __new__(cls, iterable: Iterable[object] = ()) -> Size:
        dimensions: list[int] = []
        for dimension in iterable:
            if not isinstance(dimension, SupportsIndex):
                raise TypeError("torch.Size requires integer dimensions.")
            dimensions.append(index(dimension))
        return super().__new__(cls, dimensions)

    def __repr__(self) -> str:
        return f"torch.Size({list(self)!r})"

    @overload
    def __getitem__(self, key: SupportsIndex) -> int: ...

    @overload
    def __getitem__(self, key: slice) -> Size: ...

    def __getitem__(self, key: SupportsIndex | slice) -> int | Size:
        if isinstance(key, slice):
            return Size(super().__getitem__(key))
        return super().__getitem__(key)

    def __add__(self, value: tuple[object, ...]) -> Size:
        return Size(super().__add__(value))

    def __mul__(self, value: SupportsIndex) -> Size:
        return Size(super().__mul__(value))

    __rmul__ = __mul__

    def numel(self) -> int:
        return prod(self)


class dtype:
    """The exposed dtype objects are constants, not constructible descriptors."""

    __slots__ = ()

    def __new__(cls) -> dtype:
        raise TypeError("cannot create 'torch.dtype' instances")

    def __repr__(self) -> str:
        return "torch.float32"

    @property
    def is_floating_point(self) -> bool:
        return True

    @property
    def is_complex(self) -> bool:
        return False

    @property
    def is_signed(self) -> bool:
        return True


float32 = object.__new__(dtype)


class device:
    """CPU device descriptor; other devices and indexed devices are unsupported."""

    __slots__ = ()

    def __init__(self, type: object) -> None:
        if not isinstance(type, str):
            raise TypeError("device type must be a string.")
        if type != "cpu":
            raise RuntimeError("Tabgrad supports only device='cpu'.")

    @property
    def type(self) -> str:
        return "cpu"

    @property
    def index(self) -> None:
        return None

    def __str__(self) -> str:
        return "cpu"

    def __repr__(self) -> str:
        return "device(type='cpu')"

    def __eq__(self, other: object) -> bool:
        return isinstance(other, device)

    def __hash__(self) -> int:
        return hash((self.type, self.index))


_CPU_DEVICE = device("cpu")


def _is_cpu_device(value: object) -> bool:
    return (type(value) is str and value == "cpu") or type(value) is device


class Tensor:
    """Own one runtime handle without owning another graph or payload."""

    __slots__ = ("__weakref__", "_handle")
    _handle: _bridge.RuntimeTensor

    def __new__(cls) -> Tensor:
        raise TypeError("Use torch.tensor to create a Tabgrad tensor.")

    @property
    def shape(self) -> Size:
        return Size(self._handle.shape)

    @property
    def dtype(self) -> dtype:
        if self._handle.dtype != "float32":
            raise RuntimeError("Unsupported runtime dtype.")
        return float32

    @property
    def device(self) -> device:
        if self._handle.device != "cpu":
            raise RuntimeError("Unsupported runtime device.")
        return _CPU_DEVICE

    def add(self, other: object, *, alpha: object = 1) -> Tensor:
        if not isinstance(other, Tensor):
            raise TypeError("Tabgrad addition requires two tensors.")
        if type(alpha) is bool:
            raise RuntimeError("Boolean alpha only supported for Boolean results.")
        if type(alpha) not in (int, float) or alpha != 1:
            raise RuntimeError("Tabgrad addition requires alpha=1.")
        try:
            return Tensor._from_handle(self._handle.add(other._handle))
        except JsException as error:
            failure = cast("_bridge.RuntimeException", error)
            if failure.js_error.code == "SHAPE_MISMATCH":
                raise RuntimeError("Tensor shapes must match for addition.") from error
            raise

    def __add__(self, other: object) -> Tensor | NotImplementedType:
        if not isinstance(other, Tensor):
            return NotImplemented
        return self.add(other)

    def tolist(self) -> list[float]:
        """Observe owned numerical values within the binding's managed script."""
        with _bridge.observe(self._handle).to_py() as values:
            # Typeshed models memoryview lists as ints; this bridge returns
            # Float32Array buffers, whose elements convert to Python floats.
            return cast("list[float]", values.tolist())

    @staticmethod
    def _from_handle(handle: _bridge.RuntimeTensor) -> Tensor:
        try:
            result = object.__new__(Tensor)
            result._handle = handle
            # The callback retains the JS handle, never its Python wrapper.
            finalize(result, handle.close)
            return result
        except BaseException:
            handle.close()
            raise


def _input_buffer(data: object) -> array[float]:
    if type(data) not in (list, tuple):
        raise TypeError("Tabgrad tensor input must be a flat numeric list or tuple.")
    # The outer container was checked; no element type is trusted by this cast.
    items = cast("list[object] | tuple[object, ...]", data)
    buffer = array("f")
    for value in items:
        if not isinstance(value, (int, float)) or type(value) not in (int, float, bool):
            raise TypeError("Tabgrad tensor elements must be built-in real numbers.")
        buffer.append(value)
    return buffer


def tensor(
    data: object,
    *,
    dtype: object = None,
    device: object = "cpu",
    requires_grad: bool = False,
    pin_memory: bool = False,
) -> Tensor:
    """Copy a flat numeric list/tuple into a rank-one CPU float32 tensor."""
    if dtype is not float32:
        raise RuntimeError("Tabgrad requires explicit dtype=torch.float32.")
    if not _is_cpu_device(device):
        raise RuntimeError("Tabgrad supports only device='cpu'.")
    if type(requires_grad) is not bool or type(pin_memory) is not bool:
        raise TypeError("requires_grad and pin_memory must be bool.")
    if requires_grad or pin_memory:
        raise RuntimeError("Gradients and pinned memory are unsupported.")
    # The module-level factory is the only caller outside the owning class.
    return Tensor._from_handle(_bridge.tensorFromBuffer(_input_buffer(data)))  # pyright: ignore[reportPrivateUsage]


def add(
    input: object, other: object, *, alpha: object = 1, out: object = None
) -> Tensor:
    """Admit equal-shape out-of-place addition through the shared runtime."""
    if not isinstance(input, Tensor):
        raise TypeError("Tabgrad addition requires two tensors.")
    if out is not None:
        raise RuntimeError("Tabgrad addition requires out=None.")
    return input.add(other, alpha=alpha)


__all__ = ["Size", "Tensor", "add", "device", "dtype", "float32", "tensor"]
