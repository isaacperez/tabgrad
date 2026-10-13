import { pythonTensorDeviceSource } from "./python-tensor-device.mjs";

function check(condition, message) { if (!condition) throw new Error(message); }
function flatten(value) { return Array.isArray(value) ? value.flat(Infinity) : [value]; }

/** Adapt the pinned native functional calls to the direct handle API. */
export async function checkFunctionalGradients(session, oracle, device) {
  for (const fixture of oracle.gradientCases) {
    const handles = [];
    const own = (value) => { handles.push(value); return value; };
    const tensor = (data, shape = [data.length], requiresGrad = true) => own(session.tensor(data, { shape, requiresGrad, device }));
    const grad = (output, inputs, seed) => session.grad(output, inputs, seed).map(own);
    try {
      let results;
      switch (fixture.name) {
        case "repeated-empty": {
          const x = tensor([]), loss = own(own(x.mul(x)).sum()); results = grad(loss, [x,x]); break;
        }
        case "distinct-view-identities": {
          const x = tensor([2,3]), v = own(x.view([1,2])), loss = own(own(v.add(v)).sum());
          results = grad(loss, [v,x]); break;
        }
        case "reusable-call-identities": {
          const x = tensor([2,3]), loss = own(own(x.add(x)).sum());
          results = [...grad(loss,[x,x]), ...grad(loss,[x,x])]; break;
        }
        case "branches-repeated-inputs": {
          const x = tensor([2, 3]), y = tensor([5, 7]);
          results = grad(own(own(own(x.mul(y)).add(own(x.mul(x)))).sum()), [x, y, x]); break;
        }
        case "interior-sum": {
          const x = tensor([2, 3]), factor = tensor([3], []);
          results = grad(own(own(x.sum()).mul(factor)), [x, factor]); break;
        }
        case "intermediate-and-ancestor": {
          const x = tensor([2, 3]), middle = own(x.mul(x));
          results = grad(own(middle.sum()), [middle, x]); break;
        }
        case "matrix-seed-view": {
          const x = tensor([2, 3]);
          results = grad(own(x.view([1, 2])), [x], tensor([2, 3], [1, 2], false)); break;
        }
        case "hidden-computed-factor": {
          const x = tensor([2, 3]), plain = tensor([5, 7], [2], false);
          const factor = own(plain.mul(plain)), product = own(x.mul(factor)), loss = own(product.sum());
          plain.close(); factor.close(); product.close();
          await loss.toArray(); results = grad(loss, [x]); break;
        }
        case "empty-input": {
          const x = tensor([], [2, 0]); results = grad(own(own(x.mul(x)).sum()), [x]); break;
        }
        case "scalar": case "singleton-rank": {
          const x = tensor([3], fixture.name === "scalar" ? [] : [1, 1, 1]);
          results = grad(own(x.mul(x)), [x]); break;
        }
        case "self-does-not-consume": {
          const x = tensor([2, 3]), square = own(x.mul(x)), seed = tensor([2, 3], [2], false);
          results = [...grad(square, [square], seed), ...grad(square, [x], seed)]; break;
        }
        case "payload-free-repeated": {
          const x = tensor([2, 3]), loss = own(own(own(x.add(x)).view([1, 2])).sum());
          results = [...grad(loss, [x]), ...grad(loss, [x])]; break;
        }
        case "consumed-irrelevant-ancestor": {
          const x = tensor([2, 3]), middle = own(x.mul(x)), loss = own(middle.sum());
          grad(loss, [x]).forEach((value) => value.close()); results = grad(loss, [middle]); break;
        }
        case "empty-output-explicit-seed": {
          const x = tensor([]); results = grad(own(x.mul(x)), [x], tensor([], [0], false)); break;
        }
        default: throw new Error(`Unadapted native functional case ${fixture.name}`);
      }
      check(results.length === fixture.expected.length, fixture.name);
      for (let index = 0; index < results.length; index++) {
        const result = results[index], [shape, values, tracked] = fixture.expected[index];
        check(JSON.stringify([result.shape, [...await result.toArray()], result.requiresGrad])
          === JSON.stringify([shape, flatten(values), tracked]), fixture.name);
        check(result.device === device, `${fixture.name}: result device`);
      }
      check(new Set(results).size === results.length, `${fixture.name}: repeated exposure identity`);
    } finally { for (const handle of handles.reverse()) handle.close(); }
    check(session.diagnostics().liveDerivativeNodes === 0 && session.diagnostics().liveSavedValues === 0,
      `${fixture.name}: derivative owners survived cleanup`);
  }
}

