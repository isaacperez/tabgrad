import { pythonTensorDeviceSource } from "./python-tensor-device.mjs";
import { matrixCases, exactMatrixProduct } from "./float32-matrix-oracle.mjs";

export function pythonMatrixNumericalChecks(device = "cpu") {
  const fixtures = matrixCases().filter(fixture => fixture.flags === 0).map(fixture => {
    const [m, k, n] = fixture.shape;
    const seed = new Uint32Array(m * n).fill(0x3f000000);
    return { name: fixture.name, shape: fixture.shape, left: [...fixture.left], right: [...fixture.right],
      expected: [[...fixture.expected], [...exactMatrixProduct(seed, fixture.right, [m, n, k], 2)],
        [...exactMatrixProduct(fixture.left, seed, [k, m, n], 1)]] };
  });
  return `
import torch, struct, json, gc
def matrix_tensor_from_words(bits, shape, device, tracked=False):
    values = [struct.unpack('<f', struct.pack('<I', word))[0] for word in bits]
    return torch.tensor(values, dtype=torch.float32, device=device, requires_grad=tracked).view(*shape)

def assert_matrix_tensor_words(tensor, expected):
    values = [value for row in tensor.tolist() for value in row]
    assert len(values) == len(expected)
    for value, want in zip(values, expected):
        got = struct.unpack('<I', struct.pack('<f', value))[0]
        if want & 0x7fffffff > 0x7f800000:
            assert got & 0x7fffffff > 0x7f800000
        else: assert got == want, (got, want)

def check_python_matrix_words():
    for case in json.loads(${JSON.stringify(JSON.stringify(fixtures))}):
        m, k, n = case['shape']
        a = matrix_tensor_from_words(case['left'], (m,k), ${JSON.stringify(device)}, True)
        b = matrix_tensor_from_words(case['right'], (k,n), ${JSON.stringify(device)}, True)
        y = a @ b
        assert_matrix_tensor_words(y, case['expected'][0])
        seed = matrix_tensor_from_words([0x3f000000] * (m*n), (m,n), ${JSON.stringify(device)})
        ga, gb = torch.autograd.grad(y, (a,b), grad_outputs=seed)
        assert_matrix_tensor_words(ga, case['expected'][1])
        assert_matrix_tensor_words(gb, case['expected'][2])
check_python_matrix_words()
del check_python_matrix_words, matrix_tensor_from_words, assert_matrix_tensor_words
gc.collect()
`;
}

export function pythonMatrixChecks(oracle, device = "cpu") {
  if (!Array.isArray(oracle.matmulCases) || oracle.matmulCases.length === 0) throw new Error("Missing native matrix cases");
  return oracle.matmulCases.map(fixture => `
import torch, json, gc
def check_matrix_fixture():
${pythonTensorDeviceSource(fixture.source, device).trimEnd().split("\n").map(line => `    ${line}`).join("\n")}
    assert report == json.loads(${JSON.stringify(JSON.stringify(fixture.expected))}), (${JSON.stringify(fixture.name)}, report)
check_matrix_fixture()
gc.collect()
`).join("\n");
}
