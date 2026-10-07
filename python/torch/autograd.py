"""First-order functional gradients through Tabgrad's shared runtime."""

from collections.abc import Sequence
from typing import cast

# JavaScript registers this module; its checked .pyi has no Python source file.
import _tabgrad_runtime_bridge as _bridge  # pyright: ignore[reportMissingModuleSource]
from pyodide.ffi import JsException, to_js

# Sibling frontends share the package's internal derivative error presentation.
from . import (
    Tensor,
    _raise_gradient_failure,  # pyright: ignore[reportPrivateUsage]
)


def _tensors(value: object, name: str) -> tuple[Tensor, ...]:
    if isinstance(value, Tensor):
        values = (value,)
    elif isinstance(value, Sequence):
        values = tuple(cast("Sequence[object]", value))
    else:
        raise TypeError(f"{name} requires a tensor or nonempty tensor sequence.")
    if not values or any(
        not isinstance(item, Tensor) or not hasattr(item, "_handle") for item in values
    ):
        raise TypeError(f"{name} requires a tensor or nonempty tensor sequence.")
    return cast("tuple[Tensor, ...]", values)


def _seed(value: object) -> Tensor | None:
    if value is None or isinstance(value, Tensor):
        return value
    if isinstance(value, Sequence):
        values = tuple(cast("Sequence[object]", value))
        if len(values) == 1 and (values[0] is None or isinstance(values[0], Tensor)):
            return values[0]
    raise TypeError(
        "grad_outputs requires one tensor, None, or a one-element sequence."
    )


def _mode(name: str, value: object, supported: bool, optional: bool = False) -> None:
    if optional and value is None:
        return
    if type(value) is not bool:
        raise TypeError(f"{name} must be bool" + (" or None." if optional else "."))
    if value is not supported:
        raise RuntimeError(
            f"Tabgrad functional gradients do not support {name}={value}."
        )


def grad(
    outputs: object,
    inputs: object,
    grad_outputs: object = None,
    retain_graph: bool | None = None,
    create_graph: bool = False,
    only_inputs: bool = True,
    allow_unused: bool | None = None,
    is_grads_batched: bool = False,
    materialize_grads: bool = False,
) -> tuple[Tensor, ...]:
    """Return untracked first-order gradients for one output and requested inputs.

    Seeds must match the output shape and must not require gradients. Omitting
    the seed requires a one-element output. Saved multiplication history is
    consumed once. Leaves do not accumulate; already retained nonleaves can
    receive contributions. No higher-order graph is created.
    """
    _mode("retain_graph", retain_graph, False, optional=True)
    _mode("create_graph", create_graph, False)
    _mode("only_inputs", only_inputs, True)
    _mode("allow_unused", allow_unused, False, optional=True)
    _mode("is_grads_batched", is_grads_batched, False)
    _mode("materialize_grads", materialize_grads, False)
    normalized_outputs = _tensors(outputs, "outputs")
    if len(normalized_outputs) != 1:
        raise TypeError("Tabgrad functional gradients require exactly one output.")
    requested = _tensors(inputs, "inputs")
    seed = _seed(grad_outputs)
    if seed is not None and not hasattr(seed, "_handle"):
        raise TypeError("grad_outputs requires a valid tensor.")
    try:
        # This sibling frontend is an internal bridge consumer, not a public
        # caller of Tensor internals. No graph or numerical values cross here.
        handles = _bridge.grad(
            normalized_outputs[0]._handle,  # pyright: ignore[reportPrivateUsage]
            to_js([tensor._handle for tensor in requested]),  # pyright: ignore[reportPrivateUsage]
            None if seed is None else seed._handle,  # pyright: ignore[reportPrivateUsage]
        )
    except JsException as error:
        failure = cast("_bridge.RuntimeException", error)
        if failure.js_error.code == "UNUSED_INPUT":
            raise RuntimeError(str(error)) from error
        _raise_gradient_failure(error)
    try:
        # Wrappers own the handles; conversion never observes numerical values.
        return tuple(Tensor._from_handle(handle) for handle in handles)  # pyright: ignore[reportPrivateUsage]
    except BaseException:
        for handle in handles:
            handle.close()
        raise


__all__ = ["grad"]
