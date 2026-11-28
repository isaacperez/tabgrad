"""Tabgrad's Python compatibility package, attached to one runtime session."""

from __future__ import annotations

from array import array
from builtins import bool as _bool
from collections.abc import Iterable, Iterator
from json import loads
from math import prod
from operator import index
from types import NotImplementedType, TracebackType
from typing import (
    TYPE_CHECKING,
    Literal,
    NoReturn,
    SupportsIndex,
    TypeAlias,
    TypedDict,
    cast,
    overload,
)
from warnings import warn
from weakref import WeakValueDictionary, finalize

# JavaScript registers this module; its checked .pyi has no Python source file.
import _tabgrad_runtime_bridge as _bridge  # pyright: ignore[reportMissingModuleSource]
from pyodide.ffi import JsException, JsNull, jsnull, to_js

_runtime_session = _bridge.session

TensorList: TypeAlias = float | int | _bool | list["TensorList"]
_Typecode: TypeAlias = Literal["f", "d", "B", "i", "q"]
_live_wrappers: WeakValueDictionary[int, Tensor] = WeakValueDictionary()


class no_grad:
    """Disable new recording in this environment and restore its captured mode."""

    def __init__(self) -> None:
        self.prev = False

    def __enter__(self) -> None:
        # Capture assignment can fail (for example, on an invalid receiver).
        # Match native ordering: do not disable recording until it succeeds.
        self.prev = _bridge.getRecordingMode()
        _bridge.enterNoGrad()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        _bridge.exitNoGrad(self.prev)


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


class _DTypeFacts(TypedDict):
    name: str
    typecode: _Typecode
    is_floating_point: _bool
    is_complex: _bool
    is_signed: _bool


class dtype:
    """The exposed dtype objects are constants, not constructible descriptors."""

    __slots__ = ()

    def __new__(cls) -> dtype:
        raise TypeError("cannot create 'torch.dtype' instances")

    def __repr__(self) -> str:
        return f"torch.{self._facts()['name']}"

    def _facts(self) -> _DTypeFacts:
        return _dtype_facts.get(id(self), _float32_facts)

    @property
    def is_floating_point(self) -> _bool:
        return self._facts()["is_floating_point"]

    @property
    def is_complex(self) -> _bool:
        return self._facts()["is_complex"]

    @property
    def is_signed(self) -> _bool:
        return self._facts()["is_signed"]


# The matched private bridge produces these facts from the same definitions
# that select storage codecs. Only the canonical objects admit Python input.
_definitions = cast("list[_DTypeFacts]", loads(_bridge.dtypeDefinitions()))
_dtypes_by_name = {facts["name"]: object.__new__(dtype) for facts in _definitions}
_dtype_facts = {id(_dtypes_by_name[facts["name"]]): facts for facts in _definitions}
_float32_facts = _dtype_facts[id(_dtypes_by_name["float32"])]
# Runtime names come from the bridge; retain static types for the public API.
if TYPE_CHECKING:
    bfloat16: dtype
    bool: dtype
    float16: dtype
    float32: dtype
    int32: dtype
    int64: dtype
else:
    globals().update(_dtypes_by_name)
_explicit_dtype_error = (
    "Tabgrad requires explicit dtype="
    + " or ".join(f"torch.{name}" for name in _dtypes_by_name)
    + "."
)
del _definitions


def __getattr__(name: str) -> dtype:
    # Resolving this alias on the module keeps Python's built-in int available
    # to the conversion and validation code in this module.
    if name == "int":
        return _dtypes_by_name["int32"]
    if name == "long":
        return _dtypes_by_name["int64"]
    raise AttributeError(f"module 'torch' has no attribute {name!r}")


class device:
    """Unindexed execution device; WebGPU is an explicit Tabgrad extension."""

    __slots__ = ("_type",)
    _type: str

    def __init__(self, type: object) -> None:
        if not isinstance(type, str):
            raise TypeError("device type must be a string.")
        if type not in ("cpu", "webgpu"):
            raise RuntimeError("Tabgrad supports unindexed 'cpu' and 'webgpu' devices.")
        object.__setattr__(self, "_type", type)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("Device descriptors are immutable.")

    @property
    def type(self) -> str:
        return self._type

    @property
    def index(self) -> None:
        return None

    def __str__(self) -> str:
        return self.type

    def __repr__(self) -> str:
        return f"device(type='{self.type}')"

    def __eq__(self, other: object) -> _bool:
        return isinstance(other, device) and self.type == other.type

    def __hash__(self) -> int:
        return hash((self.type, self.index))


