import { pathToFileURL } from "node:url";
import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { createEnteringAcquisitionHostController } from "./provenance-acquisition-host.mjs";
import { failedHostReport } from "./provenance-acquisition-host-profile.mjs";
import { readHostGuardProfile, runAcquisitionHostGuard } from "./provenance-acquisition-host-guard.mjs";
import { encodeStartupGuardMessage, decodeStartupGuardStop } from "./provenance-acquisition-startup-protocol.mjs";

/** Owns only this entry's channel; lost parent never cancels the independent deadline loop. */
class StartupGuardChannel {
  #endpoint; #profile; #digest; #controller = null; #firstStop = null; #sending = false; #sequence = 0n;
  #pending = Promise.resolve(); #terminal = false;

  constructor(endpoint, profile, digest) { this.#endpoint = endpoint; this.#profile = profile; this.#digest = digest; }

  stop = (cause = "channel") => {
    this.#firstStop ??= cause;
    this.#controller?.contain(this.#firstStop);
  };

  disconnected = () => this.stop("channel");
  terminated = () => this.stop("controller");

  receive = wire => {
    try {
      const code = decodeStartupGuardStop(wire, this.#profile.operationId);
      this.stop(["peer", "channel", "deadline", "protocol", "clock", "storage"].includes(code) ? code : "controller");
    }
    catch { this.stop("protocol"); }
  };

  async open(createController, profile, role, options) {
    try { this.#controller = await createController(profile, role, options); }
    catch (error) {
      const failed = failedHostReport(role, profile.operationId, error);
      await this.final("failed", { ...failed, entry: failed.entry ?? { state: "not_requested", error: null } });
      throw error;
    }
    if (this.#firstStop) this.#controller.contain(this.#firstStop);
    return this.#controller;
  }

  send = (phase, report) => {
    if (this.#terminal && phase === "observation") return Promise.resolve();
    if (!this.#endpoint.connected) { this.stop(); return Promise.resolve(); }
    if (this.#sending) return Promise.resolve();
    this.#sending = true;
    const wire = encodeStartupGuardMessage({ version: 1, profileSha256: this.#digest, pid: this.#endpoint.pid,
      sequence: (++this.#sequence).toString(), phase, report });
    this.#pending = new Promise(resolve => {
      try {
        this.#endpoint.send(wire, error => {
          this.#sending = false;
          if (error) this.stop();
          resolve();
        });
      } catch { this.#sending = false; this.stop(); resolve(); }
    });
    return this.#pending;
  };

  async final(phase, report) {
    this.#terminal = true;
    await this.#pending;
    return this.send(phase, report);
  }
}

/** Native effects occur only when explicitly invoked with an independently identified prepared file. */
export async function startupGuardMain(args = process.argv.slice(2), endpoint = process, {
  createController = createEnteringAcquisitionHostController,
} = {}) {
  requireAcquisition(args.length === 2, "HOST_INPUT");
  const profile = await readHostGuardProfile(args[0], args[1]);
  const channel = new StartupGuardChannel(endpoint, profile, args[1]);
  endpoint.on("message", channel.receive);
  endpoint.on("disconnect", channel.disconnected);
  endpoint.on("error", channel.disconnected);
  endpoint.on("SIGTERM", channel.terminated);
  try {
    const result = await runAcquisitionHostGuard(profile, {
      createController: (p, r, options) => channel.open(createController, p, r, options),
      onArmed: report => { void channel.send("armed", report); },
      onObservation: report => { void channel.send("observation", report); },
    });
    await channel.final("boundary", result.observation);
    const settled = await result.settled;
    await channel.final("settled", settled);
  } finally {
    endpoint.removeListener("message", channel.receive);
    endpoint.removeListener("disconnect", channel.disconnected);
    endpoint.removeListener("error", channel.disconnected);
    endpoint.removeListener("SIGTERM", channel.terminated);
    if (endpoint.connected) endpoint.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startupGuardMain().catch(() => { process.exitCode = 1; });
}
