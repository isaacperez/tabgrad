/** Independent numeric presentation of native binary16 oracle words. */
export function halfValue(bits) {
  const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 31, fraction = bits & 1023;
  return exponent === 31 ? (fraction ? NaN : sign * Infinity) : exponent === 0
    ? sign * fraction * 2 ** -24 : sign * (1024 + fraction) * 2 ** (exponent - 25);
}

function inputValue(value) {
  return typeof value === 'number' ? value : value === 'nan' ? NaN : value === 'inf' ? Infinity : value === '-inf' ? -Infinity : -0;
}
function sameValues(actual, expected, label) {
  if (actual.length !== expected.length) throw Error(`${label}: wrong element count`);
  for (let index = 0; index < expected.length; index++) {
    if (!Object.is(actual[index], expected[index])) throw Error(`${label}: wrong value at ${index}: ${actual[index]} / ${expected[index]}`);
  }
}

function halfTensor(session, owned, device, values, shape) {
  const result = session.tensor(values, { dtype: 'float16', device, ...(shape === undefined ? {} : { shape }) });
  owned.push(result);
  return result;
}

export async function halfJavaScriptCases(session, oracle, device) {
  const owned = [], options = { dtype: 'float16', device };
  try {
    const created = halfTensor(session, owned, device, oracle.construction.inputs.map(inputValue));
    sameValues(await created.toArray(), oracle.construction.words.map(halfValue), 'construction');
    const p = oracle.pointwise, left = halfTensor(session, owned, device, p.left.map(halfValue)), right = halfTensor(session, owned, device, p.right.map(halfValue));
    const product = left.mul(right), sum = left.add(right), composed = product.add(left);
    owned.push(product, sum, composed);
    for (const [result, expected, label] of [[sum, p.add, 'add'], [product, p.mul, 'mul'], [composed, p.mulThenAdd, 'mul/add']]) {
      if (result.dtype !== 'float16') throw Error('Result lost its dtype');
      sameValues(await result.toArray(), expected.map(halfValue), label);
    }
    for (const [a, aShape, b, bShape, expected] of [
      [[1, 2, 3, 4, 5, 6], [2, 3], [1, 2, 3], [3], [2, 4, 6, 5, 7, 9]],
      [[1, 2, 3], [3, 1], [1, 2, 3], [1, 3], [2, 3, 4, 3, 4, 5, 4, 5, 6]],
      [[2], [], [1, 2, 3], [3], [3, 4, 5]],
      [[], [0, 3], [1, 2, 3], [3], []],
    ]) {
      const first = halfTensor(session, owned, device, a, aShape), second = halfTensor(session, owned, device, b, bShape), result = first.add(second);
      owned.push(result); sameValues(await result.toArray(), expected, 'broadcast');
    }
    const view = created.view([2, created.shape[0] / 2]); owned.push(view);
    created.close();
    sameValues(await view.toArray(), oracle.construction.words.map(halfValue), 'alias');
    const f32 = session.tensor([1], { device }); owned.push(f32);
    const before = session.diagnostics();
    for (const operation of [() => left.sum(), () => left.matmul(right), () => left.copy_(left),
      () => left.add(f32), () => session.tensor([1], { ...options, requiresGrad: true })]) {
      let error;
      try { operation(); } catch (value) { error = value; }
      if (!error || !['UNSUPPORTED_DTYPE', 'UNSUPPORTED_GRADIENT'].includes(error.code)) throw Error('Unsupported half request was not rejected');
    }
    const after = session.diagnostics();
    for (const key of ['liveTensorHandles', 'liveDerivativeNodes', 'hostToWasmCopies', 'kernelCalls']) {
      if (after[key] !== before[key]) throw Error(`Rejected request changed ${key}`);
    }
    return { construction: oracle.construction.words.length, pointwise: p.left.length, broadcasts: 4 };
  } finally { for (const value of owned) value.close(); }
}

/** The same public calls run inside Pyodide; no raw half API is exposed. */
export function halfPythonSource(oracle, device) {
  return `
import torch, math, json, gc

def _half_value(bits: int) -> float:
    sign = -1.0 if bits & 32768 else 1.0
    exponent, fraction = (bits >> 10) & 31, bits & 1023
    if exponent == 31:
        return float('nan') if fraction else sign * float('inf')
    return sign * fraction * 2.0 ** -24 if exponent == 0 else sign * (1024 + fraction) * 2.0 ** (exponent - 25)
def _half_check(actual: list[float], expected: list[int]) -> None:
    assert len(actual) == len(expected)
    for position, (a, bits) in enumerate(zip(actual, expected)):
        b = _half_value(bits)
        assert (math.isnan(a) and math.isnan(b)) or (a == b and (a != 0 or math.copysign(1, a) == math.copysign(1, b))), (position, a, b)
def _half_construct(data: object) -> torch.Tensor:
    return torch.tensor(data, dtype=torch.float16, device=${JSON.stringify(device)})

def check_half() -> None:
    reference = json.loads(${JSON.stringify(JSON.stringify(oracle))})
    raw = reference['construction']['inputs']
    data = [float(v) if isinstance(v, str) else v for v in raw]
    created = _half_construct(data)
    assert created.dtype is torch.float16 and repr(created.dtype) == 'torch.float16'
    assert created.dtype.is_floating_point and created.dtype.is_signed and not created.dtype.is_complex
    assert not created.requires_grad and created.grad is None
    _half_check(created.tolist(), reference['construction']['words'])
    p = reference['pointwise']
    left, right = _half_construct([_half_value(b) for b in p['left']]), _half_construct([_half_value(b) for b in p['right']])
    product, total = left * right, torch.add(left, right)
    composed = product + left
    for result, expected in [(product, p['mul']), (total, p['add']), (composed, p['mulThenAdd'])]:
        assert result.dtype is torch.float16
        _half_check(result.tolist(), expected)
    view = created.view(2, -1)
    del created
    gc.collect()
    _half_check([item for row in view.tolist() for item in row], reference['construction']['words'])
    for a, b, expected in [([[1.,2.,3.],[4.,5.,6.]], [1.,2.,3.], [[2.,4.,6.],[5.,7.,9.]]),
                            ([[1.],[2.],[3.]], [[1.,2.,3.]], [[2.,3.,4.],[3.,4.,5.],[4.,5.,6.]]),
                            (2., [1.,2.,3.], [3.,4.,5.]), ([], 2., [])]:
        first, second = _half_construct(a), _half_construct(b)
        output = torch.add(first, second, alpha=1)
        assert output.tolist() == expected
        del first, second, output
    del view, left, right, product, total, composed, result
    gc.collect()

check_half()
del check_half, _half_value, _half_check, _half_construct
gc.collect()
`;
}