_CPU_DEVICE = device("cpu")
_WEBGPU_DEVICE = device("webgpu")


def _device_name(value: object) -> str:
    if type(value) is str and value in ("cpu", "webgpu"):
        return value
    if type(value) is device:
        return value.type
    raise RuntimeError("Tabgrad requires an unindexed 'cpu' or 'webgpu' device.")


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
        selected = _dtypes_by_name.get(self._handle.dtype)
        if selected is None:
            raise RuntimeError("Unsupported runtime dtype.")
        return selected

    @property
    def device(self) -> device:
        name = self._handle.device
        if name == "cpu":
            return _CPU_DEVICE
        if name == "webgpu":
            return _WEBGPU_DEVICE
        raise RuntimeError("Unsupported runtime device.")

    @property
    def requires_grad(self) -> _bool:
        return self._handle.requiresGrad

    @property
    def grad(self) -> Tensor | None:
        if _bridge.shouldWarnGradient(self._handle):
            warn(
                "The .grad attribute of a Tensor that is not a leaf is being accessed. Its .grad attribute will not be populated unless retained by backward inputs.",
                UserWarning,
                stacklevel=2,
            )
        handle = _bridge.gradientExposure(self._handle)
        return (
            None
            if handle is None or isinstance(handle, JsNull)
            else Tensor._from_handle(handle)
        )

    @grad.setter
    def grad(self, value: object) -> None:
        if value is not None and not isinstance(value, Tensor):
            raise TypeError("assigned grad must be a Tensor or None")
        try:
            self._handle.grad = jsnull if value is None else value._handle
        except JsException as error:
            _raise_gradient_failure(error)

    def backward(
        self,
        gradient: object = None,
        retain_graph: object = None,
        create_graph: object = False,
        inputs: object = None,
    ) -> None:
        """Accumulate first-order same-device gradients through the shared runtime."""
        _backward_mode("retain_graph", retain_graph, optional=True)
        _backward_mode("create_graph", create_graph)
        requested = _backward_inputs(inputs)
        seed = _backward_seed(gradient)
        try:
            _bridge.backward(
                self._handle,
                None
                if requested is None
                else to_js(
                    [
                        value._handle if isinstance(value, Tensor) else None
                        for value in requested
                    ]
                ),
                None if seed is None else seed._handle,
            )
        except JsException as error:
            if requested is not None and any(
                not isinstance(value, Tensor) for value in requested
            ):
                failure = cast("_bridge.RuntimeException", error)
                if failure.js_error.code == "INVALID_TENSOR":
                    raise RuntimeError("inputs must contain Tensors") from error
            _raise_gradient_failure(error)

    def add(self, other: object, *, alpha: object = 1) -> Tensor:
        if not isinstance(other, Tensor):
            raise TypeError("Tabgrad addition requires two tensors.")
        if type(alpha) is _bool:
            raise RuntimeError("Boolean alpha only supported for Boolean results.")
        if type(alpha) not in (int, float) or alpha != 1:
            raise RuntimeError("Tabgrad addition requires alpha=1.")
        try:
            return Tensor._from_handle(self._handle.add(other._handle))
        except JsException as error:
            _raise_view_history_failure(error)
            failure = cast("_bridge.RuntimeException", error)
            if failure.js_error.code == "SHAPE_MISMATCH":
                raise RuntimeError(
                    "Tensor shapes must be broadcast-compatible for addition."
                ) from error
            raise

    def __add__(self, other: object) -> Tensor | NotImplementedType:
        if not isinstance(other, Tensor):
            return NotImplemented
        return self.add(other)

    def mul(self, other: object) -> Tensor:
        """Admit a broadcast-compatible tensor product without observing its payload."""
        left = _require_mul_input(self)
        right = _require_mul_input(other)
        try:
            return Tensor._from_handle(left._handle.mul(right._handle))
        except JsException as error:
            _raise_view_history_failure(error)
            failure = cast("_bridge.RuntimeException", error)
            if failure.js_error.code == "SHAPE_MISMATCH":
                raise RuntimeError(
                    "Tensor shapes must be broadcast-compatible for multiplication."
                ) from error
            raise

    def __mul__(self, other: object) -> Tensor | NotImplementedType:
        left = _require_mul_input(self)
        if not isinstance(other, Tensor):
            return NotImplemented
        return left.mul(other)

    def gt(self, other: object) -> Tensor:
        """Compare two float32 tensors and return a boolean mask."""
        if not isinstance(other, Tensor):
            raise TypeError("Tabgrad comparison requires two tensors.")
        try:
            return Tensor._from_handle(self._handle.gt(other._handle))
        except JsException as error:
            failure = cast("_bridge.RuntimeException", error)
            if failure.js_error.code in (
                "SHAPE_MISMATCH",
                "UNSUPPORTED_DTYPE",
                "UNSUPPORTED_DEVICE",
            ):
                raise RuntimeError(str(error)) from error
            raise

    def __gt__(self, other: object) -> Tensor | NotImplementedType:
        if not isinstance(other, Tensor):
            return NotImplemented
        return self.gt(other)

    def matmul(self, other: object) -> Tensor:
        """Admit a same-device contiguous 2D float32 matrix product."""
        return _matrix_product(
            _require_matmul_input(self), _require_matmul_input(other)
        )

    def __matmul__(
        self, *args: object, **kwargs: object
    ) -> Tensor | NotImplementedType:
        left = _require_matmul_input(self)
        other = _matmul_operator_operand(args, kwargs)
        if not isinstance(other, Tensor):
            return NotImplemented
        return _matrix_product(left, _require_matmul_input(other))

    def __rmatmul__(
        self, *args: object, **kwargs: object
    ) -> Tensor | NotImplementedType:
        right = _require_matmul_input(self)
        other = _matmul_operator_operand(args, kwargs)
        if not isinstance(other, Tensor):
            return NotImplemented
        return _matrix_product(_require_matmul_input(other), right)

    def copy_(self: object, other: object, non_blocking: object = False) -> Tensor:
        """Replace this tensor's current value while preserving its identity.

        Equal-shape contiguous float32 tensors must share the session and device.
        Gradient recording follows the active no_grad context. non_blocking is
        accepted as a bool; publication uses the same ordered runtime path.
        """
        if not isinstance(self, Tensor) or not hasattr(self, "_handle"):
            raise TypeError("copy_ requires a tensor destination.")
        numeric = type(other) in (int, float, _bool)
        if not numeric and (
            not isinstance(other, Tensor) or not hasattr(other, "_handle")
        ):
            raise TypeError("copy_ requires a tensor source.")
        if type(non_blocking) is not _bool:
            raise TypeError("non_blocking must be bool.")
        if not isinstance(other, Tensor):
            raise RuntimeError(
                "Tabgrad copy_ requires a tensor source; scalar copy is unsupported."
            )
        try:
            self._handle.copy_(other._handle)
        except JsException as error:
            raise RuntimeError(str(error)) from error
        return self

    def sum(self) -> Tensor:
        """Admit a total reduction, preserving deferred runtime ownership."""
        source = _require_sum_input(self)
        try:
            return Tensor._from_handle(source._handle.sum())
        except JsException as error:
            _raise_view_history_failure(error)
            raise

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
            return Tensor._from_handle(_bridge.view(self._handle, to_js(dimensions)))
        except JsException as error:
            _raise_view_history_failure(error)
            failure = cast("_bridge.RuntimeException", error)
            if failure.js_error.code == "INVALID_SHAPE":
                raise RuntimeError(
                    "Invalid shape for contiguous tensor view."
                ) from error
            raise

    def argmax(self, dim: object = None, keepdim: _bool = False) -> Tensor:
        """Find the first maximum along an axis or across the whole tensor."""
        if type(keepdim) is not _bool:
            raise TypeError("argmax keepdim must be bool.")
        axis = None if dim is None else _require_axis(dim, len(self.shape))
        try:
            return Tensor._from_handle(self._handle.argmax(axis, keepdim))
        except JsException as error:
            failure = cast("_bridge.RuntimeException", error)
            if failure.js_error.code == "INVALID_SHAPE":
                raise IndexError(str(error)) from error
            if failure.js_error.code == "UNSUPPORTED_DTYPE":
                raise RuntimeError(str(error)) from error
            raise

    def tolist(self) -> TensorList:
        """Observe owned tensor values within the binding's managed script."""
        with _bridge.observe(self._handle).to_py() as values:
            selected = self.dtype
            return _nested_values(
                values, self.shape, _dtype_facts[id(selected)]["typecode"]
            )

    @staticmethod
    def _from_handle(handle: _bridge.RuntimeTensor) -> Tensor:
        try:
            key = _bridge.exposureKey(handle)
            existing = _live_wrappers.get(key)
            if existing is not None and _bridge.exposureOpen(existing._handle):
                if _bridge.sameExposure(handle, existing._handle):
                    return existing
                if _bridge.resultNeedsCompletion(handle, existing._handle):
                    _bridge.completeGradient(handle)
                # Common progress can call user code that closes the exposure.
                if _bridge.exposureOpen(existing._handle):
                    handle.close()
                    return existing
                # The replacement lease must also survive that progression.
                key = _bridge.exposureKey(handle)
            result = object.__new__(Tensor)
            result._handle = handle
            # The callback retains the JS handle, never its Python wrapper.
            finalize(result, _bridge.releaseExposure, handle)
            _live_wrappers[key] = result
            return result
        except BaseException as error:
            try:
                handle.close()
            except BaseException as cleanup:
                raise BaseExceptionGroup(
                    "Tensor wrapper conversion and cleanup failed.", [error, cleanup]
                ) from None
            raise


