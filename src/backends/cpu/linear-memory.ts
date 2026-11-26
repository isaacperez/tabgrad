import type { TensorDTypeDescriptor } from "../../shared/tensor-dtype.js";
import { TabgradError } from "../../shared/errors.js";
import { WEBASSEMBLY_PAGE_BYTES } from "./memory-capacity.js";
export const MAXIMUM_ADDRESS = 0xffff_ffff;

export class CpuAllocation {
  readonly #owner: object;
  readonly #format: TensorDTypeDescriptor | undefined;
  released = false;
  constructor(
    owner: object,
    readonly generation: number,
    readonly offset: number,
    readonly byteLength: number,
    readonly reservedByteLength: number,
    format?: TensorDTypeDescriptor,
  ) {
    this.#owner = owner;
    this.#format = format;
  }

  get format(): TensorDTypeDescriptor | undefined {
    return this.#format;
  }

  static belongsTo(allocation: object, owner: object): allocation is CpuAllocation {
    return #owner in allocation && allocation.#owner === owner;
  }
}

interface FreeSegment {
  offset: number;
  byteLength: number;
}

export class LinearMemoryAllocator {
  readonly #memory: WebAssembly.Memory;
  readonly #identity = Object.freeze({});
  readonly #maximumPages: number;
  readonly #alignment: number;
  #cursor: number;
  #freeSegments: FreeSegment[] = [];
  #freeSegmentByteBound = 0;
  #livePayloadBytes = 0;
  #highWaterPayloadBytes = 0;
  #liveReservedBytes = 0;
  #highWaterReservedBytes = 0;
  #generation: number;

  constructor(
    memory: WebAssembly.Memory,
    arenaBase: number,
    maximumPages: number,
    alignment: number,
    generation: number,
  ) {
    this.#memory = memory;
    this.#maximumPages = maximumPages;
    this.#alignment = alignment;
    this.#cursor = this.#align(arenaBase);
    this.#generation = generation;
  }

  get livePayloadBytes(): number {
    return this.#livePayloadBytes;
  }

  get highWaterPayloadBytes(): number {
    return this.#highWaterPayloadBytes;
  }

  get liveReservedBytes(): number {
    return this.#liveReservedBytes;
  }

  get highWaterReservedBytes(): number {
    return this.#highWaterReservedBytes;
  }

  allocate(byteLength: number, format?: TensorDTypeDescriptor): CpuAllocation {
    const reservedByteLength = this.#align(byteLength);
    let offset: number | undefined;
    if (reservedByteLength <= this.#freeSegmentByteBound) {
      let largest = 0;
      for (let index = 0; index < this.#freeSegments.length; index += 1) {
        const segment = this.#freeSegments[index]!;
        if (segment.byteLength >= reservedByteLength) {
          offset = segment.offset;
          if (segment.byteLength === reservedByteLength) {
            this.#freeSegments.splice(index, 1);
          } else {
            segment.offset += reservedByteLength;
            segment.byteLength -= reservedByteLength;
          }
          break;
        }
        largest = Math.max(largest, segment.byteLength);
      }
      // Removing or splitting a range can leave a conservative overestimate.
      // Tighten it during an unsuccessful search, without a second traversal.
      if (offset === undefined) this.#freeSegmentByteBound = largest;
    }

    if (offset === undefined) {
      offset = this.#cursor;
      const end = offset + reservedByteLength;
      if (!Number.isSafeInteger(end) || end > MAXIMUM_ADDRESS) {
        throw new TabgradError(
          "RESOURCE_EXHAUSTED",
          "The WebAssembly allocation exceeds the 32-bit address space.",
          { byteLength },
        );
      }
      this.#ensureMemory(end);
      this.#cursor = end;
    }

    this.#livePayloadBytes += byteLength;
    this.#liveReservedBytes += reservedByteLength;
    this.#highWaterPayloadBytes = Math.max(
      this.#highWaterPayloadBytes,
      this.#livePayloadBytes,
    );
    this.#highWaterReservedBytes = Math.max(
      this.#highWaterReservedBytes,
      this.#liveReservedBytes,
    );
    return new CpuAllocation(this.#identity, this.#generation, offset, byteLength, reservedByteLength, format);
  }

  /** Identity is allocator-local; generation numbers alone can coincide. */
  owns(allocation: object): allocation is CpuAllocation {
    return allocation instanceof CpuAllocation && CpuAllocation.belongsTo(allocation, this.#identity);
  }

  release(allocation: CpuAllocation): void {
    if (allocation.released) {
      return;
    }
    if (!this.owns(allocation) || allocation.generation !== this.#generation) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "A WebAssembly allocation belongs to another allocator or backend generation.",
      );
    }
    allocation.released = true;
    this.#livePayloadBytes -= allocation.byteLength;
    this.#liveReservedBytes -= allocation.reservedByteLength;
    if (allocation.reservedByteLength > 0) {
      this.#insertFreeSegment(allocation.offset, allocation.reservedByteLength);
    }
  }

  #align(value: number): number {
    return Math.ceil(value / this.#alignment) * this.#alignment;
  }

  #ensureMemory(requiredBytes: number): void {
    const maximumBytes = this.#maximumPages * WEBASSEMBLY_PAGE_BYTES;
    if (requiredBytes > maximumBytes) {
      throw new TabgradError(
        "RESOURCE_EXHAUSTED",
        "The WebAssembly memory limit cannot satisfy this allocation.",
        { capacityDomain: "cpu-linear-memory", phase: "allocation", maximumBytes, requiredBytes,
          maximumPages: this.#maximumPages, requiredPages: Math.ceil(requiredBytes / WEBASSEMBLY_PAGE_BYTES) },
      );
    }
    if (requiredBytes <= this.#memory.buffer.byteLength) {
      return;
    }
    const requiredPages = Math.ceil(requiredBytes / WEBASSEMBLY_PAGE_BYTES);
    const currentPages = this.#memory.buffer.byteLength / WEBASSEMBLY_PAGE_BYTES;
    try {
      this.#memory.grow(requiredPages - currentPages);
    } catch (error) {
      throw new TabgradError(
        "RESOURCE_EXHAUSTED",
        "The browser could not grow WebAssembly memory for this allocation.",
        { capacityDomain: "cpu-linear-memory", phase: "memory-growth", maximumBytes, requiredBytes,
          maximumPages: this.#maximumPages, requiredPages },
        error,
      );
    }
  }

  #insertFreeSegment(offset: number, byteLength: number): void {
    let index = this.#freeSegments.length;
    const last = this.#freeSegments.at(-1);
    // Address-ordered releases append without searching or shifting the list.
    if (last !== undefined && last.offset > offset) {
      let low = 0;
      let high = index;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (this.#freeSegments[middle]!.offset <= offset) low = middle + 1;
        else high = middle;
      }
      index = low;
    }
    const previous = this.#freeSegments[index - 1];
    const next = this.#freeSegments[index];
    let segment: FreeSegment;
    if (previous !== undefined && previous.offset + previous.byteLength === offset) {
      segment = previous;
      segment.byteLength += byteLength;
      if (next !== undefined && segment.offset + segment.byteLength === next.offset) {
        segment.byteLength += next.byteLength;
        this.#freeSegments.splice(index, 1);
      }
    } else if (next !== undefined && offset + byteLength === next.offset) {
      segment = next;
      segment.offset = offset;
      segment.byteLength += byteLength;
    } else {
      segment = { offset, byteLength };
      this.#freeSegments.splice(index, 0, segment);
    }
    this.#freeSegmentByteBound = Math.max(this.#freeSegmentByteBound, segment.byteLength);
  }
}
