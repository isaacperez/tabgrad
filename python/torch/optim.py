"""Basic CPU SGD through the shared semantic runtime and ordinary programs."""

import math
import struct
from collections import defaultdict
from collections.abc import Callable, Iterable
from typing import cast
from warnings import warn
from weakref import finalize

import _tabgrad_runtime_bridge as _bridge  # pyright: ignore[reportMissingModuleSource]
from pyodide.ffi import JsException, to_js

from . import Tensor, _raise_gradient_failure  # pyright: ignore[reportPrivateUsage]


def _unsupported() -> None:
    raise NotImplementedError("Tabgrad supports basic CPU SGD only.")


def _false_form(value: object, *, none: bool = True) -> bool:
    return (
        value is False
        or (none and value is None)
        or (type(value) is int and value == 0)
    )


def _supported(group: dict[str, object]) -> None:
    if (
        any(group[name] != 0 for name in ("momentum", "dampening", "weight_decay"))
        or any(
            not _false_form(group[name])
            for name in ("nesterov", "maximize", "foreach", "fused", "differentiable")
        )
        or isinstance(group["lr"], Tensor)
        or "param_names" in group
    ):
        _unsupported()


def _scalar_for_validation(value: object, name: str) -> int | float:
    if type(value) in (bool, int, float):
        return cast("int | float", value)
    if isinstance(value, Tensor):
        count = math.prod(value.shape)
        if count != 1:
            if name == "lr":
                raise ValueError("Tensor lr must be 1-element")
            raise RuntimeError(
                "Boolean value of Tensor with more than one value is ambiguous"
            )
        scalar = value.tolist()
        while isinstance(scalar, list):
            scalar = cast("list[object]", scalar)[0]
        return cast("float", scalar)
    if type(value) in (str, type(None), list, tuple, dict):
        raise TypeError(f"{name} cannot be compared with a real number")
    _unsupported()
    raise AssertionError("unreachable")


def _alpha_bits(lr: object) -> int:
    if type(lr) not in (bool, int, float):
        if type(lr) in (str, type(None)):
            raise TypeError(f"bad operand type for unary -: {type(lr).__name__!r}")
        _unsupported()
    alpha = -cast("int | float", lr)
    if type(alpha) is int and not -(2**63) <= alpha <= 2**64 - 1:
        raise OverflowError(
            "SGD coefficient is outside the native integer scalar range"
        )
    if type(alpha) is int and abs(alpha) >= 2**24:
        # Round the integer directly: an intermediate float64 can erase the
        # low bit that decides which side of a float32 midpoint it occupies.
        magnitude = abs(alpha)
        exponent = magnitude.bit_length() - 1
        shift = exponent - 23
        significand, remainder = divmod(magnitude, 1 << shift)
        halfway = 1 << (shift - 1)
        if remainder > halfway or (remainder == halfway and significand & 1):
            significand += 1
        if significand == 1 << 24:
            significand >>= 1
            exponent += 1
        return (
            (int(alpha < 0) << 31) | ((exponent + 127) << 23) | (significand & 0x7FFFFF)
        )
    if (
        type(alpha) is float
        and math.isfinite(alpha)
        and abs(alpha) > 3.4028234663852886e38
    ):
        raise RuntimeError("value cannot be converted to type float without overflow")
    return struct.unpack("<I", struct.pack("<f", alpha))[0]


def _finalize_lease(lease: _bridge.OptimizerLease) -> None:
    # This callback owns only a private JS lease, never the Python optimizer.
    lease.finalize()