def _backward_mode(name: str, value: object, optional: _bool = False) -> None:
    if optional and value is None:
        return
    if type(value) not in (_bool, int):
        raise TypeError(f"{name} must be bool")
    if value:
        raise RuntimeError(f"Tabgrad does not support enabled {name}.")


def _backward_inputs(value: object) -> tuple[object, ...] | None:
    if value is None:
        return None
    if isinstance(value, Tensor):
        return (value,)
    if type(value) is dict:
        items = tuple(cast("dict[object, object]", value).values())
    else:
        try:
            items = tuple(cast("Iterable[object]", value))
        except TypeError as error:
            raise TypeError("inputs must be a Tensor or tensor iterable") from error
    if not items:
        raise RuntimeError("inputs must be a nonempty iterable of Tensors")
    return items


def _backward_seed(value: object) -> Tensor | None:
    if value is None or isinstance(value, Tensor):
        return value
    try:
        items = tuple(cast("Iterable[object]", value))
    except TypeError as error:
        raise TypeError(
            "gradient must be a Tensor, None, or one-element sequence"
        ) from error
    if len(items) == 1 and (items[0] is None or isinstance(items[0], Tensor)):
        return items[0]
    raise TypeError("gradient must be a Tensor, None, or one-element sequence")


def _raise_gradient_failure(error: JsException) -> NoReturn:
    failure = cast("_bridge.RuntimeException", error)
    if failure.js_error.code in {
        "INVALID_GRADIENT",
        "SHAPE_MISMATCH",
        "GRADIENT_NOT_TRACKED",
        "CONSUMED_HISTORY",
        "SAVED_VERSION_MISMATCH",
        "SAVED_DETACHED",
        "INPLACE_VIEW",
        "OVERLAPPING_COPY",
        "UNSUPPORTED_GRADIENT",
        "UNSUPPORTED_DEVICE",
    }:
        raise RuntimeError(str(error)) from error
    raise error


