/** Count named constructor work in actual Pyodide; no timing inference. */
export const pythonSGDConstructorCostSource = `
import ast, collections, gc, hashlib, json, pathlib, sys
import torch
import torch.optim as optim

def constructor_cost_site(sites, label, nodes):
    assert len(nodes) == 1, (label, len(nodes))
    sites[nodes[0].lineno] = label

def constructor_cost_sites():
    source = pathlib.Path(optim.__file__).read_bytes()
    tree = ast.parse(source)
    source_sha = hashlib.sha256(source).hexdigest()
    constructor = next(node for node in ast.walk(tree)
                       if isinstance(node, ast.ClassDef) and node.name == 'SGD')
    constructor = next(node for node in constructor.body
                       if isinstance(node, ast.FunctionDef) and node.name == '__init__')
    sites = {}
    constructor_cost_site(sites, 'nameComparisons', [node for node in ast.walk(constructor)
        if isinstance(node, ast.Compare) and isinstance(node.left, ast.Compare)
        and isinstance(node.left.left, ast.Constant) and node.left.left.value == 'param_names'])
    constructor_cost_site(sites, 'priorSetRebuilds', [node for node in ast.walk(constructor)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name) and node.func.value.id == 'seen'
        and node.func.attr == 'update'])
    constructor_cost_site(sites, 'normalizedGroups', [node for node in ast.walk(constructor)
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Name)
        and node.value.id == 'parameters' and isinstance(node.targets[0], ast.Subscript)])
    constructor_cost_site(sites, 'normalizedParameters', [node for node in ast.walk(constructor)
        if isinstance(node, ast.If) and isinstance(node.test, ast.Call)
        and isinstance(node.test.func, ast.Name) and node.test.func.id == 'isinstance'
        and isinstance(node.test.args[0], ast.Name) and node.test.args[0].id == 'parameter'
        and isinstance(node.test.args[1], ast.Name) and node.test.args[1].id == 'tuple'])
    helper = next((node for node in tree.body
                   if isinstance(node, ast.FunctionDef) and node.name == '_unnamed_groups_stable'), None)
    codes = {optim.SGD.__init__.__code__}
    helper_code = None
    if helper is not None:
        helper_code = optim._unnamed_groups_stable.__code__
        codes.add(helper_code)
        for variable, label in (('default_key', 'defaultKeys'), ('group', 'classifierGroups'),
                                ('key', 'groupKeys'), ('parameter', 'classifierParameters')):
            loops = [node for node in ast.walk(helper) if isinstance(node, ast.For)
                     and isinstance(node.target, ast.Name) and node.target.id == variable]
            assert len(loops) == 1, (variable, len(loops))
            constructor_cost_site(sites, label, [loops[0].body[0]])
        constructor_cost_site(sites, 'identityChecks', [node for node in ast.walk(helper)
            if isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
            and isinstance(node.test.left, ast.Name) and node.test.left.id == 'identity'])
        constructor_cost_site(sites, 'classifierFast', [node for node in ast.walk(helper)
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Constant)
            and node.value.value is True])
        constructor_cost_site(sites, 'nameGates', [node for node in ast.walk(constructor)
            if isinstance(node, ast.If) and isinstance(node.test, ast.BoolOp)
            and isinstance(node.test.values[0], ast.UnaryOp)
            and isinstance(node.test.values[0].operand, ast.Name)
            and node.test.values[0].operand.id == 'unnamed_groups'])
    return sites, codes, helper_code, source_sha

_COST_SITES, _COST_CODES, _COST_HELPER_CODE, _COST_SOURCE_SHA = constructor_cost_sites()

def constructor_classifier_fallbacks():
    parameters = [torch.tensor([float(i + 1)], dtype=torch.float32) for i in range(32)]
    p = parameters[-1]
    events = []
    marker = LookupError('classifier must not invoke unknown protocols')
    class UnknownDict(dict):
        def __iter__(self): events.append('dict-iter'); raise marker
        def get(self, *args): events.append('dict-get'); raise marker
    class UnknownList(list):
        def __iter__(self): events.append('list-iter'); raise marker
    class UnknownKey:
        def __hash__(self): return 7
        def __eq__(self, other): events.append('key-eq'); raise marker
    class UnknownParameter:
        def __hash__(self): events.append('parameter-hash'); raise marker
    class UnknownFalse:
        def __bool__(self): events.append('false-bool'); raise marker
    class UnknownOwner(optim.SGD): pass
    rows = []
    for name in ('early-dictionary', 'late-dictionary', 'late-key', 'late-container',
                 'late-member', 'late-duplicate', 'late-names', 'defaults-value',
                 'defaults-dictionary', 'defaults-key', 'defaults-names', 'owner-subclass'):
        groups = [{'params': [parameter]} for parameter in parameters]
        owner = object.__new__(UnknownOwner if name == 'owner-subclass' else optim.SGD)
        owner.defaults = {'lr': 0.001, 'momentum': 0, 'dampening': 0, 'weight_decay': 0,
                          'nesterov': False, 'maximize': False, 'foreach': None,
                          'differentiable': False, 'fused': None}
        if name == 'early-dictionary': groups[0] = UnknownDict(params=[parameters[0]])
        elif name == 'late-dictionary': groups[-1] = UnknownDict(params=[p])
        elif name == 'late-key': groups[-1][UnknownKey()] = 7
        elif name == 'late-container': groups[-1]['params'] = UnknownList([p])
        elif name == 'late-member': groups[-1]['params'] = [UnknownParameter()]
        elif name == 'late-duplicate': groups[-1]['params'] = [p, p]
        elif name == 'late-names': groups[-1]['param_names'] = []
        elif name == 'defaults-value': owner.defaults['differentiable'] = UnknownFalse()
        elif name == 'defaults-dictionary': owner.defaults = UnknownDict(owner.defaults)
        elif name == 'defaults-key': owner.defaults[UnknownKey()] = 7
        elif name == 'defaults-names': owner.defaults['param_names'] = []
        before = [[(id(key), id(value)) for key, value in dict.items(group)] for group in groups]
        defaults_before = [(id(key), id(value)) for key, value in dict.items(owner.defaults)]
        metrics = collections.Counter()
        def observe(frame, event, arg):
            if frame.f_code is not _COST_HELPER_CODE: return None
            if event == 'call': metrics['classifierCalls'] += 1
            elif event == 'line' and frame.f_lineno in _COST_SITES:
                metrics[_COST_SITES[frame.f_lineno]] += 1
            return observe
        assert sys.gettrace() is None
        try:
            sys.settrace(observe)
            result = optim._unnamed_groups_stable(owner, groups)
        finally: sys.settrace(None)
        assert result is False and events == []
        assert before == [[(id(key), id(value)) for key, value in dict.items(group)] for group in groups]
        assert defaults_before == [(id(key), id(value)) for key, value in dict.items(owner.defaults)]
        rows.append(dict(case=name, metrics=dict(metrics), result=result, events=list(events), unchanged=True))
    return rows

def constructor_cost_history(G, P, metadata, repetitions, regime, observed):
    tensors = [torch.tensor([float(i + 1)], dtype=torch.float32) for i in range(P)]
    expected = [[] for _ in range(G)]
    for i, parameter in enumerate(tensors): expected[i % G].append(parameter)
    def fresh_groups():
        if regime == 'shared-empty':
            assert P == 0 and metadata == 0
            return [dict(params=[])] * G
        return [dict(params=list(members), **{f'custom_{j}': j for j in range(metadata)})
                for members in expected]
    groups = fresh_groups()
    rows = []
    for repetition in range(repetitions):
        if regime == 'fresh' and repetition: groups = fresh_groups()
        original_members = [group['params'] for group in groups]
        before_keys = sum(len(group) for group in groups)
        metrics = collections.Counter()
        def observe(frame, event, arg):
            # This callback reads code/line identity only, never caller inputs.
            if frame.f_code not in _COST_CODES: return None
            if event == 'call' and frame.f_code is _COST_HELPER_CODE:
                metrics['classifierCalls'] += 1
            elif event == 'line' and frame.f_lineno in _COST_SITES:
                metrics[_COST_SITES[frame.f_lineno]] += 1
            return observe
        previous_trace = sys.gettrace()
        assert previous_trace is None
        try:
            if observed: sys.settrace(observe)
            optimizer = torch.optim.SGD(groups, lr=0.125)
        finally:
            sys.settrace(previous_trace)
        assert all(a is b for a, b in zip(optimizer.param_groups, groups))
        assert all(group['params'] is not before for group, before in zip(groups, original_members))
        assert all(len(group['params']) == len(members) and all(a is b for a, b in zip(group['params'], members))
                   for group, members in zip(groups, expected))
        assert not optimizer.state
        assert all(group['lr'] == 0.125 and 'param_names' not in group for group in groups)
        rows.append(dict(repetition=repetition, metrics=dict(metrics), beforeKeys=before_keys,
                         afterKeys=sum(len(group) for group in groups), identities=True,
                         copiedLists=True, stateEmpty=True, values=[p.tolist() for p in tensors]))
        del optimizer, original_members
        gc.collect()
    return rows

def constructor_cost_cases(dimensions):
    results = []
    for dimension in dimensions:
        G, P, metadata, repetitions, regime = dimension
        plain = constructor_cost_history(*dimension, False)
        observed = constructor_cost_history(*dimension, True)
        assert [{key: value for key, value in row.items() if key != 'metrics'} for row in observed] == [
            {key: value for key, value in row.items() if key != 'metrics'} for row in plain]
        gc.collect()
        diagnostics = torch._runtime_session.diagnostics()
        assert diagnostics.liveTensorHandles == 0 and diagnostics.liveTensorValues == 0
        results.append(dict(dimensions=dimension, rows=observed))
    return results
`;
