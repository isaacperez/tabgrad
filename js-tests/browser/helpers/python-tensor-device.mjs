/** Select only tensor creation; preserve the maintained native source otherwise. */
export function pythonTensorDeviceSource(source, device) {
  if (device === "cpu") return source;
  if (device !== "webgpu") throw new Error("Unknown tensor fixture device");
  return `import torch
def _device_tensor(data, **kwargs):
    return torch.tensor(data, device="webgpu", **kwargs)
${source.replaceAll("torch.tensor(", "_device_tensor(")}`;
}
