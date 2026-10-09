import { isRecord } from "../../shared/object-shape.js";

export const GPU_PROGRESS_FLAGS = 3;
export const GPU_PROGRESS_ACKNOWLEDGED = 1;
export const GPU_PROGRESS_PUBLISHING = 2;
const LEVELS = 11; // Eleven five-bit branches cover every safe integer identity.

export interface GpuProgressWord {
  readonly buffer: SharedArrayBuffer;
  readonly mask: number;
}
export type GpuProgressPath = readonly GpuProgressWord[];

/** Validate the cloned private wire shape before constructing atomic views. */
export function isGpuProgressPath(value: unknown): value is GpuProgressPath {
  if (!Array.isArray(value) || value.length !== LEVELS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const word: unknown = value[index];
    if (!isRecord(word) || !(word.buffer instanceof SharedArrayBuffer) || word.buffer.byteLength !== 4
      || typeof word.mask !== "number" || word.mask !== (word.mask | 0)) return false;
    const mask = word.mask >>> 0;
    if (mask === 0 || (mask & (mask - 1)) !== 0) return false;
  }
  return true;
}

/** Leaf-to-root publication, paired with clear-and-recheck on the consumer. */
export function markGpuProgress(path: GpuProgressPath): void {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const word = path[index]!;
    Atomics.or(new Int32Array(word.buffer), 0, word.mask);
  }
}

export function beginGpuPublication(buffer: SharedArrayBuffer, path: GpuProgressPath | undefined): void {
  if (path === undefined) return;
  Atomics.or(new Int32Array(buffer, 0, 4), GPU_PROGRESS_FLAGS, GPU_PROGRESS_PUBLISHING);
  markGpuProgress(path);
}

export function endGpuPublication(buffer: SharedArrayBuffer, path: GpuProgressPath | undefined): void {
  if (path === undefined) return;
  Atomics.and(new Int32Array(buffer, 0, 4), GPU_PROGRESS_FLAGS, ~GPU_PROGRESS_PUBLISHING);
  markGpuProgress(path);
}

interface Branch<T> {
  readonly word: Int32Array<SharedArrayBuffer>;
  readonly children: Map<number, Branch<T>>;
  readonly entries: Map<number, T>;
}
interface PathOwner<T> { readonly branch: Branch<T>; readonly slot: number }
interface Notification<T> { readonly path: GpuProgressPath; readonly owners: readonly PathOwner<T>[] }

function branch<T>(): Branch<T> {
  return { word: new Int32Array(new SharedArrayBuffer(4)), children: new Map(), entries: new Map() };
}

/** Sparse shared change directory. It owns live paths, never completed history. */
export class GpuProgressNotifications<T> {
  #root: Branch<T> | undefined;
  readonly #entries = new Map<T, Notification<T>>();

  get size(): number { return this.#entries.size; }

  add(value: T, id: number): GpuProgressPath {
    const created: PathOwner<T>[] = [];
    const hadRoot = this.#root !== undefined;
    try {
      this.#root ??= branch<T>();
      let current = this.#root;
      const owners: PathOwner<T>[] = [], path: GpuProgressWord[] = [];
      for (let depth = 0; depth < LEVELS; depth += 1) {
        const slot = Math.floor(id / 2 ** ((LEVELS - depth - 1) * 5)) % 32;
        owners.push({ branch: current, slot });
        path.push({ buffer: current.word.buffer, mask: 1 << slot });
        if (depth < LEVELS - 1) {
          let child = current.children.get(slot);
          if (child === undefined) {
            child = branch<T>();
            current.children.set(slot, child);
            created.push({ branch: current, slot });
          }
          current = child;
        }
      }
      current.entries.set(owners.at(-1)!.slot, value);
      this.#entries.set(value, { path, owners });
      return path;
    } catch (error) {
      for (let index = created.length - 1; index >= 0; index -= 1) {
        const owner = created[index]!;
        owner.branch.children.delete(owner.slot);
      }
      if (!hadRoot && this.#entries.size === 0) this.#root = undefined;
      throw error;
    }
  }

  delete(value: T): void {
    const entry = this.#entries.get(value);
    if (entry === undefined) return;
    this.#entries.delete(value);
    const leaf = entry.owners.at(-1)!;
    leaf.branch.entries.delete(leaf.slot);
    for (let index = entry.owners.length - 1; index > 0; index -= 1) {
      const child = entry.owners[index]!.branch;
      if (child.entries.size !== 0 || child.children.size !== 0) break;
      const parent = entry.owners[index - 1]!;
      parent.branch.children.delete(parent.slot);
    }
    // A later enrollment gets new words: a late old hint cannot name a new entry.
    if (this.#entries.size === 0) this.#root = undefined;
  }

  collect(notify: (value: T) => void): void {
    if (this.#root === undefined) return;
    const visited = new Set<T>();
    for (;;) {
      const before = visited.size;
      this.#walk(this.#root, 0, visited, notify);
      if (Atomics.load(this.#root.word, 0) === 0 || visited.size === before) return;
    }
  }

  #walk(current: Branch<T>, depth: number, visited: Set<T>, notify: (value: T) => void): void {
    let bits = Atomics.load(current.word, 0) >>> 0;
    while (bits !== 0) {
      const slot = 31 - Math.clz32(bits & -bits), mask = 1 << slot;
      bits = (bits & (bits - 1)) >>> 0;
      if (depth < LEVELS - 1) {
        const child = current.children.get(slot);
        if (child !== undefined) this.#walk(child, depth + 1, visited, notify);
        Atomics.and(current.word, 0, ~mask);
        if (child !== undefined && Atomics.load(child.word, 0) !== 0) Atomics.or(current.word, 0, mask);
      } else {
        if ((Atomics.and(current.word, 0, ~mask) & mask) === 0) continue;
        const value = current.entries.get(slot);
        if (value === undefined) continue;
        if (visited.has(value)) { markGpuProgress(this.#entries.get(value)!.path); continue; }
        visited.add(value);
        notify(value);
      }
    }
  }
}
