export async function checkJavaScriptBooleanMask(session, device, grid) {
  const width = grid ? 4361 : 5;
  const values = new Float32Array(width);
  values.set([NaN, -0, 2 ** -149, -(2 ** -149), Infinity]);
  const left = session.tensor(values, { shape: [1, width], device, requiresGrad: true });
  const right = session.tensor([0, -(2 ** -148)], { shape: [2, 1], device });
  const mask = left.gt(right);
  try {
    if (mask.dtype !== "bool" || mask.requiresGrad || String(mask.shape) !== `2,${width}`) throw Error("Invalid mask metadata");
    const before = session.diagnostics();
    const bytes = await mask.toArray({ format: "typed" });
    const after = session.diagnostics();
    if (!(bytes instanceof Uint8Array) || bytes.length !== 2 * width) throw Error("Expected compact mask");
    for (let i = 0; i < bytes.length; i++) {
      const expected = Number(values[i % width] > (i < width ? 0 : -(2 ** -148)));
      if (bytes[i] !== expected) throw Error(`Incorrect boolean mask element ${i}`);
    }
    if (device === "webgpu" && (after.webgpu.uploadBytes - before.webgpu.uploadBytes !== values.byteLength + 8
      || after.webgpu.readbackBytes - before.webgpu.readbackBytes !== bytes.length)) throw Error("Unexpected GPU mask transfers");
  } finally {
    mask.close();
    right.close();
    left.close();
  }

  const scalar = session.tensor([3], { shape: [], device });
  const zero = session.tensor([0], { shape: [], device });
  const empty = session.tensor([], { shape: [2, 0, 3], device });
  const rankZero = scalar.gt(zero), emptyMask = empty.gt(scalar);
  try {
    if (rankZero.shape.length !== 0 || (await rankZero.toArray({ format: "typed" }))[0] !== 1) {
      throw Error("Invalid rank-zero comparison");
    }
    if (String(emptyMask.shape) !== "2,0,3" || (await emptyMask.toArray({ format: "typed" })).length !== 0) {
      throw Error("Invalid empty comparison");
    }
  } finally {
    for (const tensor of [emptyMask, rankZero, empty, zero, scalar]) tensor.close();
  }
  await checkJavaScriptSelection(session, device, grid);
}

async function checkJavaScriptSelection(session, device, grid) {
  // Four broadcast rows force the projected shader into a grid on the bounded device.
  const columns = grid ? 275 : 3;
  const score = session.tensor([1], { shape: [], device });
  const limits = session.tensor([0, 2], { shape: [1, 2, 1], device });
  const mask = score.gt(limits);
  const choices = Float32Array.from({ length: columns }, (_, i) => 5 + i);
  const yes = session.tensor(choices, { shape: [1, 1, columns], device });
  const no = session.tensor([-0, NaN], { shape: [2, 1, 1], device });
  const selected = session.where(mask, yes, no);
  try {
    const before = session.diagnostics();
    const observed = await selected.toArray();
    const after = session.diagnostics();
    const expected = [...choices, ...new Float32Array(columns).fill(-0), ...choices, ...new Float32Array(columns).fill(NaN)];
    if (String(selected.shape) !== `2,2,${columns}` || !expected.every((value, i) => Object.is(value, observed[i]))) {
      throw Error("Three-way selection changed a selected value");
    }
    if (device === "webgpu" && (after.webgpu.uploadBytes - before.webgpu.uploadBytes !== 20 + choices.byteLength
      || after.webgpu.readbackBytes - before.webgpu.readbackBytes !== 4 * choices.byteLength
      || after.webgpu.kernelCalls - before.webgpu.kernelCalls !== 2)) throw Error("Unexpected selection transfers or dispatch");
  } finally {
    for (const tensor of [selected, mask, score, limits, yes, no]) tensor.close();
  }

  const condition = session.tensor([true, true, true, true], { dtype: "bool", device });
  const left = session.tensor([2], { device, requiresGrad: true });
  const right = session.tensor([3], { device, requiresGrad: true });
  const result = session.where(condition, left, right);
  condition.close();
  const seed = session.tensor([1e20, 1, -1e20, 1], { device });
  const [a, b] = session.grad(result, [left, right], seed);
  try {
    if ((await a.toArray())[0] !== (device === "webgpu" ? 2 : 0) || (await b.toArray())[0] !== 0) {
      throw Error("Selection gradients departed from the approved receiving arithmetic");
    }
  } finally {
    for (const tensor of [a, b, result, seed, left, right]) tensor.close();
  }

  // Above 17 workgroups on the real device's deliberately bounded grid.
  const width = grid ? 1093 : 5;
  const keep = session.tensor(Uint8Array.from({ length: width }, (_, i) => i % 2), { dtype: "bool", device });
  const options = { device, requiresGrad: true };
  const x = session.tensor(new Float32Array(width).fill(1), options);
  const y = session.tensor(new Float32Array(width).fill(2), options);
  const output = session.where(keep, x, y);
  const incoming = session.tensor(Float32Array.from({ length: width }, (_, i) => i % 2 ? -0 : NaN), { device });
  const [dx, dy] = session.grad(output, [x, y], incoming);
  try {
    const [values, leftGradient, rightGradient] = await Promise.all([output.toArray(), dx.toArray(), dy.toArray()]);
    for (let i = 0; i < width; i++) {
      const selectedLeft = i % 2 !== 0;
      if (values[i] !== (selectedLeft ? 1 : 2)
        || !Object.is(leftGradient[i], selectedLeft ? -0 : 0)
        || !Object.is(rightGradient[i], selectedLeft ? 0 : NaN)) throw Error("Selection failed to preserve the chosen branch and seed bits");
    }
  } finally {
    for (const tensor of [dx, dy, incoming, output, x, y, keep]) tensor.close();
  }
}

