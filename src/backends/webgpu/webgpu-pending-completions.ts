import { ActiveGpuAdmissions } from "./webgpu-active-admissions.js";
import { GPU_PROGRESS_ACKNOWLEDGED, GPU_PROGRESS_FLAGS, GPU_PROGRESS_PUBLISHING, GpuProgressNotifications, type GpuProgressPath } from "./webgpu-progress-notification.js";

interface PendingCompletion {
  readonly buffer: SharedArrayBuffer;
  isDrained(): boolean;
  refresh(): void;
}
interface AdmissionState {
  readonly id: number | undefined;
  changed: boolean;
}
export interface GpuDrainSubscription {
  readonly kind: "watch-drain";
  readonly requestId: number;
  readonly completion: SharedArrayBuffer;
  readonly progress: GpuProgressPath;
}

/** Owns transport obligations and selective inspection, independent of tensors. */
export class PendingGpuCompletions {
  readonly #live = new Map<PendingCompletion, AdmissionState>();
  readonly #unresolved = new Set<PendingCompletion>();
  readonly #arming = new Set<PendingCompletion>();
  readonly #fallback = new Set<PendingCompletion>();
  readonly #publishing = new Set<PendingCompletion>();
  readonly #checked = new Set<PendingCompletion>();
  readonly #subscribe: (subscription: GpuDrainSubscription) => void;
  #notifications: GpuProgressNotifications<PendingCompletion> | undefined;
  #ordered: ActiveGpuAdmissions<PendingCompletion> | undefined;
  #next = 0;
  #depth = 0;

  constructor(subscribe: (subscription: GpuDrainSubscription) => void) { this.#subscribe = subscribe; }

  add(completion: PendingCompletion): number | undefined {
    const id = this.#next < Number.MAX_SAFE_INTEGER ? this.#next++ : undefined;
    this.#live.set(completion, { id, changed: false });
    this.#unresolved.add(completion);
    if (id !== undefined) this.#ordered?.add(completion, id);
    return id;
  }

  failed(completion: PendingCompletion): void {
    const state = this.#live.get(completion);
    if (state === undefined) return;
    this.#unresolved.delete(completion);
    if (completion.isDrained()) return;
    if (state.id === undefined) { this.#fallback.add(completion); return; }
    try {
      this.#ensureOrdered();
      this.#notifications ??= new GpuProgressNotifications();
      const progress = this.#notifications.add(completion, state.id);
      this.#arming.add(completion);
      this.#ordered!.setActive(completion, true);
      this.#subscribe({ kind: "watch-drain", requestId: state.id, completion: completion.buffer, progress });
    } catch {
      // Optional notification cannot replace the cached operation failure.
      this.#notifications?.delete(completion);
      if (this.#notifications?.size === 0) this.#notifications = undefined;
      this.#arming.delete(completion);
      this.#fallback.add(completion);
      this.#ordered?.setActive(completion, true);
    }
  }

  delete(completion: PendingCompletion): void {
    this.#ordered?.delete(completion);
    this.#unresolved.delete(completion);
    this.#arming.delete(completion);
    this.#fallback.delete(completion);
    this.#publishing.delete(completion);
    this.#checked.delete(completion);
    this.#notifications?.delete(completion);
    if (this.#notifications?.size === 0) this.#notifications = undefined;
    this.#live.delete(completion);
  }

  /** Terminal control remains authoritative and forces the original ordered scan. */
  advance(terminal: boolean): void {
    if (this.#live.size === 0) return;
    if (terminal) {
      // Make unresolved obligations eligible before callbacks can reenter.
      for (const completion of this.#live.keys()) this.#ordered?.setActive(completion, true);
      for (const [completion, state] of this.#live) {
        state.changed = false;
        completion.refresh();
      }
      return;
    }
    if (this.#next === Number.MAX_SAFE_INTEGER || this.#ordered === undefined) {
      for (const completion of this.#live.keys()) completion.refresh();
      return;
    }
    this.#depth += 1;
    let cursor = -1;
    try {
      this.#notifications?.collect(this.#changed);
      for (let completion; (completion = this.#ordered.nextAfter(cursor)) !== undefined;) {
        const state = this.#live.get(completion)!;
        cursor = state.id!;
        const flags = Atomics.load(new Int32Array(completion.buffer, 0, 4), GPU_PROGRESS_FLAGS);
        if ((flags & GPU_PROGRESS_ACKNOWLEDGED) !== 0) this.#arming.delete(completion);
        // Clear only before refresh. A callback may finish a publication after
        // refresh saw old state but before the producer's final hint arrives.
        if ((flags & GPU_PROGRESS_PUBLISHING) === 0) this.#publishing.delete(completion);
        state.changed = false;
        this.#checked.add(completion);
        completion.refresh();
        if (this.#next === Number.MAX_SAFE_INTEGER) {
          for (const [pending, admission] of this.#live) {
            if (admission.id === undefined || admission.id > cursor) pending.refresh();
          }
          break;
        }
        this.#notifications?.collect(this.#changed);
      }
    } finally {
      this.#depth -= 1;
      if (this.#depth === 0) this.#finishCheckpoint();
    }
  }

  #ensureOrdered(): void {
    if (this.#ordered !== undefined) return;
    const ordered = new ActiveGpuAdmissions<PendingCompletion>();
    for (const [completion, state] of this.#live) if (state.id !== undefined) ordered.add(completion, state.id);
    this.#ordered = ordered;
  }

  readonly #changed = (completion: PendingCompletion): void => {
    const state = this.#live.get(completion);
    if (state === undefined) return;
    state.changed = true;
    const flags = Atomics.load(new Int32Array(completion.buffer, 0, 4), GPU_PROGRESS_FLAGS);
    if ((flags & GPU_PROGRESS_PUBLISHING) !== 0) this.#publishing.add(completion);
    else this.#publishing.delete(completion);
    this.#ordered!.setActive(completion, true);
  };

  #finishCheckpoint(): void {
    // All nested checkpoints share eligibility. No frame copies its ancestors.
    for (const completion of this.#checked) {
      const state = this.#live.get(completion);
      if (state === undefined) continue;
      this.#ordered!.setActive(completion, this.#unresolved.has(completion) || this.#arming.has(completion)
        || this.#fallback.has(completion) || this.#publishing.has(completion) || state.changed);
    }
    this.#checked.clear();
    if (this.#notifications === undefined && this.#arming.size === 0 && this.#fallback.size === 0 && this.#publishing.size === 0) {
      this.#ordered = undefined;
    }
  }
}
