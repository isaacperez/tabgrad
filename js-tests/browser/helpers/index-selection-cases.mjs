export async function checkJavaScriptIndexSelection(session, device) {
  const options = { device };
  const cells = Float32Array.from({ length: 1204 }, (_, index) => index);
  const data = session.tensor(cells, { ...options, shape: [602, 2] });
  const index = session.tensor(Int32Array.from({ length: 602 }, (_, index) => 601 - index), { ...options, dtype: "int32" });
  const selected = data.indexSelect(0, index);
  const observed = await selected.toArray();
  if (String(selected.shape) !== "602,2" || observed.length !== 1204) throw Error("Unexpected index selection shape");
  for (let pos = 0; pos < observed.length; pos++) {
    if (observed[pos] !== 2 * (601 - Math.floor(pos / 2)) + pos % 2) throw Error("Index selection order changed");
  }
  const scores = session.tensor([1, 10, 4], options);
  const signed = session.tensor([-(2n ** 63n), 2n ** 53n + 1n, 2n ** 63n - 1n], { ...options, dtype: "int64" });
  const argmax = scores.argmax();
  const picked = signed.indexSelect(0, argmax);
  const before = session.diagnostics();
  const result = await picked.toArray({ format: "typed" });
  const after = session.diagnostics();
  if (!(result instanceof BigInt64Array) || result[0] !== 2n ** 53n + 1n) throw Error("The signed value was rounded");
  if (device === "webgpu" && (after.webgpu.uploadBytes - before.webgpu.uploadBytes !== 36
    || after.webgpu.readbackBytes - before.webgpu.readbackBytes !== 8
    || after.webgpu.kernelCalls - before.webgpu.kernelCalls !== 2)) throw Error("Unexpected tensor traffic for argmax and selection");
  const rankZeroIndex = session.tensor([1], { ...options, dtype: "int32", shape: [] });
  const signedWithInt32 = signed.indexSelect(0, rankZeroIndex);
  const narrow = session.tensor([0, -2147483648], { ...options, dtype: "int32" });
  const narrowWithInt64 = narrow.indexSelect(0, argmax);
  const floatWithInt64 = data.indexSelect(0, argmax);
  if ((await signedWithInt32.toArray({ format: "typed" }))[0] !== 2n ** 53n + 1n ||
    (await narrowWithInt64.toArray({ format: "typed" }))[0] !== -2147483648 ||
    String(await floatWithInt64.toArray()) !== "2,3") {
    throw Error("Selection changed the stored signed representation");
  }
  const empty = session.tensor([], { ...options, shape: [0, 2 ** 32 + 2], dtype: "int64" });
  const fits = session.tensor([4294967297n], { ...options, dtype: "int64" });
  const invalid = session.tensor([4294967298n], { ...options, dtype: "int64" });
  const fitsResult = empty.indexSelect(1, fits), invalidResult = empty.indexSelect(1, invalid);
  if (String(fitsResult.shape) !== "0,1" || (await fitsResult.toArray({ format: "typed" })).length !== 0) {
    throw Error("Valid wide axis with empty output was rejected");
  }
  await requireBoundsError(invalidResult.toArray({ format: "typed" }));
  const bad = session.tensor([0n, 4294967297n], { ...options, dtype: "int64" });
  const neverValid = data.indexSelect(0, bad);
  const small = data.view([2, 602]);
  const anotherBad = small.indexSelect(1, bad);
  const dependent = neverValid.add(anotherBad);
  const failure = await requireBoundsError(dependent.toArray());
  if (failure.details.reason !== "index") throw Error("The failed selection lost its original error category");
  if ((await selected.toArray())[0] !== 1202) throw Error("Failed selection changed an independent result");
  const destination = session.tensor([4, 5, 6, 7], { ...options, shape: [2, 2] });
  const alias = destination.view([4]);
  destination.copy_(neverValid);
  await requireBoundsError(alias.toArray());
  if ((await data.toArray())[9] !== 9) throw Error("Failed copy modified its source");
  for (const tensor of [alias, destination, dependent, anotherBad, small, neverValid, bad, fitsResult, invalidResult, fits, invalid, empty,
    floatWithInt64, narrowWithInt64, narrow, signedWithInt32, rankZeroIndex, picked, argmax, signed, scores, selected, index, data]) tensor.close();
}