export function pythonBooleanMaskSource(device, grid) {
  return `
import torch
from math import copysign, inf, isnan, nan
def check_boolean_mask():
    options = dict(device=${JSON.stringify(device)})
    values = torch.tensor([True, -0.0, 2**-1074, 2**2048, nan, inf],
                          dtype=torch.bool, **options).view(2, 3)
    assert values.dtype is torch.bool and not values.requires_grad
    assert values.tolist() == [[True, False, True], [True, True, True]]
    assert type(values.tolist()[0][0]) is bool
    scalar = torch.tensor(False, dtype=torch.bool, **options)
    assert scalar.tolist() is False
    scores = torch.tensor([[1.0], [4.0]], dtype=torch.float32, **options)
    thresholds = torch.tensor([0.0, 2.0, 5.0], dtype=torch.float32, **options)
    comparison = torch.gt(scores, thresholds)
    assert comparison.tolist() == [[True, False, False], [True, True, False]]
    selected_scores = torch.where(comparison, scores, torch.tensor(0.0, dtype=torch.float32, **options))
    assert selected_scores.tolist() == [[1.0, 0.0, 0.0], [4.0, 4.0, 0.0]]
    width = ${grid ? 4361 : 5}
    tiny = 2**-149
    x = torch.tensor([[nan, -0.0, tiny, -tiny, inf] + [0.0] * (width - 5)],
                     dtype=torch.float32, requires_grad=True, **options)
    y = torch.tensor([[0.0], [-2 * tiny]], dtype=torch.float32, **options)
    mask = torch.gt(x, y)
    assert mask.shape == (2, width) and mask.dtype is torch.bool and not mask.requires_grad
    row0 = [False, False, True, False, True] + [False] * (width - 5)
    row1 = [False, True, True, True, True] + [True] * (width - 5)
    for result in [mask, x.gt(y), x > y]:
        assert result.tolist() == [row0, row1]
    rank_zero = torch.tensor(3, dtype=torch.float32, **options)
    zero = torch.tensor(0, dtype=torch.float32, **options)
    assert torch.gt(rank_zero, zero).tolist() is True
    empty = torch.tensor([], dtype=torch.float32, **options).view(2, 0, 3)
    empty_mask = empty > rank_zero
    assert empty_mask.shape == (2, 0, 3) and empty_mask.tolist() == [[], []]
    selection = torch.where(empty_mask, empty, rank_zero)
    assert selection.shape == (2, 0, 3) and selection.tolist() == [[], []]
    assert torch.where(torch.gt(rank_zero, zero), rank_zero, zero).tolist() == 3.0
    threshold = torch.tensor([[[0.0], [2.0]]], dtype=torch.float32, **options)
    one = torch.tensor(1.0, dtype=torch.float32, **options)
    choices = list(range(5, ${grid ? 280 : 8}))
    yes = torch.tensor([[choices]], dtype=torch.float32, **options)
    no = torch.tensor([[[-0.0]], [[nan]]], dtype=torch.float32, **options)
    selected = torch.where(one > threshold, yes, no)
    assert selected.shape == (2, 2, len(choices))
    values = selected.tolist()
    assert values[0][0] == values[1][0] == choices
    assert all(value == 0.0 and copysign(1.0, value) < 0 for value in values[0][1])
    assert all(isnan(value) for value in values[1][1])
    a = torch.tensor([[1.0], [3.0]], dtype=torch.float32, requires_grad=True, **options)
    b = torch.tensor([[2.0, 0.0, 4.0]], dtype=torch.float32, requires_grad=True, **options)
    mask = a > b
    selected = torch.where(mask, a, b)
    del mask
    da, db = torch.autograd.grad(selected.sum(), (a, b))
    assert selected.tolist() == [[2.0, 1.0, 4.0], [3.0, 3.0, 4.0]]
    assert da.tolist() == [[1.0], [2.0]]
    assert db.tolist() == [[1.0, 0.0, 2.0]]
    try:
        torch.where(a, a, b)
    except RuntimeError:
        pass
    else:
        raise AssertionError("Selection admitted a float condition")
    try:
        torch.where(scalar, a, torch.tensor([1.0], dtype=torch.float16, **options))
    except RuntimeError:
        pass
    else:
        raise AssertionError("Selection admitted a float16 branch")
check_boolean_mask()
del check_boolean_mask
`;
}
