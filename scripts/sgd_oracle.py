"""Native basic SGD observations for maintained language/browser conformance."""

from typing import cast

COMMON = """
import struct, warnings
if '_inspect_version' not in globals():
    def _inspect_version(value): return value._version
def tensor(data, tracked=True):
    return torch.tensor(data, dtype=torch.float32, requires_grad=tracked)
def bits(value):
    if isinstance(value, list):
        return [bits(item) for item in value]
    return 'nan' if value != value else struct.unpack('<I', struct.pack('<f', value))[0]
def state(value):
    return None if value is None else {'bits': bits(value.tolist()), 'shape': list(value.shape), 'tracking': value.requires_grad, 'version': _inspect_version(value)}
def attempt(call):
    try:
        call()
        return 'ok'
    except Exception as error:
        return type(error).__name__
"""


NORMALIZATION_SOURCE = """
def normalization_contents(value, p, q):
    if type(value) is not list: return type(value).__name__
    return ['p' if item is p else 'q' if item is q else type(item).__name__ for item in value]
def normalization_case(name):
    p = tensor([2.]); q = tensor([3.])
    events = []; writes = []
    marker = LookupError('normalization sentinel')
    class Group(dict):
        def __setitem__(self, key, value):
            super().__setitem__(key, value)
            writes.append([key, normalization_contents(value, p, q), value is original])
            if name == 'publication-error' and key == 'params': raise marker
    class Named(tuple):
        def __getitem__(self, index):
            events.append(['index', index, group['params'] is original])
            if index == 1: raise marker
            return super().__getitem__(index)
    class Members:
        def __iter__(self):
            events.append(['iterate', group['params'] is original])
            yield p
            raise marker
    original = {
        'empty-tuple': [()], 'short-tuple': [('name',)],
        'late-short': [p, ('name',)], 'mixed': [('name', p), q],
        'member-error': [('name', p), ('other', 17)],
        'ordinary': [p, q], 'iterable-error': Members(),
        'tuple-index-error': [Named(('name', p))],
        'publication-error': [('name',)],
    }[name]
    group = Group(params=original)
    before = []; after = []
    first = {'params': before}; last = {'params': after}
    error = 'ok'; same_error = False
    try: torch.optim.SGD([first, group, last])
    except Exception as caught:
        error = type(caught).__name__; same_error = caught is marker
    return {'name': name, 'error': error, 'same_error': same_error,
            'same_original': group['params'] is original,
            'contents': normalization_contents(group['params'], p, q), 'writes': writes, 'events': events,
            'names': dict.get(group, 'param_names'),
            'first_progress': [first['params'] is before, 'lr' in first],
            'last_progress': [last['params'] is after, 'lr' in last]}
report = {'cases': [normalization_case(name) for name in (
    'empty-tuple', 'short-tuple', 'late-short', 'mixed', 'member-error',
    'ordinary', 'iterable-error', 'tuple-index-error', 'publication-error')]}
"""