class SGD:
    """Preserve native basic SGD binding, groups, reset and sequential updates."""

    def __init__(
        self,
        params: object,
        lr: object = 0.001,
        momentum: object = 0,
        dampening: object = 0,
        weight_decay: object = 0,
        nesterov: object = False,
        *,
        maximize: object = False,
        foreach: object = None,
        differentiable: object = False,
        fused: object = None,
    ) -> None:
        for name, value in (
            ("lr", lr),
            ("momentum", momentum),
            ("weight_decay", weight_decay),
        ):
            if _scalar_for_validation(value, name) < 0:
                raise ValueError(f"Invalid {name} value: {value}")
        self.defaults: dict[str, object] = {
            "lr": lr,
            "momentum": momentum,
            "dampening": dampening,
            "weight_decay": weight_decay,
            "nesterov": nesterov,
            "maximize": maximize,
            "foreach": foreach,
            "differentiable": differentiable,
            "fused": fused,
        }
        if nesterov and (
            _scalar_for_validation(momentum, "momentum") <= 0 or dampening != 0
        ):
            raise ValueError("Nesterov momentum requires a momentum and zero dampening")
        if isinstance(params, Tensor):
            raise TypeError("params must be an iterable of Tensors or dicts")
        values = list(cast("Iterable[object]", params))
        if not values:
            raise ValueError("optimizer got an empty parameter list")
        if not isinstance(values[0], dict):
            values = [{"params": values}]
        self.state: defaultdict[Tensor, dict[str, object]] = defaultdict(dict)
        self.param_groups: list[dict[str, object]] = []
        seen: set[Tensor] = set()
        for value in values:
            if not isinstance(value, dict):
                raise TypeError("param_group must be a dict")
            group = cast("dict[str, object]", value)
            members = group["params"]
            if isinstance(members, Tensor):
                parameters: list[object] = [members]
            elif isinstance(members, set):
                raise TypeError("optimizer parameters need an ordered collection")
            else:
                parameters = list(cast("Iterable[object]", members))
            names: list[object] = []
            extracted: list[object] = []
            for parameter in parameters:
                if isinstance(parameter, tuple):
                    named = cast("tuple[object, ...]", parameter)
                    names.append(named[0])
                    extracted.append(named[1])
                else:
                    extracted.append(parameter)
            group["params"] = extracted
            if names:
                if len(names) != len(extracted):
                    raise ValueError(
                        "all optimizer params should be with/without names"
                    )
                group["param_names"] = names
            for parameter in extracted:
                if not isinstance(parameter, Tensor):
                    raise TypeError("optimizer can only optimize Tensors")
                if not differentiable and not _bridge.isOptimizableParameter(
                    parameter._handle  # pyright: ignore[reportPrivateUsage]
                ):
                    raise ValueError("can't optimize a non-leaf Tensor")
            for name, default in self.defaults.items():
                group.setdefault(name, default)
            actual = cast("list[Tensor]", extracted)
            if len(actual) != len(set(actual)):
                warn(
                    "optimizer contains a parameter group with duplicate parameters; in future, this will cause an error; see github.com/pytorch/pytorch/issues/40967 for more information",
                    UserWarning,
                    stacklevel=2,
                )
            if any(
                ("param_names" in group) != ("param_names" in previous)
                for previous in self.param_groups
            ):
                raise ValueError(
                    "all optimizer param groups should be with/without names"
                )
            if not seen.isdisjoint(actual):
                raise ValueError(
                    "some parameters appear in more than one parameter group"
                )
            seen.update(actual)
            self.param_groups.append(group)
        if fused and (differentiable or foreach):
            raise RuntimeError("fused does not support differentiable or foreach")
        _supported(self.defaults)
        for group in self.param_groups:
            _supported(group)
        if isinstance(params, set):
            _unsupported()
        self._registered = tuple(
            tuple(cast("list[Tensor]", group["params"])) for group in self.param_groups
        )
        self._groups = tuple(self.param_groups)
        self._parameter_lists = tuple(group["params"] for group in self.param_groups)
        try:
            self._lease = _bridge.registerSGD(
                to_js(
                    [
                        [parameter._handle for parameter in group]  # pyright: ignore[reportPrivateUsage]
                        for group in self._registered
                    ]
                )
            )
        except JsException as error:
            _raise_gradient_failure(error)
            raise
        self._finalizer = finalize(self, _finalize_lease, self._lease)

    def _check_structure(self) -> None:
        if self.state or len(self.param_groups) != len(self._groups):
            _unsupported()
        for group, original, members, parameter_list in zip(
            self.param_groups,
            self._groups,
            self._registered,
            self._parameter_lists,
            strict=True,
        ):
            if (
                group is not original
                or group.get("params") is not parameter_list
                or type(group.get("params")) is not list
                or tuple(cast("list[Tensor]", group["params"])) != members
            ):
                _unsupported()

    def zero_grad(self, set_to_none: object = True) -> None:
        self._lease.assertOpen()
        if type(set_to_none) not in (bool, int, float, str, type(None)):
            _unsupported()
        self._check_structure()
        try:
            self._lease.zeroGrad(bool(set_to_none))
        except JsException as error:
            _raise_gradient_failure(error)

    def step(self, closure: Callable[[], object] | None = None) -> object:
        self._lease.assertOpen()
        self._check_structure()
        if type(self.defaults["differentiable"]) is not bool:
            raise TypeError("set_grad_enabled requires a bool")
        if self.defaults["differentiable"]:
            _unsupported()
        previous = self._lease.beginStep()
        try:
            result = None
            if closure is not None:
                self._lease.setRecording(True)
                try:
                    result = closure()
                finally:
                    self._lease.setRecording(False)
            self._lease.assertOpen()
            self._check_structure()
            for index, group in enumerate(self.param_groups):
                _supported(group)
                if self._lease.hasGradients(index):
                    alpha_bits = _alpha_bits(group["lr"])
                    try:
                        self._lease.stepGroup(index, alpha_bits)
                    except JsException as error:
                        _raise_gradient_failure(error)
            return result
        finally:
            self._lease.setRecording(previous)

    def add_param_group(self, param_group: object) -> None:
        _unsupported()

    def state_dict(self) -> dict[str, object]:
        _unsupported()
        raise AssertionError("unreachable")

    def load_state_dict(self, state_dict: object) -> None:
        _unsupported()


__all__ = ["SGD"]
