import { AcquisitionRecordError } from "./provenance-acquisition-record.mjs";

/** One owned request and response stream; cancellation never certifies either closed. */
export class AcquisitionHttpTransaction {
  #request = null; #stream = null; #response = false; #aborted = false; #requestClosed = false;
  #streamClosed = false; #ended = false; #cleanupError = null; #resolveClosed;
  #streamsPending = 0; #closureObserved = false;
  #disposed = new WeakSet();
  #httpCode; #cleanupCode; #statusCode = null; #recordStatus;
  #resolveResponse; #rejectResponse; #ready; #closed;

  // Fixed internal callers choose diagnostics. Exec keeps its prior property
  // reads; activation also retains the first status when a response is late.
  constructor(httpCode, cleanupCode, recordStatus = false) {
    this.#httpCode = httpCode; this.#cleanupCode = cleanupCode; this.#recordStatus = recordStatus;
    this.#ready = new Promise((resolve, reject) => { this.#resolveResponse = resolve; this.#rejectResponse = reject; });
    this.#closed = new Promise(resolve => { this.#resolveClosed = resolve; });
  }

  #join() {
    if (this.#requestClosed && (!this.#response || this.#streamClosed)) {
      this.#closureObserved = true; this.#resolveClosed();
    }
  }

  #reject = () => { this.#rejectResponse(new AcquisitionRecordError(this.#httpCode)); };

  #dispose(handle) {
    try {
      if (this.#disposed.has(handle)) return;
      this.#disposed.add(handle); handle.destroy();
    } catch { this.#cleanupError ??= this.#cleanupCode; }
  }

  #receive(response, stream, head, upgraded) {
    // Install ownership before rejecting even a late or unexpected response.
    const unexpected = this.#response || this.#aborted;
    if (this.#closureObserved) {
      this.#closureObserved = false;
      this.#closed = new Promise(resolve => { this.#resolveClosed = resolve; });
    }
    if (this.#recordStatus && !this.#response) {
      const status = response.statusCode;
      if (Number.isInteger(status) && status >= 100 && status <= 999) this.#statusCode = status;
    }
    this.#response = true; this.#streamClosed = false; this.#streamsPending++;
    stream.once("close", () => { this.#streamsPending--; this.#streamClosed = this.#streamsPending === 0; this.#join(); });
    stream.on("error", this.#reject);
    if (!this.#stream) {
      this.#stream = stream;
      stream.once("end", () => { this.#ended = true; });
    }
    stream.pause();
    if (unexpected) {
      this.#dispose(stream);
      this.#reject();
      return;
    }
    this.#resolveResponse({ response, stream, head, upgraded });
  }

  begin(options, body, request) {
    try {
      this.#request = request(options);
      this.#request.on("error", this.#reject);
      this.#request.once("close", () => { this.#requestClosed = true; this.#reject(); this.#join(); });
      this.#request.on("response", res => this.#receive(res, res, null, false));
      this.#request.on("upgrade", (res, socket, head) => this.#receive(res, socket, head, true));
      if (this.#aborted) this.#dispose(this.#request);
      else this.#request.end(body);
    } catch {
      this.#reject();
      if (!this.#request) { this.#requestClosed = true; this.#join(); }
      this.abort();
    }
    return this.#ready;
  }

  abort() {
    if (!this.#aborted) { this.#aborted = true; this.#reject(); }
    // A prior abort can precede factory return or listener-installation failure.
    // Revisit current ownership; disposal itself remains once per object.
    for (const handle of [this.#request, this.#stream]) if (handle) this.#dispose(handle);
  }

  get statusCode() { return this.#statusCode; }
  get ended() { return this.#ended; }
  get closed() { return this.#closed; }
  snapshot() { return Object.freeze({ responseObserved: this.#response, requestClosed: this.#requestClosed,
    streamEnded: this.#ended, streamClosed: this.#streamClosed, abortRequested: this.#aborted, cleanupError: this.#cleanupError }); }
}
