import { TabgradError } from "../../shared/errors.js";

const WEBASSEMBLY_PAGE_BYTES = 65_536;
export const MAXIMUM_ADDRESS = 0xffff_ffff;

export class CpuAllocation {
  released = false;
  constructor(
    readonly generation: number,
    readonly offset: number,
    readonly byteLength: number,
    readonly reservedByteLength: number,
  ) {}
}

interface FreeSegment {
  offset: number;
  byteLength: number;
}

export class LinearMemoryAllocator {
  readonly #memory: WebAssembly.Memory;
  readonly #maximumPages: number;
  readonly #alignment: number;
  #cursor: number;
  #freeSegments: FreeSegment[] = [];
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

  allocate(byteLength: number): CpuAllocation {
    const reservedByteLength = this.#align(byteLength);
    let offset: number | undefined;
    for (let index = 0; index < this.#freeSegments.length; index += 1) {
      const segment = this.#freeSegments[index];
      if (segment !== undefined && segment.byteLength >= reservedByteLength) {
        offset = segment.offset;
        if (segment.byteLength === reservedByteLength) {
          this.#freeSegments.splice(index, 1);
        } else {
          segment.offset += reservedByteLength;
          segment.byteLength -= reservedByteLength;
        }
        break;
      }
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
    return new CpuAllocation(this.#generation, offset, byteLength, reservedByteLength);
  }

  release(allocation: CpuAllocation): void {
    if (allocation.released) {
      return;
    }
    if (allocation.generation !== this.#generation) {
      throw new TabgradError(
        "BACKEND_STATUS_ERROR",
        "A WebAssembly allocation belongs to another backend generation.",
      );
    }
    allocation.released = true;
    this.#livePayloadBytes -= allocation.byteLength;
    this.#liveReservedBytes -= allocation.reservedByteLength;
    if (allocation.reservedByteLength > 0) {
      this.#freeSegments.push({
        offset: allocation.offset,
        byteLength: allocation.reservedByteLength,
      });
      this.#coalesceFreeSegments();
    }
  }

  #align(value: number): number {
    return Math.ceil(value / this.#alignment) * this.#alignment;
  }

  #ensureMemory(requiredBytes: number): void {
    if (requiredBytes <= this.#memory.buffer.byteLength) {
      return;
    }
    const requiredPages = Math.ceil(requiredBytes / WEBASSEMBLY_PAGE_BYTES);
    const currentPages = this.#memory.buffer.byteLength / WEBASSEMBLY_PAGE_BYTES;
    if (requiredPages > this.#maximumPages) {
      throw new TabgradError(
        "RESOURCE_EXHAUSTED",
        "The WebAssembly memory limit cannot satisfy this allocation.",
        { maximumPages: this.#maximumPages, requiredPages },
      );
    }
    try {
      this.#memory.grow(requiredPages - currentPages);
    } catch (error) {
      throw new TabgradError(
        "RESOURCE_EXHAUSTED",
        "The browser could not grow WebAssembly memory for this allocation.",
        { requiredPages },
        error,
      );
    }
  }

  #coalesceFreeSegments(): void {
    this.#freeSegments.sort((left, right) => left.offset - right.offset);
    const merged: FreeSegment[] = [];
    for (const segment of this.#freeSegments) {
      const previous = merged.at(-1);
      if (previous !== undefined && previous.offset + previous.byteLength === segment.offset) {
        previous.byteLength += segment.byteLength;
      } else {
        merged.push({ ...segment });
      }
    }
    this.#freeSegments = merged;
  }
}