async function requireBoundsError(observation) {
  try { await observation; }
  catch (error) {
    if (error.code === "INDEX_OUT_OF_BOUNDS") return error;
    throw error;
  }
  throw Error("Invalid index payload was accepted");
}

export function pythonIndexSelectionSource(device) {
  return `
import torch

def check_index_selection():
    options = dict(device=${JSON.stringify(device)})
    data = torch.tensor([[10.0, -0.0], [20.0, 42.0]], dtype=torch.float32, **options)
    idx = torch.tensor([1, 0, 1], dtype=torch.int32, **options)
    chosen = torch.index_select(data, -2, idx, out=None)
    assert chosen.shape == (3, 2) and chosen.dtype is torch.float32
    assert chosen.tolist() == [[20.0, 42.0], [10.0, -0.0], [20.0, 42.0]]
    exact = torch.tensor([-2**63, 2**53 + 1, 2**63 - 1], dtype=torch.long, **options)
    scores = torch.tensor([1.0, 9.0, 2.0], dtype=torch.float32, **options)
    assert exact.index_select(0, scores.argmax()).tolist() == [2**53 + 1]
    scalar = torch.tensor(6, dtype=torch.int32, **options)
    zero = torch.tensor(0, dtype=torch.int32, **options)
    assert scalar.index_select(-1, zero).tolist() == 6
    two = torch.tensor(2, dtype=torch.int32, **options)
    assert exact.index_select(0, two).tolist() == [2**63 - 1]
    narrowed = torch.tensor([7, -2**31], dtype=torch.int32, **options)
    assert narrowed.index_select(0, scores.argmax()).tolist() == [-2**31]
    wide = torch.tensor([], dtype=torch.int64, **options).view(0, 2**32 + 2)
    good = torch.tensor([2**32 + 1], dtype=torch.int64, **options)
    bad = torch.tensor([2**32 + 2], dtype=torch.int64, **options)
    assert wide.index_select(1, good).shape == (0, 1)
    assert wide.index_select(1, good).tolist() == []
    one = torch.tensor([1], dtype=torch.int64, **options)
    for output, expected in [
        (wide.index_select(1, bad), RuntimeError),
        (data.index_select(1, bad), RuntimeError),
        (data.index_select(0, bad), IndexError),
        (exact.index_select(0, bad), IndexError),
        (scalar.index_select(0, one), IndexError),
    ]:
        assert not output.requires_grad
        try:
            output.tolist()
        except expected:
            pass
        else:
            raise AssertionError("Invalid device index did not raise the pinned exception category")
    tracked = torch.tensor([4.0, 3.0], dtype=torch.float32, requires_grad=True, **options)
    try:
        tracked.index_select(0, one)
    except RuntimeError:
        pass
    else:
        raise AssertionError("Forward-only index selection retained gradient recording")
    with torch.no_grad():
        assert tracked.index_select(0, one).tolist() == [3.0]
    assert data.tolist() == [[10.0, -0.0], [20.0, 42.0]]
check_index_selection()
del check_index_selection
`;
}

export function pythonBadSelectionCopySource(device) {
  return `
def fail_index_selection_copy():
    import torch
    options = dict(dtype=torch.float32, device=${JSON.stringify(device)})
    dest = torch.tensor([0.0, 0.0], **options)
    source = torch.tensor([5.0, 6.0], **options)
    bad = torch.tensor([0, 2**32 + 1], dtype=torch.long, device=options["device"])
    dest.copy_(source.index_select(0, bad))
fail_index_selection_copy()
del fail_index_selection_copy
`;
}
