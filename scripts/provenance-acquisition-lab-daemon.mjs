import { join } from "node:path";
import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { labPaths } from "./provenance-acquisition-lab-profile.mjs";

export function labContainerdPaths(p) {
  const f = labPaths(p); const base = join(f.exec, "containerd");
  return Object.freeze({ root: join(f.data, "containerd/daemon"), state: join(base, "daemon"),
    config: join(base, "containerd.toml"), pid: join(base, "containerd.pid"),
    grpc: join(base, "containerd.sock"), debug: join(base, "containerd-debug.sock"),
    ttrpc: join(base, "containerd.sock.ttrpc") });
}

/** Fixed generated v2 and migrated effective configuration; no imports or remote endpoints. */
export function validateLabContainerd(p, generated, effective) {
  const paths = labContainerdPaths(p);
  for (const [value, version] of [[generated, 2], [effective, 4]]) {
    requireAcquisition(value && value.version === version && value.root === paths.root && value.state === paths.state
      && (value.imports === null || Array.isArray(value.imports) && value.imports.length === 0)
      && value.grpc?.address === paths.grpc && !value.grpc.tcp_address
      && value.debug?.address === paths.debug && !value.metrics?.address
      && (value.proxy_plugins === null || value.proxy_plugins && Object.keys(value.proxy_plugins).length === 0), "LAB_PROTOCOL");
  }
  requireAcquisition(effective.ttrpc?.address === paths.ttrpc, "LAB_PROTOCOL");
  return paths;
}

/** API observations supplement native membership/configuration; they are not authority. */
export function validateLabDocker(p, version, info) {
  const f = labPaths(p);
  requireAcquisition(version?.Version === p.expected.dockerd && version.ApiVersion === "1.56"
    && typeof version.MinAPIVersion === "string" && version.Os === "linux" && version.Arch === "amd64"
    && info?.Driver === "vfs" && info.CgroupDriver === "cgroupfs" && info.CgroupVersion === "2"
    && info.DockerRootDir === f.data && info.Containers === 0 && info.Images === 0
    && info.LiveRestoreEnabled === false, "LAB_PROTOCOL");
}
