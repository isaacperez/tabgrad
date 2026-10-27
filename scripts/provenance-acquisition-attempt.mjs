import {
  AcquisitionRecordError, acquisitionFields as fields, isAcquisitionUtc, requireAcquisition,
} from "./provenance-acquisition-record.mjs";
import { createAcquisitionCaptureAttempt } from "./provenance-acquisition-capture-attempt.mjs";
import { createExecBounds } from "./provenance-acquisition-exec-attempt.mjs";
import { isDeepStrictEqual } from "node:util";
import { createAcquisitionActivation } from "./provenance-acquisition-activation.mjs";
import { createAcquisitionPlacement } from "./provenance-acquisition-placement.mjs";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const codeOf = error => error instanceof AcquisitionRecordError ? error.code : "ACQ_ATTEMPT_PROTOCOL";
const minimum = (a, b) => a < b ? a : b;

/** Owns the local startup/capture join, not physical observation or admission. */
class AcquisitionAttempt {
  #startup; #clock; #capture; #timing; #bounds; #origin; #last; #deadline; #closeUntil = null;
  #openWait = null; #runWait = null; #closed = deferred(); #closing = null; #timer = null;
  #opening = false; #workPending = false; #controlsPending = false; #closeDone = false;
  #revoked = false; #finished = false; #succeeded = false; #clockBroken = false;
  #firstFailure = null; #cleanupError = null; #cleanupExpired = false; #utc = null;
  #captureResult = null; #controlsResult = null;
  #activation = null; #placement = null; #placementWork = null; #placementPending = false; #capturing = false;
  #auxiliaryPending = false;

