"""Pinned native sum-gradient alias/acquisition observations, not runtime code."""

COMMON = """
def sum_filled(shape, value):
    if not shape:
        return value
    return [sum_filled(shape[1:], value) for _ in range(shape[0])]


def sum_make(shape, value, tracked=False):
    return torch.tensor(sum_filled(shape, value), dtype=torch.float32, requires_grad=tracked)


def sum_sample(values):
    return [[list(value.shape), value.tolist(), probe_version(value), value.requires_grad]
            for value in values]


def sum_error(error):
    message = str(error)
    if 'no_grad' in message or 'no grad' in message or 'view created' in message:
        category = 'view-guard'
    elif 'single memory location' in message or 'overlap' in message:
        category = 'overlap'
    elif 'modified by an inplace' in message or 'saved for differentiation was modified' in message:
        category = 'saved-version'
    else:
        category = 'other'
    return [type(error).__name__, category]


def sum_alias_report(shape, method, action, path, tracked_seed=False):
    x = sum_make(shape, 2, True)
    seed = sum_make((), 3, tracked_seed)
    middle = x
    for dimensions in path:
        middle = middle.view(dimensions)
    output = middle.sum()
    targets = [x, middle] if path else [x]
    if method == 'functional':
        results = list(torch.autograd.grad(output, targets, seed))
    else:
        output.backward(seed, inputs=targets)
        results = [target.grad for target in targets]
    values = results + [seed]
    report = {'before': sum_sample(values),
              'identity': [[a is b for b in values] for a in results], 'error': None}
    try:
        if action == 'seed':
            with torch.no_grad():
                seed.copy_(sum_make((), 4))
        elif action == 'result':
            with torch.no_grad():
                results[0].copy_(sum_make(shape, 0))
        elif action == 'self':
            with torch.no_grad():
                results[0].copy_(results[0])
        elif action == 'same-family':
            alias = results[0].view(shape)
            with torch.no_grad():
                results[0].copy_(alias)
        elif action == 'active':
            results[0].copy_(sum_make(shape, 0, True))
        elif action == 'captured':
            prior = results[0] + results[0]
            with torch.no_grad():
                seed.copy_(sum_make((), 4))
            report['captured'] = prior.tolist()
        elif action == 'saved':
            parameter = sum_make(shape, 2, True)
            loss = (results[0] * parameter).sum()
            with torch.no_grad():
                seed.copy_(sum_make((), 4))
            try:
                report['derived'] = torch.autograd.grad(loss, parameter)[0].tolist()
            except Exception as error:
                report['savedError'] = sum_error(error)
    except Exception as error:
        report['error'] = sum_error(error)
    report['after'] = sum_sample(values)
    return report


def sum_seed_report(shape, path, method):
    origin = sum_make((), 3)
    z = sum_make(shape, 2, True)
    seed = torch.autograd.grad(z.sum(), z, origin)[0]
    for dimensions in path:
        seed = seed.view(dimensions)
    x = sum_make(shape, 2, True)
    view = x.view(tuple(seed.shape))
    if method == 'functional':
        results = list(torch.autograd.grad(view, [x, view], seed))
    else:
        view.backward(seed, inputs=[x, view])
        results = [x.grad, view.grad]
    values = results + [seed, origin]
    report = {'before': sum_sample(values),
              'identity': [[a is b for b in values] for a in results]}
    with torch.no_grad():
        origin.copy_(sum_make((), 4))
    report['after'] = sum_sample(values)
    return report


def sum_empty_promotion(shape, dimensions):
    x = sum_make(shape, 2, True)
    seed = sum_make((), 3)
    x.view(dimensions).sum().backward(seed, inputs=[x])
    gradient = x.grad
    source = sum_make(shape, 5, True)
    report = {'before': sum_sample([gradient, seed])}
    gradient.copy_(source)
    derived = torch.autograd.grad(gradient.sum(), source)[0]
    report['after'] = sum_sample([gradient, seed, derived])
    return report
"""


def sum_gradient_alias_cases(oracle: object) -> list[dict[str, object]]:
    """Vary shape, write, receiving path and seed independently."""
    cases: list[dict[str, object]] = []
    shapes = [(), (1,), (1, 1), (0,), (2, 0), (2,), (1, 2)]
    for shape in shapes:
        for method in ("functional", "backward"):
            for action in (
                "seed",
                "result",
                "self",
                "same-family",
                "active",
                "captured",
                "saved",
            ):
                cases.append(
                    {
                        "name": f"{shape}/{method}/{action}",
                        "expression": f"sum_alias_report({shape!r}, {method!r}, {action!r}, ())",
                    }
                )
    for shape, path in [
        ((1,), ((),)),
        ((1,), ((), (1,))),
        ((1, 1), ((1,), ())),
        ((0,), ((1, 0),)),
        ((2, 0), ((0, 2),)),
        ((2,), ((1, 2),)),
    ]:
        for method in ("functional", "backward"):
            cases.append(
                {
                    "name": f"view/{shape}/{path}/{method}",
                    "expression": f"sum_alias_report({shape!r}, {method!r}, 'seed', {path!r})",
                }
            )
            cases.append(
                {
                    "name": f"seed/{shape}/{path}/{method}",
                    "expression": f"sum_seed_report({shape!r}, {path!r}, {method!r})",
                }
            )
    for shape in [(), (1,), (0,), (2,)]:
        for action in ("seed", "active"):
            cases.append(
                {
                    "name": f"tracked-seed/{shape}/{action}",
                    "expression": f"sum_alias_report({shape!r}, 'backward', {action!r}, (), True)",
                }
            )
    for shape, dimensions in [((0,), (1, 0)), ((2, 0), (0,)), ((2, 0), (1, 0))]:
        cases.append(
            {
                "name": f"promotion/{shape}/{dimensions}",
                "expression": f"sum_empty_promotion({shape!r}, {dimensions!r})",
            }
        )
    namespace: dict[str, object] = {"torch": oracle}
    exec(COMMON + "\ndef probe_version(value):\n    return value._version\n", namespace)
    for case in cases:
        case["expected"] = eval(str(case["expression"]), namespace)
    return cases