REENTRY_SOURCE = """import warnings

def run_case(name):
    p=torch.tensor([2.],dtype=torch.float32,requires_grad=True)
    q=torch.tensor([4.],dtype=torch.float32,requires_grad=True)
    old=torch.tensor([3.],dtype=torch.float32)
    other=torch.tensor([5.],dtype=torch.float32)
    replacement=torch.tensor([9.],dtype=torch.float32)
    p.grad=old
    q.grad=other
    events=[]
    marker=LookupError('dictionary sentinel')
    class Group(dict):
        armed=False
        fired=False
        momentum_reads=0
        rate_reads=0
        def __getitem__(self,key):
            value=super().__getitem__(key)
            if self.armed:
                events.append(key)
                if key=='momentum':
                    self.momentum_reads+=1
                    if name=='post-momentum-throw' and self.momentum_reads==3: raise marker
                if key=='lr':
                    self.rate_reads+=1
                    if name=='rate-sequence': return 0.5*self.rate_reads
                trigger='params' if name.startswith('params-') else 'fused' if name.startswith('fused-') else ('lr' if name.startswith('rate-') or name.startswith('second-rate-') or name=='absent-bad-rate' else 'momentum')
                if key==trigger and not self.fired:
                    self.fired=True
                    if name in ('params-clear','clear-current','rate-clear','fused-clear','second-rate-throw','second-rate-bad'): p.grad=None
                    elif name in ('replace-current','duplicate-replace','fused-replace'): p.grad=replacement
                    elif name in ('clear-later','cross-group-clear'): q.grad=None
                    elif name=='replace-later': q.grad=replacement
                    elif name=='numeric-alias':
                        with torch.no_grad(): q.copy_(replacement)
                    elif name in ('params-throw','option-throw','rate-throw'): raise marker
                    elif name in ('recursive','recursive-replace'):
                        if name=='recursive-replace': p.grad=replacement
                        optimizer.step()
                    if name=='second-rate-throw': raise marker
                    if name in ('second-rate-bad','absent-bad-rate'): return 'bad'
            return value
    group=Group(params=[p,q] if name in ('clear-later','replace-later','numeric-alias') else ([p,p] if name=='duplicate-replace' else [p]),lr=0.5)
    if name=='numeric-alias': p.grad=q.view(1); q.grad=p.view(1)
    if name=='absent-bad-rate': p.grad=None
    if name.startswith('second-rate-'):
        first={'params':[q],'lr':0.5}
        groups=[first,group]
    elif name=='cross-group-clear': groups=[group,{'params':[q],'lr':0.5}]
    else: groups=[group]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        optimizer=torch.optim.SGD(groups,foreach=False)
    group.armed=True
    error=None
    same=False
    closure_calls=0
    def closure():
        nonlocal closure_calls
        closure_calls+=1
        if name=='params-clear':
            p.grad=replacement
            return 42
        with torch.no_grad(): p.copy_(replacement)
        if name=='params-throw': return 42
        raise marker
    try: optimizer.step(closure if name in ('closure-throw','params-clear','params-throw') else None)
    except Exception as exception:
        error=type(exception).__name__
        same=exception is marker
    def association(parameter):
        value=parameter.grad
        return 'none' if value is None else ('old' if value is old else ('other' if value is other else ('replacement' if value is replacement else 'alias')))
    return {'name':name,'p':p.tolist(),'q':q.tolist(),'pGrad':association(p),'qGrad':association(q),'pVersion':_inspect_version(p),'qVersion':_inspect_version(q),'error':error,'sameException':same,'recordingRestored':(p*p).requires_grad,'closureCalls':closure_calls,'events':events}

case_names=['clear-current','replace-current','clear-later','replace-later','fused-clear','fused-replace','rate-clear','option-throw','rate-throw','second-rate-throw','second-rate-bad','absent-bad-rate','duplicate-replace','numeric-alias','cross-group-clear','closure-throw','recursive','recursive-replace','post-momentum-throw','rate-sequence','params-clear','params-throw']
observations=[run_case(name) for name in case_names]

report = {"observations": observations}
"""


RESET_REENTRY_SOURCE = """
def reset_case(name, set_to_none, shape='vector'):
    data = 2. if shape == 'scalar' else ([] if shape == 'empty' else [2.])
    old_data = 3. if shape == 'scalar' else ([] if shape == 'empty' else [3.])
    new_data = 9. if shape == 'scalar' else ([] if shape == 'empty' else [9.])
    p = tensor(data); q = tensor([4.])
    old = tensor(old_data, False); other = tensor([5.], False)
    replacement = tensor(new_data, name == 'replace-tracked')
    alias = replacement.view(list(replacement.shape))
    zero = tensor([0.], False)
    p.grad = None if name in ('install-absent', 'absent') else (zero if name == 'zero' else old)
    q.grad = other
    events = []
    marker = LookupError('zero_grad dictionary sentinel')
    class Group(dict):
        armed = False
        def __getitem__(self, key):
            value = super().__getitem__(key)
            if self.armed:
                events.append(key)
                if key == 'params':
                    if name == 'clear': p.grad = None
                    elif name in ('replace', 'replace-tracked', 'install-absent'): p.grad = replacement
                    elif name in ('throw', 'second-throw'): raise marker
                    elif name == 'second-observe': events.append(state(old))
            return value
    group = Group(params=[q] if name.startswith('second-') else [p], lr=0.5)
    groups = [{'params': [p]}, group] if name.startswith('second-') else [group]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        optimizer = torch.optim.SGD(groups, foreach=False)
        group.armed = True
        error = None; same = False; result = 'not-returned'
        try: result = optimizer.zero_grad(set_to_none)
        except Exception as failure:
            error = type(failure).__name__
            same = failure is marker
    def association(parameter):
        value = parameter.grad
        return 'none' if value is None else ('old' if value is old else ('other' if value is other else ('replacement' if value is replacement else 'zero')))
    return {'name': name, 'setToNone': set_to_none, 'shape': shape, 'events': events,
        'error': error, 'sameException': same, 'returnedNone': result is None,
        'pGrad': association(p), 'qGrad': association(q), 'old': state(old),
        'other': state(other), 'replacement': state(replacement), 'alias': state(alias),
        'zero': state(zero), 'warnings': [item.category.__name__ for item in caught],
        'recordingRestored': (p*p).requires_grad}
observations = [reset_case(name, reset) for reset in (False, True)
    for name in ('trace', 'clear', 'replace', 'replace-tracked', 'install-absent',
        'throw', 'second-throw', 'second-observe', 'absent', 'zero')]
observations += [reset_case('replace', reset, shape) for reset in (False, True)
    for shape in ('scalar', 'empty')]
report = {'observations': observations}
"""