  constructor(input, startup, ports, activated = null) {
    this.#startup = startup; this.#clock = ports.clock;
    this.#capture = createAcquisitionCaptureAttempt(input, { gate: {
      context: startup.context, check: this.#checkCaptureGate,
      appendIntent: event => startup.append(event), revoke: code => this.#fail(code),
    }, clock: this.#sample, ...ports.capture });
    // This timing is the capture's validated copy, not a second input access.
    this.#timing = this.#capture.timing;
    this.#origin = BigInt(this.#timing.t0MonotonicNs); this.#last = this.#origin;
    this.#deadline = this.#origin + BigInt(this.#timing.deadlineNs);
    this.#bounds = createExecBounds({ timing: this.#timing });
    if (activated) {
      this.#activation = createAcquisitionActivation(activated.activation, { gate: {
        context: startup.context, check: this.#checkGate, appendIntent: event => startup.append(event),
        revoke: code => this.#fail(code),
      }, request: ports.capture.request });
      this.#placement = createAcquisitionPlacement(activated.placement, { gate: {
        context: startup.context, observe: this.#observeGate, check: this.#checkGate, revoke: code => this.#fail(code),
      }, io: ports.placementIo });
      const capture = this.#capture.binding; const activation = this.#activation.binding; const placement = this.#placement.binding;
      requireAcquisition(capture.containerId === activation.containerId && capture.containerId === placement.containerId
        && isDeepStrictEqual(capture.socket, activation.socket)
        && activation.preparedContainerSha256 === placement.preparedContainerSha256
        && capture.launcherProfileSha256 === placement.launcherProfileSha256, "ACQ_ATTEMPT_INPUT");
    }
  }

  #sample = () => {
    try {
      const now = this.#bounds.observe(this.#clock()); this.#last = now; return now;
    } catch { this.#clockBroken = true; throw new AcquisitionRecordError("ACQ_ATTEMPT_CLOCK"); }
  };
  #time() {
    const now = this.#sample();
    requireAcquisition(now < this.#deadline, "ACQ_ATTEMPT_DEADLINE");
    return now;
  }
  #checkGate = () => {
    try {
      const now = this.#time();
      requireAcquisition(!this.#revoked && !this.#closing && this.#startup.snapshot().mayStart === true,
        "ACQ_ATTEMPT_GATE");
      // snapshot/clock are trusted callbacks, but cancellation can reenter here.
      requireAcquisition(!this.#revoked && !this.#closing, this.#firstFailure ?? "ACQ_ATTEMPT_GATE");
      return now;
    } catch (error) { this.#fail(codeOf(error)); throw new AcquisitionRecordError(this.#firstFailure); }
  };
  #observeGate = () => {
    requireAcquisition(!this.#revoked && !this.#closing, this.#firstFailure ?? "ACQ_ATTEMPT_STOPPED");
    const now = this.#time();
    requireAcquisition(!this.#revoked && !this.#closing, this.#firstFailure ?? "ACQ_ATTEMPT_STOPPED");
    return now;
  };
  #checkCaptureGate = () => {
    const now = this.#checkGate();
    if (this.#placement && !this.#placement.snapshot().mayExec) {
      this.#fail("ACQ_ATTEMPT_PLACEMENT"); throw new AcquisitionRecordError(this.#firstFailure);
    }
    return now;
  };
  #arm() { if (!this.#timer && !this.#finished) this.#timer = setInterval(this.#poll, this.#timing.pollMs); }
  #poll = () => {
    if (this.#finished) return;
    try {
      const now = this.#time();
      requireAcquisition(this.#closeUntil === null || now < this.#closeUntil, "ACQ_ATTEMPT_DEADLINE");
    } catch (error) {
      this.#cleanupExpired = true; this.#fail(codeOf(error)); this.#finishWait(); return;
    }
    if (this.#placement) {
      const p = this.#placement.poll();
      if (p.firstFailure) this.#fail(p.firstFailure);
      this.#monitorPlacement();
    }
    this.#progress();
  };

  #monitorPlacement() {
    if (!this.#placement || !this.#capturing || this.#placementPending || this.#revoked || this.#closing) return;
    const p = this.#placement.snapshot();
    const control = this.#capture.snapshot().control;
    if (p.executionObserved || !control?.observations.R) return;
    this.#placementPending = true;
    this.#placementWork = this.#placement.observeExecution(control.observations).then(result => {
      if (result.firstFailure) this.#fail(result.firstFailure);
    }, () => this.#fail("ACQ_ATTEMPT_PLACEMENT"))
      .finally(() => { this.#placementPending = false; this.#progress(); });
  }

  #fail(code) {
    this.#firstFailure ??= code;
    if (!this.#revoked) {
      this.#revoked = true;
      this.#capture.stop();
      this.#activation?.stop(); this.#placement?.stop();
      try { this.#startup.stop("supervisor", this.#clockBroken ? "clock" : /DEADLINE$/.test(code) ? "deadline" : "controller"); }
      catch { this.#cleanupError ??= "ACQ_ATTEMPT_CONTROLS"; }
    }
    this.#beginClose();
  }
  #beginClose() {
    if (this.#closing) return;
    this.#closeUntil = minimum(this.#deadline, this.#last + BigInt(this.#timing.closeWaitMs) * 1000000n);
    this.#controlsPending = true;
    this.#auxiliaryPending = this.#activation !== null;
    // Publish the promise before any borrowed finish callback can reenter.
    this.#closing = Promise.resolve().then(async () => {
      const controls = Promise.resolve().then(() => this.#startup.finish({ observedUtc: this.#utc ?? new Date().toISOString() }))
        .then(result => {
          this.#controlsResult = result;
          if (result?.finished !== true || result.firstFailure || result.process?.collection?.formatComplete !== true) {
            this.#cleanupError ??= "ACQ_ATTEMPT_CONTROLS";
            this.#firstFailure ??= "ACQ_ATTEMPT_CONTROLS";
          }
        }, () => { this.#cleanupError ??= "ACQ_ATTEMPT_CONTROLS"; this.#firstFailure ??= "ACQ_ATTEMPT_CONTROLS"; })
        .finally(() => { this.#controlsPending = false; });
      const auxiliary = this.#activation ? Promise.all([
        this.#activation.join(), this.#placement.close(),
      ]).then(() => {
        const p = this.#placement.snapshot(); const a = this.#activation.snapshot();
        if (p.cleanupError || p.io.ioClosed !== "closed" || a.cleanupError || !a.transportClosed) {
          this.#cleanupError ??= "ACQ_ATTEMPT_CLEANUP";
        }
      }).catch(() => { this.#cleanupError ??= "ACQ_ATTEMPT_CLEANUP"; })
        .finally(() => { this.#auxiliaryPending = false; }) : Promise.resolve();
      await Promise.all([this.#capture.join(), controls, auxiliary]);
    }).catch(() => { this.#cleanupError ??= "ACQ_ATTEMPT_CLEANUP"; })
      .finally(() => { this.#closeDone = true; this.#progress(); });
    this.#arm();
  }
  #progress() {
    if (this.#finished || !this.#closeDone || this.#opening || this.#workPending || this.#placementPending
      || this.#activation?.snapshot().workPending || this.#placement?.snapshot().pending) return;
    const capture = this.#capture.snapshot();
    if (capture.opening || capture.flowPending || capture.exec?.workPending) return;
    try {
      const now = this.#time();
      requireAcquisition(now < this.#closeUntil, "ACQ_ATTEMPT_DEADLINE");
    } catch (error) { this.#cleanupExpired = true; this.#fail(codeOf(error)); }
    this.#finishWait();
  }
  #finishWait() {
    if (this.#finished) return;
    this.#finished = true;
    this.#succeeded = this.#captureResult?.localComplete === true && this.#closeDone
      && (!this.#placement || this.#placement.snapshot().executionObserved)
      && !this.#firstFailure && !this.#cleanupError && !this.#cleanupExpired;
    if (this.#timer) clearInterval(this.#timer); this.#timer = null;
    const result = this.snapshot(); this.#openWait?.resolve(result); this.#runWait?.resolve(result); this.#closed.resolve(result);
  }

  open() {
    if (this.#openWait) return this.#openWait.promise;
    this.#openWait = deferred();
    if (this.#finished || this.#revoked) { this.#openWait.resolve(this.snapshot()); return this.#openWait.promise; }
    this.#opening = true; this.#arm();
    void Promise.resolve().then(async () => {
      this.#time();
      requireAcquisition(!this.#revoked, this.#firstFailure ?? "ACQ_ATTEMPT_STOPPED");
      const result = await this.#capture.open();
      if (!result.prepared || result.firstFailure) this.#fail(result.firstFailure ?? "ACQ_ATTEMPT_CAPTURE");
      if (this.#placement && !this.#revoked) {
        const p = await this.#placement.open();
        this.#observeGate();
        requireAcquisition(p.io.opened && !p.firstFailure, p.firstFailure ?? "ACQ_ATTEMPT_PLACEMENT");
      }
      this.#opening = false;
      if (!this.#revoked) this.#openWait.resolve(this.snapshot());
    }).catch(error => this.#fail(codeOf(error)))
      .finally(() => {
        this.#opening = false;
        // run can be waiting on this preparation. Its failure result must not
        // wait for the global join, which in turn waits for run to unwind.
        if (this.#revoked) this.#openWait.resolve(this.snapshot());
        this.#progress();
      });
    return this.#openWait.promise;
  }
  async #execute() {
    await this.open();
    requireAcquisition(!this.#revoked, this.#firstFailure ?? "ACQ_ATTEMPT_STOPPED");
    this.#time();
    requireAcquisition(!this.#revoked, this.#firstFailure ?? "ACQ_ATTEMPT_STOPPED");
    await this.#startup.start();
    this.#checkGate();
    if (this.#activation) {
      const before = await this.#placement.beforeStart(); this.#checkGate();
      requireAcquisition(before.io.beforeChecked && !before.firstFailure, before.firstFailure ?? "ACQ_ATTEMPT_PLACEMENT");
      const activation = await this.#activation.run(); this.#checkGate();
      requireAcquisition(activation.protocolComplete && !activation.workPending && !activation.firstFailure, "ACQ_ATTEMPT_ACTIVATION");
      const placed = await this.#placement.afterStart(); this.#checkGate();
      requireAcquisition(placed.mayExec, placed.firstFailure ?? "ACQ_ATTEMPT_PLACEMENT");
      this.#capturing = true;
    }
    this.#captureResult = await this.#capture.run();
    if (!this.#captureResult.localComplete) this.#fail(this.#captureResult.firstFailure ?? "ACQ_ATTEMPT_CAPTURE");
    if (this.#placement && !this.#revoked) {
      // At most two subject checks: existing work, then newly persisted S if needed.
      this.#monitorPlacement(); await this.#placementWork;
      this.#monitorPlacement(); await this.#placementWork;
      requireAcquisition(this.#placement.snapshot().executionObserved, "ACQ_ATTEMPT_PLACEMENT");
      this.#checkCaptureGate();
    }
    this.#capturing = false;
    // Capture's final permission check must precede normal finish's revocation.
  }
  run({ observedUtc }) {
    requireAcquisition(isAcquisitionUtc(observedUtc), "ACQ_ATTEMPT_INPUT");
    if (this.#runWait) return this.#runWait.promise;
    this.#runWait = deferred(); this.#utc = observedUtc;
    if (this.#finished) { this.#runWait.resolve(this.snapshot()); return this.#runWait.promise; }
    if (this.#revoked) { this.#closed.promise.then(this.#runWait.resolve); return this.#runWait.promise; }
    this.#workPending = true;
    void Promise.resolve().then(() => this.#execute()).catch(error => this.#fail(codeOf(error)))
      .finally(() => { this.#workPending = false; this.#beginClose(); this.#progress(); });
    return this.#runWait.promise;
  }
  stop() { if (!this.#finished) this.#fail("ACQ_ATTEMPT_STOPPED"); return this.snapshot(); }
  join() { return this.#closed.promise; }
  /** Explicit copied proc originals; passive snapshots never copy payload evidence. */
  collectPlacement() {
    requireAcquisition(this.#placement !== null, "ACQ_ATTEMPT_INPUT");
    return this.#placement.collect();
  }
  snapshot() {
    return Object.freeze({ operationId: this.#startup.context.operationId, opening: this.#opening,
      finished: this.#finished, localComplete: this.#finished && this.#succeeded && !this.#firstFailure && !this.#cleanupError,
      revoked: this.#revoked, closing: this.#closing !== null, firstFailure: this.#firstFailure, cleanupError: this.#cleanupError,
      cleanupWaitExpired: this.#cleanupExpired, workPending: this.#workPending, controlsClosePending: this.#controlsPending,
      lastAtNs: (this.#last - this.#origin).toString(), capture: this.#capture.snapshot(), captureResult: this.#captureResult,
      controls: this.#startup.snapshot(), controlsResult: this.#controlsResult,
      ...(this.#activation ? { activation: this.#activation.snapshot(), placement: this.#placement.snapshot(),
        placementPending: this.#placementPending, auxiliaryClosePending: this.#auxiliaryPending } : {}),
      otherInputSeparation: "unqualified", payloadOrigin: "unqualified", externalClosure: "unqualified",
      clockAdmission: "unqualified", releaseAdmission: "unqualified" });
  }
}

/** Inert local composition over an owned, unstarted startup and the closed capture input. */
export function createAcquisitionAttempt(input, ports) {
  const prepared = preparePorts(ports, false);
  return Object.freeze(new AcquisitionAttempt(input, prepared.startup, prepared));
}

/** Concrete activated composition; all native preparation and admission remain external. */
export function createActivatedAcquisitionAttempt(input, ports) {
  requireAcquisition(fields(input, ["capture", "activation", "placement"]), "ACQ_ATTEMPT_INPUT");
  const prepared = preparePorts(ports, true);
  return Object.freeze(new AcquisitionAttempt(input.capture, prepared.startup, prepared, input));
}

function preparePorts(ports, activated) {
  requireAcquisition(ports && Object.getPrototypeOf(ports) === Object.prototype
    && fields(ports, Object.keys(ports)) && Reflect.ownKeys(ports).every(key =>
    ["startup", "clock", "files", "fifo", "request", ...(activated ? ["placementIo"] : [])].includes(key)), "ACQ_ATTEMPT_INPUT");
  const s = ports.startup;
  requireAcquisition(s && ["start", "stop", "finish", "snapshot"].every(key => typeof s[key] === "function")
    && typeof s.supervisor?.append === "function" && (ports.clock === undefined || typeof ports.clock === "function"), "ACQ_ATTEMPT_INPUT");
  const startup = Object.freeze({ context: Object.freeze({ ...s.context }), start: s.start.bind(s), stop: s.stop.bind(s),
    finish: s.finish.bind(s), snapshot: s.snapshot.bind(s), append: s.supervisor.append.bind(s.supervisor) });
  const { startup: ignored, clock, ...capture } = ports;
  const placementIo = activated && Object.hasOwn(capture, "placementIo") ? capture.placementIo : undefined;
  if (activated) delete capture.placementIo;
  return { startup, clock: clock ?? (() => process.hrtime.bigint()), capture, placementIo };
}
