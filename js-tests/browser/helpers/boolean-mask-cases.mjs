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
}

export function pythonBooleanMaskSource(device, grid) {
  return `
import torch
from math import inf, nan
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
    assert torch.gt(scores, thresholds).tolist() == [[True, False, False], [True, True, False]]
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
check_boolean_mask()
del check_boolean_mask
`;
}
