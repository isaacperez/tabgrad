"""Basic CPU SGD through the shared semantic runtime and ordinary programs."""

import math
import struct
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
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


def _unnamed_groups_stable(owner: object, groups: Sequence[object]) -> bool:
    if len(groups) < 2 or type(owner) is not SGD:
        return False
    # Outer iteration can replace defaults; screen the current storage first.
    defaults = owner.defaults
    if type(defaults) is not dict:
        return False
    for default_key in defaults:
        if type(default_key) is not str:
            return False
    if "param_names" in defaults or not _false_form(defaults.get("differentiable")):
        return False
    for group in groups:
        if type(group) is not dict:
            return False
        fields = cast("dict[object, object]", group)
        for key in fields:
            if type(key) is not str:
                return False
        if "param_names" in fields:
            return False
        members = fields.get("params")
        if type(members) not in (list, tuple):
            return False
        identities: set[int] = set()
        for parameter in cast("list[object] | tuple[object, ...]", members):
            if type(parameter) is not Tensor:
                return False
            identity = id(parameter)
            if identity in identities:
                return False
            identities.add(identity)
    return True


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
        unnamed_groups = _unnamed_groups_stable(self, values)
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
            group["params"] = parameters
            names: list[object] = []
            extracted: list[object] = []
            for parameter in cast("Iterable[object]", group["params"]):
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
            for parameter in cast("Iterable[object]", group["params"]):
                if not isinstance(parameter, Tensor):
                    raise TypeError("optimizer can only optimize Tensors")
                if not self.defaults.get(
                    "differentiable", None
                ) and not _bridge.isOptimizableParameter(
                    parameter._handle  # pyright: ignore[reportPrivateUsage]
                ):
                    raise ValueError("can't optimize a non-leaf Tensor")
            for name, default in self.defaults.items():
                group.setdefault(name, default)
            actual = cast("list[Tensor]", group["params"])
            if len(actual) != len(set(actual)):
                warn(
                    "optimizer contains a parameter group with duplicate parameters; in future, this will cause an error; see github.com/pytorch/pytorch/issues/40967 for more information",
                    UserWarning,
                    stacklevel=2,
                )
            seen: set[Tensor] = set()
            for previous in self.param_groups:
                seen.update(set(cast("Iterable[Tensor]", previous["params"])))
                if not unnamed_groups and (
                    ("param_names" in group) != ("param_names" in previous)
                ):
                    current = (
                        "with names" if "param_names" in group else "without names"
                    )
                    raise ValueError(
                        "all optimizer param groups should be with/without names. "
                        f"cannot add param group {current} to the optimizer"
                    )
            if not seen.isdisjoint(set(cast("Iterable[Tensor]", group["params"]))):
                raise ValueError(
                    "some parameters appear in more than one parameter group"
                )
            self.param_groups.append(group)
        if fused and (differentiable or foreach):
            raise RuntimeError("fused does not support differentiable or foreach")
        _supported(self.defaults)
        required_fields = set(self.defaults) | {"params"}
        # Only native validation invokes caller dictionary protocols. Admission
        # reads literal stored fields; metadata cannot impersonate these keys.
        group_fields = [
            {
                key: value
                for key, value in dict[str, object].items(group)
                if type(key) is str and (key in required_fields or key == "param_names")
            }
            for group in self.param_groups
        ]
        for fields in group_fields:
            if not required_fields.issubset(fields):
                _unsupported()
            _supported(fields)
            stored_parameters = fields["params"]
            if type(stored_parameters) is not list or any(
                type(parameter) is not Tensor
                for parameter in cast("list[object]", stored_parameters)
            ):
                _unsupported()
        if isinstance(params, set):
            _unsupported()
        self._registered = tuple(
            tuple(cast("list[Tensor]", fields["params"])) for fields in group_fields
        )
        self._groups = tuple(self.param_groups)
        self._parameter_lists = tuple(fields["params"] for fields in group_fields)
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
        for index in range(len(self._groups)):
            self._check_group_structure(index)

    def _check_group_structure(self, index: int) -> None:
        group = self.param_groups[index]
        if (
            group is not self._groups[index]
            or dict[str, object].get(group, "params")
            is not self._parameter_lists[index]
            or type(dict[str, object].get(group, "params")) is not list
            or tuple(
                cast("list[Tensor]", dict[str, object].__getitem__(group, "params"))
            )
            != self._registered[index]
        ):
            _unsupported()

    def zero_grad(self, set_to_none: object = True) -> None:
        self._lease.assertOpen()
        if type(set_to_none) not in (bool, int, float, str, type(None)):
            _unsupported()
        self._check_structure()
        try:
            for index, group in enumerate(self.param_groups):
                parameters = group["params"]
                if (
                    self.state
                    or len(self.param_groups) != len(self._groups)
                    or parameters is not self._parameter_lists[index]
                ):
                    _unsupported()
                self._check_group_structure(index)
                self._lease.zeroGradGroup(index, bool(set_to_none))
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
                self._process_group(index, group)
            return result
        finally:
            self._lease.setRecording(previous)

    def _process_group(self, index: int, group: dict[str, object]) -> None:
        failures: list[BaseException] = []
        try:
            self._lease.withGroup(
                index, lambda capture: self._run_group(group, capture, failures)
            )
        except JsException as error:
            failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup(
                "SGD group and capture retirement failed", failures
            )

    def _run_group(
        self,
        group: dict[str, object],
        capture: _bridge.OptimizerCapture,
        failures: list[BaseException],
    ) -> None:
        # Keep Python exceptions in Python: a transported PythonError can retain
        # its traceback/wrappers until JavaScript GC. Runtime still owns cleanup.
        try:
            self._step_group(group, capture)
        except BaseException as error:
            failures.append(error)

    def _step_group(
        self, group: dict[str, object], capture: _bridge.OptimizerCapture
    ) -> None:
        captured = 0
        for occurrence, _parameter in enumerate(cast("list[Tensor]", group["params"])):
            if capture.hasGradient(occurrence):
                if not _false_form(group["fused"]):
                    _unsupported()
                if not capture.capture(occurrence):
                    # Native checks sparse metadata after its second grad read.
                    raise AttributeError(
                        "'NoneType' object has no attribute 'is_sparse'"
                    )
                captured += 1
                if group["momentum"] != 0:
                    _unsupported()
        # Native evaluates these keywords once, even when no gradients remain.
        options = {
            name: group[name]
            for name in (
                "weight_decay",
                "momentum",
                "lr",
                "dampening",
                "nesterov",
                "maximize",
                "foreach",
                "fused",
            )
        }
        options["differentiable"] = dict[str, object].__getitem__(
            group, "differentiable"
        )
        if dict[str, object].__contains__(group, "param_names"):
            _unsupported()
        _supported(options)
        if captured:
            try:
                capture.apply(_alpha_bits(options["lr"]))
            except JsException as error:
                _raise_gradient_failure(error)
        if group["momentum"] != 0:
            _unsupported()

    def add_param_group(self, param_group: object) -> None:
        _unsupported()

    def state_dict(self) -> dict[str, object]:
        _unsupported()
        raise AssertionError("unreachable")

    def load_state_dict(self, state_dict: object) -> None:
        _unsupported()


__all__ = ["SGD"]