def sources() -> list[tuple[str, str, str]]:
    cases: list[tuple[str, str, str]] = [
        (
            "constructor-normalization-progress",
            COMMON + NORMALIZATION_SOURCE,
            "constructor",
        )
    ]
    for midpoint in (2**62 + 2**38, 2**63 - 2**38):
        for offset in (-1, 0, 1):
            cases.append(
                (
                    f"integer-rounding-{midpoint + offset}",
                    COMMON
                    + f"""
p = tensor([0.]); p.grad = tensor([1.], False)
torch.optim.SGD([p], lr={midpoint + offset}).step()
report = {{'parameter': state(p)}}
""",
                    "integer",
                )
            )
    for disabled in (False, True):
        cases.append(
            (
                f"reset-special-view-{disabled}",
                COMMON
                + f"""
p = tensor([2.]); q = tensor([4.]); x = tensor([3.]); first = tensor([7.], False)
with torch.no_grad(): g = x.view(1)
p.grad = first; q.grad = g; optimizer = torch.optim.SGD([p, q])
if {disabled}:
    with torch.no_grad(): error = attempt(lambda: optimizer.zero_grad(False))
else: error = attempt(lambda: optimizer.zero_grad(False))
report = {{'error': error, 'first': state(first), 'gradient': state(g), 'associated': q.grad is g}}
""",
                "reset",
            )
        )
    for name, data, shape in (
        ("scalar", "2.", "()"),
        ("singleton", "[[[2.]]]", "(1, 1, 1)"),
        ("matrix", "[[1., 2.], [3., 4.]]", "(4,)"),
        ("empty", "[[], []]", "(0,)"),
    ):
        cases.append(
            (
                f"training-{name}",
                COMMON
                + f"""
p = tensor({data})
alias = p.view({shape})
optimizer = torch.optim.SGD([p], lr=0.125)
trace = []
for index in range(6):
    optimizer.zero_grad(set_to_none=index % 2 == 0)
    loss = p.mul(p).add(p).sum()
    loss.backward()
    gradient = p.grad
    returned = optimizer.step()
    trace.append([state(p), state(alias), state(gradient), p.grad is gradient, returned is None, len(optimizer.state)])
    with torch.no_grad():
        p.copy_(p)
report = {{'trace': trace}}
""",
                "training",
            )
        )
    cases.append(
        (
            "groups-and-occurrences",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.], False)
p.grad = tensor([3.], False); q.grad = tensor([5.], False)
first = {'params': (p, p), 'lr': 0.5, 'tag': 'inert'}
empty = {'params': [], 'lr': -7.}
last = {'params': [q], 'lr': -0.25}
with warnings.catch_warnings(record=True) as recorded:
    warnings.simplefilter('always')
    optimizer = torch.optim.SGD([first, empty, last])
old_gradient = p.grad
returned = optimizer.step()
first['lr'] = 0.
optimizer.step()
report = {'p': state(p), 'q': state(q), 'same_group': optimizer.param_groups[0] is first,
    'same_param': first['params'][0] is p, 'same_gradient': p.grad is old_gradient,
    'warnings': [warning.category.__name__ for warning in recorded], 'state': len(optimizer.state), 'return': returned is None}