def _raise_view_history_failure(error: JsException) -> None:
    """Translate native view-history guards shared by tensor operations."""
    failure = cast("_bridge.RuntimeException", error)
    if failure.js_error.code == "INPLACE_VIEW":
        raise RuntimeError(str(error)) from error


def _append_numeric_values(items: Iterable[object], buffer: array[float]) -> None:
    """Convert a leaf row without per-element traversal or bridge bookkeeping."""
    for value in items:
        if not isinstance(value, (int, float)) or type(value) not in (
            int,
            float,
            _bool,
        ):
            raise TypeError("Tabgrad tensor elements must be built-in real numbers.")
        buffer.append(value)


def _append_boolean_values(items: Iterable[object], buffer: array[float]) -> None:
    for value in items:
        if type(value) not in (int, float, _bool):
            raise TypeError("Tabgrad tensor elements must be built-in real numbers.")
        buffer.append(int(_bool(value)))


def _append_integer_values(
    items: Iterable[object], buffer: array[int], bits: int
) -> None:
    lower, upper = -(1 << (bits - 1)), 1 << (bits - 1)
    for value in items:
        if type(value) in (int, _bool):
            integer = int(cast("int", value))
            if not -(1 << 63) <= integer < 1 << 63:
                raise ValueError("Overflow when unpacking long long")
        elif type(value) is float:
            if not lower <= value < upper:
                raise RuntimeError(
                    f"value cannot be converted to int{bits} without overflow"
                )
            integer = int(value)
        else:
            raise TypeError("Tabgrad tensor elements must be built-in real numbers.")
        if not lower <= integer < upper:
            raise RuntimeError(
                f"value cannot be converted to int{bits} without overflow"
            )
        buffer.append(integer)


