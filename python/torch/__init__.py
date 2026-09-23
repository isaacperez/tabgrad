"""Tabgrad's Python compatibility package, attached to one runtime session."""

from __future__ import annotations

from array import array
from collections.abc import Iterable, Iterator
from math import prod
from operator import index
from types import NotImplementedType
from typing import SupportsIndex, TypeAlias, cast, overload
from weakref import finalize

# JavaScript registers this module; its checked .pyi has no Python source file.
import _tabgrad_runtime_bridge as _bridge  # pyright: ignore[reportMissingModuleSource]
from pyodide.ffi import JsException, to_js

_runtime_session = _bridge.session

TensorList: TypeAlias = float | list["TensorList"]


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

    def view(self, *shape: object) -> Tensor:
        """Share contiguous storage with a shape, optionally inferring one -1."""
        if not shape:
            raise TypeError("view requires dimensions or one built-in tuple/list.")
        dimensions = shape
        if len(shape) == 1 and type(shape[0]) in (tuple, list):
            dimensions = tuple(cast("tuple[object, ...] | list[object]", shape[0]))
        if any(type(dimension) is not int for dimension in dimensions):
            raise TypeError("view dimensions must be built-in integers.")
        try:
            return Tensor._from_handle(self._handle.view(to_js(dimensions)))
        except JsException as error:
            failure = cast("_bridge.RuntimeException", error)
            if failure.js_error.code == "INVALID_SHAPE":
                raise RuntimeError(
                    "Invalid shape for contiguous tensor view."
                ) from error
            raise

    def tolist(self) -> TensorList:
        """Observe owned numerical values within the binding's managed script."""
        with _bridge.observe(self._handle).to_py() as values:
            return _nested_values(values, self.shape)

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


def _append_numeric_values(items: Iterable[object], buffer: array[float]) -> None:
    """Convert a leaf row without per-element traversal or bridge bookkeeping."""
    for value in items:
        if not isinstance(value, (int, float)) or type(value) not in (int, float, bool):
            raise TypeError("Tabgrad tensor elements must be built-in real numbers.")
        buffer.append(value)


def _input_buffer(data: object) -> tuple[array[float], list[int]]:
    """Normalize rectangular built-in containers without recursive traversal."""
    buffer = array("f")
    if type(data) not in (list, tuple):
        _append_numeric_values((data,), buffer)
        return buffer, []
    shape: list[int] = []
    frames: list[tuple[Iterator[object], int]] = []
    active: set[int] = set()
    terminal_depth: int | None = None
    value, depth = data, 0
    while True:
        if type(value) in (list, tuple):
            # Only the container type is trusted; each child is validated below.
            items = cast("list[object] | tuple[object, ...]", value)
            if id(items) in active:
                raise ValueError("Tensor input must not contain a cycle.")
            if terminal_depth is not None and depth >= terminal_depth:
                raise TypeError("Tensor input must have uniform nesting depth.")
            if depth == len(shape):
                shape.append(len(items))
            elif shape[depth] != len(items):
                raise ValueError("Tensor input must be rectangular.")
            if items and type(items[0]) in (list, tuple):
                active.add(id(items))
                children = iter(items)
                frames.append((children, id(items)))
                value, depth = next(children), depth + 1
                continue
            _append_numeric_values(items, buffer)
            leaf_depth = depth + 1
        else:
            raise TypeError("Tensor input must have uniform nesting depth.")
        if terminal_depth is None:
            terminal_depth = leaf_depth
        elif terminal_depth != leaf_depth:
            raise TypeError("Tensor input must have uniform nesting depth.")
        while frames:
            children, identity = frames[-1]
            try:
                value, depth = next(children), len(frames)
                break
            except StopIteration:
                active.remove(identity)
                frames.pop()
        else:
            return buffer, shape


def _nested_values(values: memoryview, shape: Size) -> TensorList:
    """Build owned Python containers; only the current ancestor path is retained."""
    if not shape:
        return float(values[0])
    if len(shape) == 1:
        return cast("list[TensorList]", values.tolist())
    result: list[TensorList] = []
    frames: list[tuple[list[TensorList], int]] = [(result, 0)]
    offset = 0
    while frames:
        target, depth = frames[-1]
        if len(target) == shape[depth]:
            frames.pop()
        elif depth == len(shape) - 2:
            width = shape[depth + 1]
            with values[offset : offset + width] as row:
                # The bridge exposes float32, although typeshed models integer
                # memoryview elements. Conversion owns the resulting floats.
                target.append(cast("list[TensorList]", row.tolist()))
            offset += width
        else:
            child: list[TensorList] = []
            target.append(child)
            frames.append((child, depth + 1))
    return result


def tensor(
    data: object,
    *,
    dtype: object = None,
    device: object = "cpu",
    requires_grad: bool = False,
    pin_memory: bool = False,
) -> Tensor:
    """Copy a numeric scalar or rectangular list/tuple into a CPU float32 tensor."""
    if dtype is not float32:
        raise RuntimeError("Tabgrad requires explicit dtype=torch.float32.")
    if not _is_cpu_device(device):
        raise RuntimeError("Tabgrad supports only device='cpu'.")
    if type(requires_grad) is not bool or type(pin_memory) is not bool:
        raise TypeError("requires_grad and pin_memory must be bool.")
    if requires_grad or pin_memory:
        raise RuntimeError("Gradients and pinned memory are unsupported.")
    buffer, shape = _input_buffer(data)
    # The module-level factory is the only caller outside the owning class.
    return Tensor._from_handle(_bridge.tensorFromBuffer(buffer, to_js(shape)))  # pyright: ignore[reportPrivateUsage]


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
