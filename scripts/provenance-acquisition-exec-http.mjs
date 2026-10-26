import { request as nativeRequest } from "node:http";
import { lstat } from "node:fs/promises";
import { AcquisitionHttpTransaction } from "./provenance-acquisition-http-transaction.mjs";
import { AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";
import { identityMatches } from "./provenance-acquisition-file-io.mjs";

function responseType(response, upgrade) {
  const headers = new Map();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i].toLowerCase();
    if (!["content-type", "connection", "upgrade", "content-encoding"].includes(name)) continue;
    requireAcquisition(!headers.has(name), "EXEC_PROTOCOL");
    headers.set(name, response.rawHeaders[i + 1].toLowerCase());
  }
  requireAcquisition(!headers.has("content-encoding") || headers.get("content-encoding") === "identity", "EXEC_PROTOCOL");
  requireAcquisition(upgrade ? response.statusCode === 101 && response.httpVersion === "1.1"
    && headers.get("connection") === "upgrade" && headers.get("upgrade") === "tcp"
    && headers.get("content-type") === "application/vnd.docker.multiplexed-stream"
    : headers.get("content-type") === "application/json", "EXEC_PROTOCOL");
}

/** Fixed Exec transactions only; no redirects, negotiation, agents, credentials or retries. */
class ExecHttp {
  #profile; #check; #request; #transactions = new Map(); #stopped = false; #active = false;
  constructor(profile, check, request) { this.#profile = profile; this.#check = check; this.#request = request; }

  async exchange(phase, method, path, body, status, consume = null) {
    requireAcquisition(!this.#active && !this.#stopped && !this.#transactions.has(phase)
      && ["create", "before", "start", "after"].includes(phase), "EXEC_PROTOCOL");
    this.#active = true;
    let tx;
    try {
      this.#check();
      const stat = await lstat(this.#profile.socket.path, { bigint: true });
      requireAcquisition(stat.isSocket() && !stat.isSymbolicLink(), "EXEC_IDENTITY");
      identityMatches(stat, this.#profile.socket.identity);
      this.#check();
      requireAcquisition(!this.#stopped, "EXEC_STOPPED");
      tx = new AcquisitionHttpTransaction("EXEC_HTTP", "EXEC_CLEANUP"); this.#transactions.set(phase, tx);
      const upgrade = consume !== null;
      const headers = { Host: "docker", "Content-Type": "application/json", "Content-Length": String(body.length),
        ...(upgrade ? { Connection: "Upgrade", Upgrade: "tcp" } : { Connection: "close" }) };
      const result = await tx.begin({ socketPath: this.#profile.socket.path, method, path, headers, agent: false,
        maxHeaderSize: this.#profile.limits.headerBytes, highWaterMark: this.#profile.limits.controlBytes }, body, this.#request);
      this.#check();
      requireAcquisition(result.upgraded === upgrade && result.response.statusCode === status, "EXEC_PROTOCOL");
      responseType(result.response, upgrade);
      let data;
      let used = 0;
      if (upgrade) {
        requireAcquisition(Buffer.isBuffer(result.head), "EXEC_PROTOCOL");
        if (result.head.length) { this.#check(); await consume(result.head); this.#check(); }
      } else data = Buffer.alloc(this.#profile.limits.controlBytes);
      for await (const chunk of result.stream) {
        this.#check();
        requireAcquisition(Buffer.isBuffer(chunk), "EXEC_PROTOCOL");
        if (upgrade) await consume(chunk);
        else {
          requireAcquisition(chunk.length <= data.length - used, "EXEC_METADATA_LIMIT");
          chunk.copy(data, used); used += chunk.length;
        }
        this.#check();
      }
      this.#check();
      requireAcquisition(tx.ended && (upgrade || result.response.complete), "EXEC_HTTP");
      return upgrade ? null : data.subarray(0, used);
    } catch (error) {
      tx?.abort();
      if (error?.code === "FILE_IDENTITY") throw new AcquisitionRecordError("EXEC_IDENTITY");
      if (error instanceof AcquisitionRecordError && /^EXEC_/.test(error.code)) throw error;
      throw new AcquisitionRecordError("EXEC_HTTP");
    } finally { this.#active = false; }
  }

  stop() { this.#stopped = true; for (const tx of this.#transactions.values()) tx.abort(); }
  join() { return Promise.all([...this.#transactions.values()].map(tx => tx.closed)); }
  snapshot() { return Object.freeze(Object.fromEntries([...this.#transactions].map(([phase, tx]) => [phase, tx.snapshot()]))); }
}

export function createExecHttp(profile, check, request = nativeRequest) { return new ExecHttp(profile, check, request); }
