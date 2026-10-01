import { lstat } from "node:fs/promises";

export const maximumRecordedBrowserRequests = 64;
export const timeoutInspectionMilliseconds = 2_000;
const maximumResourceIdentifierCharacters = 256;
const knownMethods = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"]);

/** Passive per-run observations; never an authentication or admission owner. */
export class BrowserIngressDiagnostics {
  #active = true;
  #records = [];
  #truncated = false;
  #knownResources;
  #startedAt;

  constructor(knownResources, startedAt) {
    this.#knownResources = knownResources;
    this.#startedAt = startedAt;
  }

  elapsedMilliseconds() { return Math.round(performance.now() - this.#startedAt); }

  /** Retain only known identifiers; unknown input text is not diagnostic data. */
  begin(method, pathname, response) {
    if (!this.#active) return undefined;
    if (this.#records.length >= maximumRecordedBrowserRequests) {
      this.#truncated = true;
      return undefined;
    }
    const resource = !this.#knownResources.has(pathname) ? "[unregistered]"
      : pathname.length > maximumResourceIdentifierCharacters ? "[registered-identifier-omitted]" : pathname;
    const record = {
      elapsedMilliseconds: this.elapsedMilliseconds(),
      method: knownMethods.has(method) ? method : "OTHER",
      resource,
      association: "unresolved",
      stage: "received",
      progressMilliseconds: this.elapsedMilliseconds(),
      responseStatus: null,
      responseFinished: false,
      responseClosed: false,
    };
    this.#records.push(record);
    response.once("finish", () => {
      if (!this.#active) return;
      record.responseStatus = response.statusCode;
      record.responseFinished = true;
      record.responseFinishedMilliseconds = this.elapsedMilliseconds();
    });
    response.once("close", () => {
      if (!this.#active) return;
      record.responseClosed = true;
    });
    return record;
  }

  associate(record, association) {
    if (this.#active && record !== undefined) record.association = association;
  }

  progress(record, stage) {
    if (!this.#active || record === undefined) return;
    record.stage = stage;
    record.progressMilliseconds = this.elapsedMilliseconds();
  }

  snapshot() {
    return {
      incomingRequests: this.#records.map(record => ({ ...record })),
      incomingRequestsTruncated: this.#truncated,
    };
  }

  close() { this.#active = false; }
}

function profileInspectionFailure(error) {
  if (error?.code === "ENOENT") return { state: "missing" };
  const reason = error?.code === "EACCES" || error?.code === "EPERM" ? "permission-denied" : "inspection-error";
  return { state: "unavailable", reason };
}

async function inspectProfilePresence(profile, inspectProfile, milliseconds) {
  let timer;
  // Both completion handlers observe late settlement after a cooperative timeout.
  const inspection = Promise.resolve().then(() => inspectProfile(profile)).then(
    metadata => ({ state: metadata.isDirectory() ? "directory-present" : "not-directory" }),
    profileInspectionFailure,
  );
  try {
    return await Promise.race([
      inspection,
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ state: "unavailable", reason: "inspection-timeout" }), milliseconds);
      }),
    ]);
  } catch {
    return { state: "unavailable", reason: "inspection-error" };
  } finally { clearTimeout(timer); }
}

/** Freeze event/ingress state before awaiting one bounded, non-following metadata read.
 * No PID, profile path, file contents or native diagnostic message enters the record.
 * `inspectProfile` and `inspectionMilliseconds` permit controlled tooling tests;
 * ordinary runs use lstat and the finite shared diagnostic bound.
 */
export async function captureBrowserTimeoutSnapshot({
  child, processState, registration, profile,
  inspectProfile = lstat, inspectionMilliseconds = timeoutInspectionMilliseconds,
}) {
  const snapshot = registration.snapshot();
  const result = {
    elapsedMilliseconds: snapshot.elapsedMilliseconds,
    lastPhase: snapshot.lastPhase,
    incomingRequests: snapshot.incomingRequests,
    incomingRequestsTruncated: snapshot.incomingRequestsTruncated,
    process: {
      pidAssigned: child.pid !== undefined,
      spawnObserved: processState.spawnObserved,
      spawnFailed: processState.error !== null,
      exitCode: processState.exitCode,
      signal: processState.signal,
    },
  };
  result.profile = await inspectProfilePresence(profile, inspectProfile, inspectionMilliseconds);
  return result;
}
