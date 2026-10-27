import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { request as nativeRequest } from "node:http";
import { AcquisitionRecordError, acquisitionSha256, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { AcquisitionHttpTransaction } from "./provenance-acquisition-http-transaction.mjs";
import { parseAcquisitionJson } from "./provenance-acquisition-json.mjs";
import { readNativeBytes } from "./provenance-acquisition-native-path.mjs";
import { identityMatches } from "./provenance-acquisition-file-io.mjs";
import { labFailureCode } from "./provenance-acquisition-lab-command.mjs";
import { freezeHostData } from "./provenance-acquisition-host-profile.mjs";
import { createdLabContainer, validateLabContainer, validateLabImage } from "./provenance-acquisition-lab-container.mjs";

/** Concrete diagnostic API owner: load one admitted local archive, inspect, create stopped cases once. */
export class LabDiagnosticDocker {
  #plan; #socket; #files; #retireFiles; #handles; #check; #request; #fs; #transactions = new Map();
  #effects = new Map(); #jobs = new Set(); #stopped = false; #first = null; #preservation = true;
  constructor(plan, socket, { files, retirementFiles, handles, check, request = nativeRequest, filesystem = { open, lstat, constants } }) {
    this.#plan = plan; this.#socket = socket; this.#files = files; this.#retireFiles = retirementFiles;
    this.#handles = handles; this.#check = check; this.#request = request;
    this.#fs = Object.freeze({ open: filesystem.open.bind(filesystem), lstat: filesystem.lstat.bind(filesystem),
      constants: Object.freeze({ ...filesystem.constants }) });
  }
  #gate = () => { requireAcquisition(!this.#stopped, "LAB_STOPPED"); return this.#check(); };
  stop() { this.#stopped = true; for (const tx of this.#transactions.values()) tx.abort(); }
  #own(work) {
    const record = { promise: null }; this.#jobs.add(record);
    record.promise = Promise.resolve().then(work).catch(error => {
      this.#first ??= labFailureCode(error); this.stop(); throw error;
    }).finally(() => this.#jobs.delete(record)); return record.promise;
  }
  async #socketCheck() {
    this.#gate(); const s = await this.#fs.lstat(this.#socket.path, { bigint: true }); this.#gate();
    requireAcquisition(s.isSocket() && !s.isSymbolicLink(), "LAB_IDENTITY"); identityMatches(s, this.#socket.identity);
  }
  async #call(label, method, path, body = Buffer.alloc(0), contentType = "application/json", expectedStatus = 200, knownBodySha256 = null) {
    this.#gate(); requireAcquisition(!this.#effects.has(label), "LAB_PROTOCOL");
    const state = { method, path, bodyBytes: body.length, bodySha256: knownBodySha256 ?? acquisitionSha256(body), requested: false,
      responseStatus: null, receivedBytes: 0, complete: false, firstFailure: null, nativeEffect: "unknown" };
    this.#effects.set(label, state); await this.#socketCheck();
    await this.#files.json(`${label}.request.json`, state, this.#plan.limits.responseBytes);
    if (contentType === "application/json") await this.#files.write(`${label}.request.body`, body, this.#plan.limits.responseBytes);
    this.#gate(); const tx = new AcquisitionHttpTransaction("LAB_PROTOCOL", "LAB_CLEANUP");
    this.#transactions.set(label, tx); const bytes = Buffer.alloc(this.#plan.limits.responseBytes); let count = 0; let response = null;
    try {
      state.requested = true;
      const r = await tx.begin({ socketPath: this.#socket.path, method, path, agent: false,
        headers: { Host: "docker", Connection: "close", "Content-Length": String(body.length), "Content-Type": contentType },
        maxHeaderSize: this.#plan.limits.headerBytes, highWaterMark: this.#plan.limits.responseBytes }, body, this.#request);
      this.#gate(); response = { statusCode: r.response.statusCode, rawHeaders: r.response.rawHeaders, httpVersion: r.response.httpVersion };
      state.responseStatus = response.statusCode;
      requireAcquisition(!r.upgraded && response.httpVersion === "1.1" && response.statusCode === expectedStatus, "LAB_PROTOCOL");
      for await (const chunk of r.stream) {
        this.#gate(); requireAcquisition(Buffer.isBuffer(chunk), "LAB_PROTOCOL");
        const size = Math.min(chunk.length, bytes.length - count); chunk.copy(bytes, count, 0, size); count += size;
        state.receivedBytes = count; requireAcquisition(size === chunk.length, "LAB_LIMIT");
      }
      this.#gate(); requireAcquisition(tx.ended && r.response.complete, "LAB_PROTOCOL");
      await this.#files.write(`${label}.body`, bytes.subarray(0, count), this.#plan.limits.responseBytes);
      state.complete = true;
      await this.#files.json(`${label}.response.json`, { ...state, response, capture: tx.snapshot() }, this.#plan.limits.responseBytes);
      return bytes.subarray(0, count);
    } catch (error) {
      state.firstFailure = labFailureCode(error); this.#first ??= state.firstFailure; tx.abort();
      try {
        await this.#retireFiles.write(`${label}.partial.body`, bytes.subarray(0, count), this.#plan.limits.responseBytes);
        await this.#retireFiles.json(`${label}.partial.response.json`, { ...state, response, capture: tx.snapshot() }, this.#plan.limits.responseBytes);
      } catch { this.#preservation = false; }
      throw error;
    } finally {
      tx.abort(); await tx.closed;
      // Keep the nine fixed request slots observable if a late response reopens local closure.
    }
  }
  async #archive() {
    const expected = this.#plan.image.archive; const c = this.#fs.constants; this.#gate();
    const h = await this.#fs.open(expected.path, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
    this.#handles.push(h); this.#gate(); let bytes; let failure;
    try {
      const s = await h.stat({ bigint: true }); this.#gate(); identityMatches(s, expected.identity);
      requireAcquisition(s.isFile() && s.nlink === 1n && s.size === BigInt(expected.bytes) && (s.mode & 0o022n) === 0n, "LAB_IDENTITY");
      bytes = await readNativeBytes(h, expected.bytes, this.#gate);
      const after = await h.stat({ bigint: true }); this.#gate(); identityMatches(after, expected.identity);
      requireAcquisition(bytes.length === expected.bytes && acquisitionSha256(bytes) === expected.sha256
        && s.size === after.size && s.mtimeNs === after.mtimeNs && s.ctimeNs === after.ctimeNs, "LAB_IDENTITY");
    } catch (error) { failure = error; }
    try { await this.#handles.close(h); } catch { failure ??= new AcquisitionRecordError("LAB_CLEANUP"); }
    if (failure) throw failure; return bytes;
  }
  async #loadArchive() {
    // #archive just verified these owned bytes; do not rescan or retain the large body during later queries.
    const body = await this.#archive();
    return this.#call("image.load", "POST", "/v1.56/images/load?quiet=1", body, "application/x-tar", 200, this.#plan.image.archive.sha256);
  }
  prepareImage() { return this.#own(async () => {
    const loaded = await this.#loadArchive();
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(loaded).split("\n").filter(Boolean);
    requireAcquisition(lines.length > 0, "LAB_PROTOCOL");
    for (const line of lines) {
      const event = parseAcquisitionJson(Buffer.from(line), "LAB_PROTOCOL");
      requireAcquisition(!event.error && !event.errorDetail, "LAB_PROTOCOL");
    }
    const listed = parseAcquisitionJson(await this.#call("image.list", "GET", "/v1.56/images/json?all=1"), "LAB_PROTOCOL");
    requireAcquisition(Array.isArray(listed) && listed.length === 1 && listed[0].Id === this.#plan.image.id, "LAB_IDENTITY");
    const observed = parseAcquisitionJson(await this.#call("image.inspect", "GET", `/v1.56/images/${this.#plan.image.id}/json`), "LAB_PROTOCOL");
    return validateLabImage(this.#plan, observed);
  }); }
  create(operationId, request) { return this.#own(async () => {
    requireAcquisition(Object.values(this.#plan.operations).includes(operationId), "LAB_INPUT");
    const label = `case-${operationId}.container`;
    const result = parseAcquisitionJson(await this.#call(`${label}.create`, "POST",
      `/v1.56/containers/create?name=tabgrad-case-${operationId}&platform=linux%2Famd64`, Buffer.from(JSON.stringify(request)), "application/json", 201), "LAB_PROTOCOL");
    const id = createdLabContainer(result);
    const observed = parseAcquisitionJson(await this.#call(`${label}.inspect`, "GET", `/v1.56/containers/${id}/json`), "LAB_PROTOCOL");
    const value = validateLabContainer(request, id, operationId, observed);
    const record = await this.#files.json(`${label}.prepared.json`, value, this.#plan.limits.responseBytes);
    return { ...value, preparedContainerSha256: record.sha256 };
  }); }
  async close() {
    this.stop(); await Promise.allSettled([...this.#jobs].map(r => r.promise));
    await Promise.allSettled([...this.#transactions.values()].map(tx => tx.closed)); return this.snapshot();
  }
  snapshot() {
    const captures = Object.fromEntries([...this.#transactions].map(([name, tx]) => [name, tx.snapshot()]));
    return freezeHostData({ stopped: this.#stopped, firstFailure: this.#first, preservationComplete: this.#preservation,
      pendingJobs: this.#jobs.size, pendingTransactions: Object.values(captures).filter(c => !c.requestClosed || c.responseObserved && !c.streamClosed).length,
      captures,
      effects: Object.fromEntries([...this.#effects].map(([name, state]) => [name, { ...state }])), nativeRetirement: "unknown" });
  }
}
