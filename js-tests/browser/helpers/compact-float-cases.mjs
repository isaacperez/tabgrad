import { halfSumCases } from './float16-sum-cases.mjs';

/** Decode the independent 16-bit oracle words for numeric comparisons. */
function compactValue(bits, fractionBits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits & 0x7fff) >>> fractionBits;
  const exponentMask = (1 << (15 - fractionBits)) - 1;
  const bias = exponentMask >>> 1;
  const unit = 1 << fractionBits;
  const fraction = bits & (unit - 1);
  if (exponent === exponentMask) return fraction ? NaN : sign * Infinity;
  return exponent === 0 ? sign * fraction * 2 ** (1 - bias - fractionBits)
    : sign * (unit + fraction) * 2 ** (exponent - bias - fractionBits);
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

function compactTensor(session, owned, device, dtype, values, shape) {
  const result = session.tensor(values, { dtype, device, ...(shape === undefined ? {} : { shape }) });
  owned.push(result);
  return result;
}

async function checkHalfSums(session, device) {
  const options = { dtype: 'float16', device };
  const cases = halfSumCases();
  for (const { name, values, expected } of cases) {
    const data = values();
    const shape = data.length === 1 ? [] : [1, data.length];
    const input = session.tensor(data, { ...options, shape });
    const output = input.sum();
    input.close();
    try {
      if (output.dtype !== options.dtype || output.device !== device || output.shape.length !== 0 || output.requiresGrad) {
        throw Error(name + ': incorrect sum metadata');
      }
      sameValues(await output.toArray(), [expected], name);
    } finally { output.close(); }
  }
  const before = session.diagnostics();
  const input = session.tensor([1, 2, 3], options);
  const doubled = input.add(input), sum = doubled.sum(), result = sum.mul(sum);
  input.close(); doubled.close(); sum.close();
  try {
    sameValues(await result.toArray(), [144], 'resident add/sum/mul');
    const after = session.diagnostics();
    const readback = device === 'cpu' ? after.wasmToHostBytes - before.wasmToHostBytes
      : after.webgpu.readbackBytes - before.webgpu.readbackBytes;
    if (readback !== 2) throw Error('Unexpected resident sum readback bytes: ' + readback);
  } finally { result.close(); }
  return cases.length;
}

// 2,181 values span more than 17 groups of 128 and leave an odd tail.
const PACKED_ROWS = 727;
const PACKED_COLUMNS = [2, -3, 5];

