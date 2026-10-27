import { requireAcquisition } from "./provenance-acquisition-record.mjs";

// Internal retained-handle primitives shared by the two Linux observers.
// Callers own profile validation, encoding, policy and the complete handle set.
export const CGROUP2_MAGIC = 0x63677270n;
export const PROC_MAGIC = 0x9fa0n;
export const nativeKey = stat => `${stat.dev}:${stat.ino}`;
const noCheckpoint = () => {};

export function nativeFdPath(handle) {
  requireAcquisition(Number.isSafeInteger(handle.fd) && handle.fd >= 0, "HOST_IDENTITY");
  return `/proc/self/fd/${handle.fd}`;
}

export function nativeIdentity(stat, expected, directory) {
  requireAcquisition(typeof stat.dev === "bigint" && typeof stat.ino === "bigint" && stat.ino > 0n
    && typeof stat.nlink === "bigint" && stat.nlink > 0n && (directory ? stat.isDirectory() : stat.isFile()), "HOST_IDENTITY");
  if (expected) requireAcquisition(nativeKey(stat) === `${expected.dev}:${expected.ino}`, "HOST_IDENTITY");
  return nativeKey(stat);
}

export async function readNativeBytes(handle, limit, checkpoint = noCheckpoint) {
  const bytes = Buffer.alloc(limit + 1);
  let count = 0;
  while (count < bytes.length) {
    checkpoint();
    const r = await handle.read(bytes, count, bytes.length - count, count);
    checkpoint();
    requireAcquisition(Number.isInteger(r.bytesRead) && r.bytesRead >= 0 && r.bytesRead <= bytes.length - count, "HOST_READ");
    if (r.bytesRead === 0) break;
    count += r.bytesRead;
  }
  requireAcquisition(count <= limit, "HOST_READ");
  return bytes.subarray(0, count);
}

export async function readNativeAscii(handle, limit, checkpoint = noCheckpoint) {
  const bytes = await readNativeBytes(handle, limit, checkpoint);
  requireAcquisition(bytes.every(b => b === 10 || b >= 32 && b <= 126), "HOST_READ");
  return bytes.toString("ascii");
}

export async function openNativeDirectory(path, expected, port, handles, filesystem = null, checkpoint = noCheckpoint) {
  const c = port.constants;
  checkpoint();
  const handle = await port.open(path, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
  handles.push(handle);
  checkpoint();
  const stat = await handle.stat({ bigint: true }); checkpoint();
  nativeIdentity(stat, expected, true);
  if (filesystem !== null) {
    const fs = await port.statfs(nativeFdPath(handle), { bigint: true }); checkpoint();
    requireAcquisition(fs.type === filesystem, "HOST_FILESYSTEM");
  }
  return handle;
}

export async function openNativeRoot(root, port, handles, filesystem = CGROUP2_MAGIC, checkpoint = noCheckpoint) {
  let handle = await openNativeDirectory("/", null, port, handles, null, checkpoint);
  const parts = root.path.split("/").slice(1);
  for (let i = 0; i < parts.length; i += 1) handle = await openNativeDirectory(`${nativeFdPath(handle)}/${parts[i]}`,
    i === parts.length - 1 ? root.identity : null, port, handles, i === parts.length - 1 ? filesystem : null, checkpoint);
  return handle;
}