def _input_buffer(
    data: object, typecode: _Typecode = "f"
) -> tuple[array[float] | array[int], list[int]]:
    """Normalize rectangular built-in containers without recursive traversal."""
    if typecode in ("i", "q"):
        integers: array[int] = array(typecode)
        buffer: array[float] | array[int] = integers
        bits = 32 if typecode == "i" else 64

        def append(items: Iterable[object]) -> None:
            _append_integer_values(items, integers, bits)
    else:
        numbers: array[float] = array(typecode)
        buffer = numbers
        convert = _append_boolean_values if typecode == "B" else _append_numeric_values

        def append(items: Iterable[object]) -> None:
            convert(items, numbers)

    if type(data) not in (list, tuple):
        append((data,))
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
            append(items)
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


def _observed_row(values: memoryview, boolean: _bool) -> list[TensorList]:
    if boolean:
        return [_bool(value) for value in values]
    return cast("list[TensorList]", values.tolist())


def _nested_values(values: memoryview, shape: Size, typecode: _Typecode) -> TensorList:
    """Build owned Python containers; only the current ancestor path is retained."""
    boolean = typecode == "B"
    if not shape:
        if boolean:
            return _bool(values[0])
        if typecode in ("i", "q"):
            return int(values[0])
        return float(values[0])
    if len(shape) == 1:
        return _observed_row(values, boolean)
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
                target.append(_observed_row(row, boolean))
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
    requires_grad: _bool = False,
    pin_memory: _bool = False,
) -> Tensor:
    """Copy numeric input into an explicitly typed, owned tensor."""
    facts = _dtype_facts.get(id(dtype))
    if facts is None:
        raise RuntimeError(_explicit_dtype_error)
    selected_device = _device_name(device)
    if type(requires_grad) is not _bool or type(pin_memory) is not _bool:
        raise TypeError("requires_grad and pin_memory must be bool.")
    if pin_memory:
        raise RuntimeError("Pinned memory is unsupported.")
    if requires_grad and not facts["is_floating_point"]:
        raise RuntimeError(
            "Only Tensors of floating point and complex dtype can require gradients"
        )
    buffer, shape = _input_buffer(data, facts["typecode"])
    # Creation and the sibling autograd frontend transfer owned bridge handles.
    return Tensor._from_handle(  # pyright: ignore[reportPrivateUsage]
        _bridge.tensorFromBuffer(
            buffer,
            to_js(shape),
            requires_grad,
            selected_device,
            facts["name"],
        )
    )


def add(
    input: object, other: object, *, alpha: object = 1, out: object = None
) -> Tensor:
    """Admit broadcast-compatible out-of-place addition through the shared runtime."""
    if not isinstance(input, Tensor):
        raise TypeError("Tabgrad addition requires two tensors.")
    if out is not None:
        raise RuntimeError("Tabgrad addition requires out=None.")
    return input.add(other, alpha=alpha)


def sum(input: object) -> Tensor:
    """Reduce every element of one tensor; reduction options are unsupported."""
    return _require_sum_input(input).sum()


def gt(input: object, other: object) -> Tensor:
    """Return an out-of-place boolean mask from two float32 tensors."""
    if not isinstance(input, Tensor):
        raise TypeError("Tabgrad comparison requires two tensors.")
    return input.gt(other)


def _require_axis(dim: object, rank: int) -> int:
    if not isinstance(dim, int) or isinstance(dim, _bool):
        raise TypeError("Dimension must be an int.")
    value = int.__index__(dim)
    if not -(1 << 63) <= value < 1 << 63:
        raise ValueError("Overflow when unpacking long long")
    extent = max(1, rank)
    if not -extent <= value < extent:
        raise IndexError("Dimension out of range.")
    return value