export async function compactJavaScriptCases(session, oracle, device, dtype, fractionBits) {
  const decode = word => compactValue(word, fractionBits);
  const owned = [], options = { dtype, device };
  try {
    const created = compactTensor(session, owned, device, dtype, oracle.construction.inputs.map(inputValue));
    sameValues(await created.toArray(), oracle.construction.words.map(decode), 'construction');
    const p = oracle.pointwise, left = compactTensor(session, owned, device, dtype, p.left.map(decode)), right = compactTensor(session, owned, device, dtype, p.right.map(decode));
    const product = left.mul(right), sum = left.add(right), composed = product.add(left);
    owned.push(product, sum, composed);
    for (const [result, expected, label] of [[sum, p.add, 'add'], [product, p.mul, 'mul'], [composed, p.mulThenAdd, 'mul/add']]) {
      if (result.dtype !== dtype) throw Error('Result lost its dtype');
      sameValues(await result.toArray(), expected.map(decode), label);
    }
    for (const [a, aShape, b, bShape, expected, multiplied] of [
      [[1, 2, 3, 4, 5, 6], [2, 3], [1, 2, 3], [3], [2, 4, 6, 5, 7, 9], [1, 4, 9, 4, 10, 18]],
      [[1, 2, 3], [3, 1], [1, 2, 3], [1, 3], [2, 3, 4, 3, 4, 5, 4, 5, 6], [1, 2, 3, 2, 4, 6, 3, 6, 9]],
      [[2], [], [1, 2, 3], [3], [3, 4, 5], [2, 4, 6]],
      [[], [0, 3], [1, 2, 3], [3], [], []],
    ]) {
      const first = compactTensor(session, owned, device, dtype, a, aShape), second = compactTensor(session, owned, device, dtype, b, bShape), result = first.add(second);
      owned.push(result); sameValues(await result.toArray(), expected, 'broadcast');
      const product = first.mul(second); owned.push(product);
      sameValues(await product.toArray(), multiplied, 'broadcast multiplication');
    }
    const rows = Array.from({ length: PACKED_ROWS }, (_, index) => 1 + index % 7);
    for (const broadcast of [false, true]) {
      const shape = [PACKED_ROWS, PACKED_COLUMNS.length];
      const a = compactTensor(session, owned, device, dtype, broadcast ? rows : rows.flatMap(row => PACKED_COLUMNS.map(() => row)),
        broadcast ? [PACKED_ROWS, 1] : shape);
      const b = compactTensor(session, owned, device, dtype, broadcast ? PACKED_COLUMNS : rows.flatMap(() => PACKED_COLUMNS),
        broadcast ? [1, PACKED_COLUMNS.length] : shape);
      const total = a.add(b), product = a.mul(b);
      owned.push(total, product);
      sameValues(await total.toArray(), rows.flatMap(row => PACKED_COLUMNS.map(column => row + column)), 'odd packed addition');
      sameValues(await product.toArray(), rows.flatMap(row => PACKED_COLUMNS.map(column => row * column)), 'odd packed multiplication');
    }
    const channels = compactTensor(session, owned, device, dtype, [-1, 2, 3, 4, -2, 1, 0, .5, -4], [3, 3]);
    const scale = compactTensor(session, owned, device, dtype, [.5, 1, 2], [3]);
    const bias = compactTensor(session, owned, device, dtype, [1, .5, -1], [3]);
    const scaled = channels.mul(scale), biased = scaled.add(bias); owned.push(scaled, biased);
    sameValues(await biased.toArray(), [.5, 2.5, 5, 3, -1.5, 1, 1, 1, -9], 'stored channel scale and bias');
    const view = created.view([2, created.shape[0] / 2]); owned.push(view);
    created.close();
    sameValues(await view.toArray(), oracle.construction.words.map(decode), 'alias');
    const totalSums = dtype === 'float16' ? await checkHalfSums(session, device) : 0;
    const f32 = session.tensor([1], { device }); owned.push(f32);
    const before = session.diagnostics();
    for (const operation of [...(dtype === 'float16' ? [] : [() => left.sum()]), () => left.matmul(right), () => left.copy_(left),
      () => left.add(f32), () => session.tensor([1], { ...options, requiresGrad: true })]) {
      let error;
      try { operation(); } catch (value) { error = value; }
      if (!error || !['UNSUPPORTED_DTYPE', 'UNSUPPORTED_GRADIENT'].includes(error.code)) throw Error('Unsupported compact float request was not rejected');
    }
    const after = session.diagnostics();
    for (const key of ['liveTensorHandles', 'liveDerivativeNodes', 'hostToWasmCopies', 'kernelCalls']) {
      if (after[key] !== before[key]) throw Error(`Rejected request changed ${key}`);
    }
    let dimensionalSumRejected = false;
    try { left.sum(0); } catch (error) { dimensionalSumRejected = error instanceof TypeError; }
    if (!dimensionalSumRejected) throw Error('A dimensional sum was admitted');
    return { construction: oracle.construction.words.length, pointwise: p.left.length, broadcasts: 10, oddDense: 2, channelCompositions: 1, totalSums };
  } finally { for (const value of owned) value.close(); }
}

