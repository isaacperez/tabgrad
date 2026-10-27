import { isDeepStrictEqual } from "node:util";
import { acquisitionSha256, isAcquisitionHash, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";

export const LAB_CONTAINER_INPUT = "/tabgrad-lab/input";
export const LAB_CONTAINER_IPC = "/tabgrad-lab/ipc";
export const LAB_CONTAINER_ENV = Object.freeze(["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C", "LC_ALL=C"]);
export const LAB_INIT_SOURCE = 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},2147483647);';
const check = value => requireAcquisition(value, "LAB_IDENTITY");
const emptyObject = v => v === null || v === undefined || typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));
const omittedFalse = (value, key) => !Object.hasOwn(value, key) || value[key] === false;

/** Image metadata is corroboration of independently admitted bytes, not binary authentication. */
export function validateLabImage(plan, observed) {
  const c = observed?.Config;
  check(observed?.Id === plan.image.id && observed.Os === "linux" && observed.Architecture === "amd64"
    && c && acquisitionSha256(JSON.stringify(c)) === plan.image.configSha256
    && (c.Env === null || c.Env === undefined || Array.isArray(c.Env) && c.Env.every(e => LAB_CONTAINER_ENV.includes(e))
      && new Set(c.Env.map(e => e.slice(0, e.indexOf("=")))).size === c.Env.length)
    && emptyObject(c.Volumes) && emptyObject(c.ExposedPorts)
    && (c.Healthcheck === null || c.Healthcheck === undefined || isDeepStrictEqual(c.Healthcheck.Test, ["NONE"])));
  return freezeHostData({ imageId: observed.Id, configSha256: plan.image.configSha256 });
}

/** Fixed stopped-container recipe; no name lookup, pull, restart, Docker init or host namespace selector. */
export function labContainerRequest(plan, casePath, inputPath, ipcPath) {
  const { uid, gid, groups } = plan.credentials;
  const mounts = [[inputPath, LAB_CONTAINER_INPUT, true], [ipcPath, LAB_CONTAINER_IPC, false]].map(([Source, Target, ReadOnly]) =>
    ({ Type: "bind", Source, Target, ReadOnly, BindOptions: { Propagation: "rprivate", NonRecursive: true, CreateMountpoint: false } }));
  return freezeHostData({ Image: plan.image.id, User: `${uid}:${gid}`, Env: [...LAB_CONTAINER_ENV],
    Entrypoint: [plan.image.nodePath, "--input-type=module", "--eval", LAB_INIT_SOURCE], Cmd: [], WorkingDir: "/",
    Tty: false, OpenStdin: false, StdinOnce: false, AttachStdin: false, AttachStdout: false, AttachStderr: false,
    NetworkDisabled: true, Healthcheck: { Test: ["NONE"] }, StopSignal: "SIGTERM",
    HostConfig: { NetworkMode: "none", PidMode: "", CgroupnsMode: "private", UsernsMode: "host", IpcMode: "none", UTSMode: "",
      Runtime: "runc", Init: false, ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: [],
      SecurityOpt: ["no-new-privileges=true"], AutoRemove: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      CgroupParent: casePath, GroupAdd: groups.filter(g => g !== gid), Mounts: mounts,
      PublishAllPorts: false, PortBindings: {}, VolumesFrom: [], Links: [], ExtraHosts: [] } });
}

export function createdLabContainer(observed) {
  check(observed && isAcquisitionHash(observed.Id) && Array.isArray(observed.Warnings) && observed.Warnings.length === 0);
  return observed.Id;
}

/** Relevant immutable settings and the new stopped object are checked before Start. */
export function validateLabContainer(request, id, operationId, observed) {
  const c = observed?.Config; const h = observed?.HostConfig; const s = observed?.State;
  check(observed?.Id === id && observed.Name === `/tabgrad-case-${operationId}` && observed.Image === request.Image
    && c && h && s?.Status === "created" && s.Running === false && s.Paused === false && s.Restarting === false
    && s.Dead === false && s.Pid === 0 && s.Error === "" && observed.Path === request.Entrypoint[0]
    && isDeepStrictEqual(observed.Args, request.Entrypoint.slice(1))
    && c.User === request.User && c.Image === request.Image && c.WorkingDir === "/" && c.StopSignal === "SIGTERM"
    && sameSet(c.Env, LAB_CONTAINER_ENV) && emptyObject(c.Volumes) && emptyObject(c.ExposedPorts)
    && isDeepStrictEqual(c.Entrypoint, request.Entrypoint) && (c.Cmd === null || isDeepStrictEqual(c.Cmd, []))
    && isDeepStrictEqual(c.Healthcheck?.Test, ["NONE"]));
  for (const key of ["Tty", "OpenStdin", "StdinOnce", "AttachStdin", "AttachStdout", "AttachStderr", "NetworkDisabled"]) check(c[key] === request[key]);
  for (const key of ["NetworkMode", "PidMode", "CgroupnsMode", "UsernsMode", "IpcMode", "UTSMode", "Runtime", "Init",
    "ReadonlyRootfs", "Privileged", "AutoRemove", "CgroupParent", "PublishAllPorts"]) check(h[key] === request.HostConfig[key]);
  check(sameSet(h.CapDrop, ["ALL"]) && (h.CapAdd === null || sameSet(h.CapAdd, []))
    && sameSet(h.SecurityOpt, ["no-new-privileges=true"]) && sameSet(h.GroupAdd ?? [], request.HostConfig.GroupAdd)
    && isDeepStrictEqual(h.RestartPolicy, request.HostConfig.RestartPolicy) && emptyObject(h.PortBindings)
    && ["Binds", "VolumesFrom", "Links", "ExtraHosts", "Devices", "DeviceRequests", "DeviceCgroupRules"].every(key => h[key] === undefined || h[key] === null || sameSet(h[key], []))
    && emptyObject(h.Tmpfs)
    && Array.isArray(h.Mounts) && h.Mounts.length === 2);
  for (const mount of request.HostConfig.Mounts) {
    const actual = h.Mounts.find(m => m.Target === mount.Target);
    check(actual && actual.Type === mount.Type && actual.Source === mount.Source
      && (mount.ReadOnly ? actual.ReadOnly === true : omittedFalse(actual, "ReadOnly"))
      && actual.BindOptions?.Propagation === "rprivate" && actual.BindOptions.NonRecursive === true
      && ["CreateMountpoint", "ReadOnlyNonRecursive", "ReadOnlyForceRecursive"].every(key => omittedFalse(actual.BindOptions, key)));
  }
  check(Array.isArray(observed.Mounts) && observed.Mounts.length === 2);
  for (const mount of request.HostConfig.Mounts) {
    const actual = observed.Mounts.find(m => m.Destination === mount.Target);
    check(actual && actual.Type === "bind" && actual.Source === mount.Source && actual.RW === !mount.ReadOnly
      && actual.Propagation === "rprivate");
  }
  return freezeHostData({ id, operationId, requestSha256: acquisitionSha256(JSON.stringify(request)),
    stoppedObserved: true, nativeRetirement: "unknown" });
}