""",
            "groups",
        )
    )
    cases.append(
        (
            "crossed-alias-progress",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.])
p.grad = q; q.grad = p
optimizer = torch.optim.SGD([p, q], lr=0.5)
optimizer.step()
report = {'p': state(p), 'q': state(q), 'p_grad': p.grad is q, 'q_grad': q.grad is p}
""",
            "alias",
        )
    )
    for lr in (
        "0.1",
        "True",
        "0.",
        "float('inf')",
        "float('nan')",
        "2**63",
        "2**63+1",
        "1e39",
        "None",
        "'invalid'",
    ):
        for name, data, gradient in (
            ("absent", "[1.]", "None"),
            ("present", "[50.29061508178711]", "tensor([502.9061279296875], False)"),
            ("empty", "[]", "tensor([], False)"),
        ):
            cases.append(
                (
                    f"coefficient-{name}-{lr}",
                    COMMON
                    + f"""
p = tensor({data}); p.grad = {gradient}
optimizer = torch.optim.SGD([p])
optimizer.param_groups[0]['lr'] = {lr}
error = attempt(optimizer.step)
report = {{'error': error, 'parameter': state(p), 'gradient': state(p.grad)}}
""",
                    "coefficient",
                )
            )
    for value in (
        "True",
        "False",
        "None",
        "0",
        "0.",
        "''",
        "'yes'",
        "-2",
        "float('nan')",
    ):
        cases.append(
            (
                f"reset-truthiness-{value}",
                COMMON
                + f"""
p = tensor([2.]); g = tensor([-0.]); p.grad = g
optimizer = torch.optim.SGD([p])
optimizer.zero_grad({value})
report = {{'gradient': state(g), 'associated': p.grad is g}}
""",
                "reset",
            )
        )
    for name, differentiate in (
        ("reset-detachment-and-alias", "saved.backward()"),
        ("reset-functional-detachment-and-alias", "torch.autograd.grad(saved, x)"),
    ):
        cases.append(
            (
                name,
                COMMON
                + f"""
p = tensor([2.]); x = tensor([3.]); g = x*x; alias = g.view([1]); saved = g*x
p.grad = g
optimizer = torch.optim.SGD([p]); optimizer.zero_grad(False)
error = attempt(lambda: {differentiate})
report = {{'gradient': state(g), 'alias': state(alias), 'associated': p.grad is g, 'error': error}}
""",
                "reset",
            )
        )
    cases.append(
        (
            "reset-view-progress",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.]); x = tensor([3.]); first = tensor([7.], False); bad = (x*x).view([1])
p.grad = first; q.grad = bad
optimizer = torch.optim.SGD([p, q]); error = attempt(lambda: optimizer.zero_grad(False))
report = {'error': error, 'first': state(first), 'bad': state(bad), 'first_same': p.grad is first, 'bad_same': q.grad is bad}
""",
            "reset",
        )
    )
    cases.append(
        (
            "closure-scope-return-and-error",
            COMMON
            + """
p = tensor([2.]); p.grad = tensor([3.], False); optimizer = torch.optim.SGD([p], lr=0.5)
sentinel = object(); calls = []
def closure():
    calls.append((p+p).requires_grad)
    return sentinel
with torch.no_grad():
    same_return = optimizer.step(closure) is sentinel
    restored = not (p+p).requires_grad
class SentinelError(Exception): pass
error = SentinelError('original')
def failing():
    with torch.no_grad():
        p.copy_(tensor([8.], False))
    raise error
try:
    optimizer.step(failing)
except Exception as caught:
    same_error = caught is error
report = {'calls': calls, 'same_return': same_return, 'restored': restored, 'same_error': same_error, 'parameter': state(p)}
""",
            "closure",
        )
    )
    for name, options in (
        ("nesterov", "{'nesterov': None}"),
        ("maximize", "{'maximize': 0}"),
        ("foreach", "{'foreach': 0}"),
        ("fused", "{'fused': 0}"),
        ("differentiable-zero", "{'differentiable': 0}"),
        ("differentiable-none", "{'differentiable': None}"),
    ):
        cases.append(
            (
                f"constructor-false-form-{name}",
                COMMON
                + f"""