/** Native source is unchanged except the explicit factory device extension. */
export function pythonFunctionalGradientChecks(oracle, device) {
  const onDevice = (source) => source.replaceAll("dtype=torch.float32", `dtype=torch.float32, device=${JSON.stringify(device)}`);
  const valueCases = [...oracle.gradientCases, ...oracle.noGradCases, ...oracle.noGradViewCases].map((fixture) => {
    const expression = fixture.name && oracle.gradientCases.includes(fixture)
      ? "[[list(value.shape), value.tolist(), value.requires_grad] for value in results]" : "report";
    return `
async def check_native_gpu_fixture():
    restorer = torch.no_grad()
    restorer.__enter__()
    restorer.__exit__(None, None, None)
    try:
${onDevice(fixture.source).trimEnd().split("\n").map((line) => `        ${line}`).join("\n")}
        assert ${expression} == json.loads(${JSON.stringify(JSON.stringify(fixture.expected))}), ${JSON.stringify(fixture.name)}
    finally:
        restorer.__exit__(None, None, None)
await check_native_gpu_fixture()
gc.collect()
assert session.diagnostics().liveDerivativeNodes == 0
assert session.diagnostics().liveSavedValues == 0
`;
  });
  const errorCases = oracle.gradientErrors.map((fixture) => `
def check_native_gpu_error():
${onDevice(fixture.source).trimEnd().split("\n").map((line) => `    ${line}`).join("\n")}
    try:
        ${onDevice(fixture.expression)}
    except ${fixture.type}:
        pass
    else:
        raise AssertionError('Native gradient error was not raised')
check_native_gpu_error()
gc.collect()
assert session.diagnostics().liveDerivativeNodes == 0
`);
  return `import torch, json, gc\nsession = torch._runtime_session\n${[...valueCases, ...errorCases].join("\n")}\n${pythonFunctionalIdentityChecks(oracle, device)}
${pythonGradientProvenanceChecks(oracle, device)}`;
}

/** Expansion is a storage copy; exact words, including NaN payload, must survive. */
export async function checkGpuExpansion(session) {
  for (const word of [0, 0x80000000, 1, 0x80000001, 0x7fffff, 0x3f800001,
    0x7f800000, 0xff800000, 0x7fc12345, 0x7f812345]) {
    for (const shape of [[0], [], [1, 1, 1], [2, 3], [63], [64], [65], [127], [128], [129]]) {
      const length = shape.reduce((count, n) => count * n, 1);
      const x = session.tensor(new Float32Array(length), { shape, device: "webgpu", requiresGrad: true });
      const sum = x.sum(), seed = session.tensor(new Float32Array(new Uint32Array([word]).buffer), { shape: [], device: "webgpu" });
      // Factories keep their ordinary numeric iterable conversion (which can
      // quiet a signaling NaN); expansion must preserve the stored word.
      const storedWord = new Uint32Array((await seed.toArray()).buffer)[0];
      const [gradient] = session.grad(sum, [x], seed);
      sum.close(); seed.close(); x.close();
      try {
        const actual = new Uint32Array((await gradient.toArray()).buffer);
        check(actual.length === length && actual.every((bits) => bits === storedWord), `Expansion ${word.toString(16)} / ${shape}`);
      } finally { gradient.close(); }
    }
  }
}