/** The same public calls run inside Pyodide; no raw half API is exposed. */
export function compactPythonSource(oracle, device, dtype, fractionBits) {
  const sumCases = dtype === 'float16' ? halfSumCases().map(({ name, words, expectedWord }) =>
    [name, [...words], expectedWord]) : [];
  return `
import torch, math, json, gc

_compact_dtype = getattr(torch, ${JSON.stringify(dtype)})
assert ${JSON.stringify(dtype)} in torch.__all__
_compact_fraction_bits = ${fractionBits}

def _half_value(bits: int) -> float:
    sign = -1.0 if bits & 32768 else 1.0
    exponent = (bits & 32767) >> _compact_fraction_bits
    exponent_mask = (1 << (15 - _compact_fraction_bits)) - 1
    bias = exponent_mask >> 1
    unit = 1 << _compact_fraction_bits
    fraction = bits & (unit - 1)
    if exponent == exponent_mask:
        return float('nan') if fraction else sign * float('inf')
    return (sign * fraction * 2.0 ** (1 - bias - _compact_fraction_bits) if exponent == 0
            else sign * (unit + fraction) * 2.0 ** (exponent - bias - _compact_fraction_bits))
def _half_check(actual: list[float], expected: list[int]) -> None:
    assert len(actual) == len(expected)
    for position, (a, bits) in enumerate(zip(actual, expected)):
        b = _half_value(bits)
        assert (math.isnan(a) and math.isnan(b)) or (a == b and (a != 0 or math.copysign(1, a) == math.copysign(1, b))), (position, a, b)
def _half_construct(data: object) -> torch.Tensor:
    return torch.tensor(data, dtype=_compact_dtype, device=${JSON.stringify(device)})

def check_half() -> int:
    reference = json.loads(${JSON.stringify(JSON.stringify(oracle))})
    raw = reference['construction']['inputs']
    data = [float(v) if isinstance(v, str) else v for v in raw]
    created = _half_construct(data)
    assert created.dtype is _compact_dtype and repr(created.dtype) == ${JSON.stringify('torch.' + dtype)}
    assert created.dtype.is_floating_point and created.dtype.is_signed and not created.dtype.is_complex
    assert not created.requires_grad and created.grad is None
    _half_check(created.tolist(), reference['construction']['words'])
    p = reference['pointwise']
    left, right = _half_construct([_half_value(b) for b in p['left']]), _half_construct([_half_value(b) for b in p['right']])
    product, total = left * right, torch.add(left, right)
    composed = product + left
    for result, expected in [(product, p['mul']), (total, p['add']), (composed, p['mulThenAdd'])]:
        assert result.dtype is _compact_dtype
        _half_check(result.tolist(), expected)
    view = created.view(2, -1)
    del created
    gc.collect()
    _half_check([item for row in view.tolist() for item in row], reference['construction']['words'])
    for a, b, expected, multiplied in [([[1.,2.,3.],[4.,5.,6.]], [1.,2.,3.], [[2.,4.,6.],[5.,7.,9.]], [[1.,4.,9.],[4.,10.,18.]]),
                            ([[1.],[2.],[3.]], [[1.,2.,3.]], [[2.,3.,4.],[3.,4.,5.],[4.,5.,6.]], [[1.,2.,3.],[2.,4.,6.],[3.,6.,9.]]),
                            (2., [1.,2.,3.], [3.,4.,5.], [2.,4.,6.]), ([], 2., [], [])]:
        first, second = _half_construct(a), _half_construct(b)
        output = torch.add(first, second, alpha=1)
        assert output.tolist() == expected
        multiplied_output = first * second
        assert multiplied_output.tolist() == multiplied
        del first, second, output, multiplied_output
    rows = [1 + index % 7 for index in range(${PACKED_ROWS})]
    columns = ${JSON.stringify(PACKED_COLUMNS)}
    for broadcast in (False, True):
        first = _half_construct([[row] if broadcast else [row for _ in columns] for row in rows])
        second = _half_construct([columns] if broadcast else [columns for _ in rows])
        assert (first + second).tolist() == [[row + column for column in columns] for row in rows]
        assert (first * second).tolist() == [[row * column for column in columns] for row in rows]
        del first, second
    channels = _half_construct([[-1.,2.,3.],[4.,-2.,1.],[0.,.5,-4.]])
    scale, bias = _half_construct([.5,1.,2.]), _half_construct([1.,.5,-1.])
    scaled = channels * scale
    biased = scaled + bias
    assert biased.tolist() == [[.5,2.5,5.],[3.,-1.5,1.],[1.,1.,-9.]]
    total_sums = 0
    for index, (name, words, expected) in enumerate(${JSON.stringify(sumCases)}):
        data = [_half_value(word) for word in words]
        source = _half_construct(data[0] if len(data) == 1 else [data])
        summed = (source.sum, lambda: torch.sum(source), lambda: torch.sum(input=source))[index % 3]()
        del source
        assert summed.dtype is _compact_dtype and tuple(summed.shape) == () and not summed.requires_grad, name
        _half_check([summed.tolist()], [expected])
        del summed
        total_sums += 1
    if _compact_dtype is torch.float16:
        source = _half_construct([[1., 2., 3.]])
        reduced = (source + source).sum()
        composed_sum = reduced * reduced
        del source, reduced
        assert composed_sum.tolist() == 144.
        for rejected in (lambda: left.sum(0), lambda: torch.sum(left, dtype=_compact_dtype)):
            try:
                rejected()
            except TypeError:
                pass
            else:
                raise AssertionError("A sum overload was admitted")
        del composed_sum, rejected
    del channels, scale, bias, scaled, biased
    del view, left, right, product, total, composed, result
    gc.collect()
    return total_sums

assert check_half() == ${sumCases.length}
del check_half, _half_value, _half_check, _half_construct, _compact_dtype, _compact_fraction_bits
gc.collect()
`;
}