p = tensor([2.]); p.grad = tensor([3.], False)
optimizer = torch.optim.SGD([p], **{options})
calls = []
error = attempt(lambda: optimizer.step(lambda: calls.append(1)))
report = {{'error': error, 'calls': calls, 'defaults': {{key: [type(value).__name__, repr(value)] for key, value in optimizer.defaults.items()}}, 'parameter': state(p)}}
""",
                "constructor",
            )
        )
    invalid = {
        "empty": "torch.optim.SGD([])",
        "bare": "torch.optim.SGD(p)",
        "nonleaf": "torch.optim.SGD([p+p])",
        "cross-group": "torch.optim.SGD([{'params':[p]}, {'params':[p]}])",
        "member": "torch.optim.SGD([17])",
        "missing-params": "torch.optim.SGD([{}])",
        "unordered-group": "torch.optim.SGD([{'params':{p}}])",
        "negative-lr": "torch.optim.SGD([p], lr=-1)",
        "negative-momentum-before-unsupported": "torch.optim.SGD([p], momentum=-1, weight_decay=1)",
        "nesterov-before-params": "torch.optim.SGD([], nesterov=True)",
        "nonleaf-before-momentum": "torch.optim.SGD([p+p], momentum=1)",
        "binding": "torch.optim.SGD([p], unknown=True)",
        "reset-binding": "torch.optim.SGD([p]).zero_grad(unknown=True)",
        "step-binding": "torch.optim.SGD([p]).step(unknown=True)",
    }
    for name, expression in invalid.items():
        cases.append(
            (
                f"invalid-{name}",
                COMMON
                + f"p=tensor([2.])\nreport={{'error':attempt(lambda:{expression})}}\n",
                "binding",
            )
        )
    cases.append(
        (
            "retained-nonleaf-registration",
            COMMON
            + """
x = tensor([2.]); p = x+x; p.sum().backward(inputs=[p])
optimizer = torch.optim.SGD([p], lr=0.5); optimizer.step()
report = {'parameter': state(p), 'gradient': state(p.grad)}
""",
            "constructor",
        )
    )
    cases.append(
        (
            "reset-leaf-old-history",
            COMMON
            + """
p = tensor([2.]); g = tensor([3.]); constant = tensor([4.], False)
old = (g*constant).sum(); p.grad = g
optimizer = torch.optim.SGD([p]); optimizer.zero_grad(False)
first = attempt(old.backward); second = attempt(old.backward)
report = {'first': first, 'second': second, 'gradient': state(g), 'old_grad': state(g.grad)}
""",
            "reset",
        )
    )
    cases.append(
        (
            "registered-incoming-gradient-owner",
            COMMON
            + """
p = tensor([2.]); seed = tensor(3., False); optimizer = torch.optim.SGD([p, seed])
p.sum().backward(seed)
gradient = p.grad
with torch.no_grad():
    gradient.copy_(tensor([7.], False))
report = {'seed': state(seed), 'gradient': state(gradient), 'same_gradient': p.grad is gradient}
""",
            "acquisition",
        )
    )
    cases.append(
        (
            "repeated-gradient-reset",
            COMMON
            + """
p = tensor([2.]); q = tensor([4.]); gradient = tensor([-0.]); alias = gradient.view([1])
p.grad = gradient; q.grad = gradient
optimizer = torch.optim.SGD([p, q]); optimizer.zero_grad(False)
report = {'gradient': state(gradient), 'alias': state(alias), 'p_same': p.grad is gradient, 'q_same': q.grad is gradient}
""",
            "reset",
        )
    )
    cases.append(("dictionary-reentry-phases", COMMON + REENTRY_SOURCE, "reentry"))
    cases.append(
        ("reset-dictionary-reentry", COMMON + RESET_REENTRY_SOURCE, "reset-reentry")
    )
    return cases


def sgd_cases(oracle: object) -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    for name, source, kind in sources():
        namespace: dict[str, object] = {"torch": oracle}
        exec(source, namespace)
        cases.append(
            {
                "name": name,
                "kind": kind,
                "source": source,
                "expected": cast("dict[str, object]", namespace["report"]),
            }
        )
    return cases
