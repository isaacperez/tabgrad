export async function checkJavaScriptArgmax(session, device) {
  const outer = 19, terms = 257, inner = 2;
  const scores = new Float32Array(outer * terms * inner).fill(-4);
  for (let group = 0; group < outer; group++) {
    const start = group * terms * inner;
    scores[start + 256 * inner] = 3;
    if (group % 2 === 0) scores[start + 3 * inner] = 3;
    scores[start + 254 * inner + 1] = NaN;
    scores[start + 256 * inner + 1] = NaN;
  }
  const input = session.tensor(scores, { shape: [outer, terms, inner], device, requiresGrad: true });
  const result = input.argmax(1);
  input.close();
  try {
    const before = session.diagnostics(), values = await result.toArray({ format: "typed" }), after = session.diagnostics();
    if (result.dtype !== "int64" || result.requiresGrad || String(result.shape) !== "19,2" ||
      !(values instanceof BigInt64Array) || values.length !== 38) throw Error("Incorrect argmax metadata");
    for (let group = 0; group < outer; group++) {
      if (values[group * 2] !== (group % 2 ? 256n : 3n) || values[group * 2 + 1] !== 254n) {
        throw Error("Partial argmax changed a tie, NaN or original position");
      }
    }
    if (device === "webgpu" && (after.webgpu.uploadBytes - before.webgpu.uploadBytes !== scores.byteLength ||
      after.webgpu.readbackBytes - before.webgpu.readbackBytes !== values.byteLength ||
      after.webgpu.kernelCalls - before.webgpu.kernelCalls < 2)) throw Error("Unexpected argmax GPU composition");
  } finally { result.close(); }

  const wide = session.tensor([2n ** 53n, 2n ** 53n + 1n, 2n ** 53n + 1n, -(2n ** 63n), -4294967297n, -4294967296n],
    { dtype: "int64", shape: [2, 3], device });
  const signed = session.tensor(Int32Array.of(-2147483648, 2147483647, 2147483647), { dtype: "int32", device });
  const empty = session.tensor([], { shape: [0, 2 ** 32 + 2], device });
  const a = wide.argmax(-1), b = signed.argmax(), c = empty.argmax(1, true);
  try {
    if (String(await a.toArray({ format: "typed" })) !== "1,2" || (await b.toArray({ format: "typed" }))[0] !== 1n
      || String(c.shape) !== "0,1" || (await c.toArray({ format: "typed" })).length !== 0) {
      throw Error("Invalid signed or empty argmax");
    }
  } finally { for (const value of [a, b, c, empty, signed, wide]) value.close(); }
}

export function pythonArgmaxSource(device) {
  return `
import torch
from math import inf, nan
def check_integer_argmax():
    options = dict(device=${JSON.stringify(device)})
    assert torch.long is torch.int64 and torch.int is torch.int32
    signed = [-2**63, 2**53, 2**53 + 1, 2**63 - 1]
    tensor = torch.tensor(signed, dtype=torch.int64, **options)
    assert tensor.tolist() == signed and all(type(x) is int for x in tensor.tolist())
    scalar = tensor.argmax()
    assert scalar.dtype is torch.int64 and scalar.shape == () and type(scalar.tolist()) is int and scalar.tolist() == 3
    assert torch.tensor(2**53 + 1, dtype=torch.long, **options).tolist() == 2**53 + 1
    assert torch.tensor([True, 1.875, -1.875, 2**31 - 0.125], dtype=torch.int32, **options).tolist() == [1, 1, -1, 2**31 - 1]
    for dtype, value, expected in [(torch.int64, 2**63, ValueError), (torch.int32, 2**63, ValueError),
                                  (torch.int32, 2**31, RuntimeError), (torch.int32, -2**31 - 0.125, RuntimeError),
                                  (torch.int64, float(2**63), RuntimeError), (torch.int64, nan, RuntimeError)]:
        try:
            torch.tensor(value, dtype=dtype, **options)
        except expected:
            pass
        else:
            raise AssertionError("Invalid signed construction was admitted")
    rows = [[(-4.0, -4.0) for j in range(257)] for i in range(19)]
    for i, row in enumerate(rows):
        row[256] = (3.0, nan)
        if i % 2 == 0:
            row[3] = (3.0, -4.0)
        row[254] = (-4.0, nan)
    x = torch.tensor(rows, dtype=torch.float32, requires_grad=True, **options)
    result = torch.argmax(x, dim=-2, keepdim=True, out=None)
    assert result.shape == (19, 1, 2) and result.dtype is torch.int64 and not result.requires_grad
    assert result.tolist() == [[[3 if i % 2 == 0 else 256, 254]] for i in range(19)]
    values = torch.tensor([[inf, nan, nan], [-0.0, 0.0, -0.0]], dtype=torch.float32, **options)
    assert values.argmax(1).tolist() == [1, 0]
    long = torch.tensor([2**53, 2**53+1], dtype=torch.int64, **options)
    assert torch.argmax(long).tolist() == 1
    assert torch.tensor([-2**31, 2**31-1, 2**31-1], dtype=torch.int32, **options).argmax().tolist() == 1
    wide_empty = torch.tensor([], dtype=torch.float32, **options).view(0, 2**32 + 2)
    assert wide_empty.argmax(1, True).shape == (0, 1)
    assert wide_empty.argmax(1).tolist() == []
    for dim, exc in [(None, IndexError), (0, IndexError), (2, IndexError), (2**53+1, IndexError), (2**63, ValueError), (True, TypeError)]:
        try:
            torch.argmax(wide_empty, dim=dim)
        except exc:
            pass
        else:
            raise AssertionError("Invalid argmax dimension was admitted")
check_integer_argmax()
del check_integer_argmax
`;
}