/** Python repeats a result object for repeated logical targets within one call. */
export function pythonFunctionalIdentityChecks(oracle, device = "cpu") {
  const checks = oracle.gradientCases.filter(fixture => fixture.resultIdentities).map(fixture => `
import torch, json, gc
def check_functional_identity():
${pythonTensorDeviceSource(fixture.source, device).trimEnd().split("\n").map(line => `    ${line}`).join("\n")}
    assert [[left is right for right in results] for left in results] == json.loads(${JSON.stringify(JSON.stringify(fixture.resultIdentities))}), ${JSON.stringify(fixture.name)}
check_functional_identity()
gc.collect()
`).join("\n");
  return checks + pythonTensorDeviceSource(pythonIdentityCohorts, device) + pythonSharedGradientIdentityChecks(oracle, device);
}


const pythonIdentityCohorts = `
def check_identity_occurrence(count, size):
    x = torch.tensor([2.] * size, dtype=torch.float32, requires_grad=True)
    results = torch.autograd.grad((x*x).sum(), tuple(x for _ in range(count)))
    assert len(results) == count and all(value is results[0] for value in results)
    assert len(set(results)) == 1 and len(dict.fromkeys(results)) == 1
    assert results[0].tolist() == [4.] * size
    alias = results[0].view(size)
    alias.copy_(torch.tensor([0.] * size, dtype=torch.float32))
    assert results[-1].tolist() == [0.] * size
for count, size, repetitions in ([(count,2,4) for count in (1,2,17,257)]
        + [(17,2,repetitions) for repetitions in (1,8,32)]
        + [(17,size,4) for size in (0,2,4096)]):
    for _ in range(repetitions):
        check_identity_occurrence(count, size)
        gc.collect()
        d = torch._runtime_session.diagnostics()
        assert d.liveTensorHandles == 0 and d.liveTensorValues == 0
        assert d.liveDerivativeNodes == 0 and d.liveSavedValues == 0
`;


/** Incoming equivalence and mutation are distinct observations; sum aliases remain #279. */
export function pythonSharedGradientIdentityChecks(oracle, device = "cpu") {
  return `import torch, json, gc
${pythonTensorDeviceSource(oracle.gradientIdentitySource, device)}
def check_shared_gradient_identity():
    cases = json.loads(${JSON.stringify(JSON.stringify(oracle.gradientIdentityCases))})
    for case in cases:
        actual = identity_report(tuple(case['shape']), case['kind'], case['repetitions'])
        expected = case['expected']
        # Native expanded-sum mutation observations are retained in the fixture;
        # #280 qualifies identity, shape and initial values, not #279's alias gap.
        if case['kind'] == 'sum':
            for field in ('identity', 'shape', 'values', 'tracking'):
                assert actual[field] == expected[field], (case, field, actual)
        else:
            assert actual == expected, (case, actual)
        gc.collect()
        d = torch._runtime_session.diagnostics()
        assert d.liveTensorHandles == 0 and d.liveTensorValues == 0
        assert d.liveDerivativeNodes == 0 and d.liveSavedValues == 0
check_shared_gradient_identity()
`;
}


/** The caller supplies existing host test instrumentation inspect_sgd_version. */
export function pythonGradientProvenanceChecks(oracle, device = "cpu") {
  return `import torch, json, gc
def probe_version(value):
    return inspect_sgd_version(value._handle)
${pythonTensorDeviceSource(oracle.gradientProvenanceSource, device)}
def check_gradient_provenance():
    for case in json.loads(${JSON.stringify(JSON.stringify(oracle.gradientProvenanceCases))}):
        shape = tuple(case['shape'])
        actual = (copy_owner_case(shape, case['mode'], case['method']) if case['kind'] == 'copy'
                  else view_result_case(shape, case['dirty']))
        assert actual == case['expected'], (case, actual)
        gc.collect()
        d = torch._runtime_session.diagnostics()
        assert d.liveTensorHandles == 0 and d.liveTensorValues == 0
        assert d.liveDerivativeNodes == 0 and d.liveSavedValues == 0
check_gradient_provenance()
`;
}