def argmax(
    input: object, dim: object = None, keepdim: _bool = False, *, out: object = None
) -> Tensor:
    """Return same-device int64 indices of the first maximum."""
    if not isinstance(input, Tensor):
        raise TypeError("Tabgrad argmax requires a tensor.")
    if out is not None:
        raise RuntimeError("Tabgrad argmax requires out=None.")
    return input.argmax(dim, keepdim)


def where(condition: object, input: object, other: object) -> Tensor:
    """Select elements from two float32 tensors using a boolean tensor."""
    if (
        not isinstance(condition, Tensor)
        or not isinstance(input, Tensor)
        or not isinstance(other, Tensor)
    ):
        raise TypeError("Tabgrad selection requires three tensors.")
    try:
        return Tensor._from_handle(  # pyright: ignore[reportPrivateUsage]
            _bridge.where(condition._handle, input._handle, other._handle)  # pyright: ignore[reportPrivateUsage]
        )
    except JsException as error:
        _raise_view_history_failure(error)
        failure = cast("_bridge.RuntimeException", error)
        if failure.js_error.code in (
            "SHAPE_MISMATCH",
            "UNSUPPORTED_DTYPE",
            "UNSUPPORTED_DEVICE",
        ):
            raise RuntimeError(str(error)) from error
        raise


def mul(input: object, other: object, *, out: object = None) -> Tensor:
    """Multiply broadcast-compatible tensors out of place; only out=None is supported."""
    left = _require_mul_input(input)
    if out is not None:
        raise RuntimeError("Tabgrad multiplication requires out=None.")
    return left.mul(other)


def matmul(input: object, other: object, *, out: object = None) -> Tensor:
    """Multiply two matrices out of place; only out=None is supported."""
    left = _require_matmul_input(input)
    right = _require_matmul_input(other)
    if out is not None:
        if not isinstance(out, Tensor):
            raise TypeError("matmul out must be a tensor or None.")
        raise RuntimeError("Tabgrad matrix multiplication requires out=None.")
    return _matrix_product(left, right)


def _require_matmul_input(value: object) -> Tensor:
    if not isinstance(value, Tensor) or not hasattr(value, "_handle"):
        raise TypeError("Tabgrad matrix multiplication requires two tensors.")
    return value


def _matmul_operator_operand(
    args: tuple[object, ...], kwargs: dict[str, object]
) -> object:
    """Native direct dunders decline malformed arguments for reflected dispatch."""
    if len(args) == 1 and not kwargs:
        return args[0]
    if not args and kwargs.keys() == {"other"}:
        return kwargs["other"]
    return NotImplemented


def _matrix_product(left: Tensor, right: Tensor) -> Tensor:
    try:
        # Functional, method and operator forms share this opaque bridge transfer.
        return Tensor._from_handle(left._handle.matmul(right._handle))  # pyright: ignore[reportPrivateUsage]
    except JsException as error:
        _raise_view_history_failure(error)
        failure = cast("_bridge.RuntimeException", error)
        if failure.js_error.code in ("SHAPE_MISMATCH", "INVALID_SHAPE"):
            raise RuntimeError(
                "Matrix multiplication requires compatible 2D shapes."
            ) from error
        if failure.js_error.code == "RESOURCE_EXHAUSTED":
            raise RuntimeError(str(error)) from error
        raise


def _require_mul_input(value: object) -> Tensor:
    """Reject malformed wrappers before reaching the checked runtime handle."""
    if not isinstance(value, Tensor) or not hasattr(value, "_handle"):
        raise TypeError("Tabgrad multiplication requires two tensors.")
    return value


def _require_sum_input(value: object) -> Tensor:
    """Validate functional arguments and explicitly unbound method receivers."""
    if not isinstance(value, Tensor):
        raise TypeError("Tabgrad sum requires a tensor.")
    return value


# The submodule consumes the initialized Tensor class.
from . import autograd, optim  # noqa: E402

__all__ = [
    "Size",
    "Tensor",
    "add",
    "argmax",
    "autograd",
    "device",
    "dtype",
    "gt",
    "matmul",
    "mul",
    "no_grad",
    "optim",
    "sum",
    "tensor",
    "where",
]
if TYPE_CHECKING:
    __all__ += ["bfloat16", "bool", "float16", "float32", "int32", "int64"]
else:
    __all__[:] = sorted([*__all__, *_dtypes_by_name, "int", "long"])
