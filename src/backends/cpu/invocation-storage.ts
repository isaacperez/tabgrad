import type { ProgramBinding } from "../../execution/backend.js";
import type { ExecutableProgram, ProgramSlot } from "../../execution/executable-program.js";
import type { CpuAllocation, LinearMemoryAllocator } from "./linear-memory.js";

/**
 * Invocation-local ownership and remaining physical uses for the sequential
 * CPU schedule. Borrowed bindings never become scratch, even without an
 * external semantic owner. Only active allocations participate in rollback.
 */
export class InvocationStorage {
  readonly allocations = new Map<ProgramSlot, CpuAllocation>();
  readonly #allocator: LinearMemoryAllocator;
  readonly #bindings: ReadonlyMap<ProgramSlot, ProgramBinding>;
  readonly #remainingUses: number[];

  constructor(
    allocator: LinearMemoryAllocator,
    program: ExecutableProgram,
    bindings: ReadonlyMap<ProgramSlot, ProgramBinding>,
    retainedSlots: readonly boolean[],
  ) {
    this.#allocator = allocator;
    this.#bindings = bindings;
    // A negative count protects retained or borrowed values from reclamation.
    this.#remainingUses = new Array<number>(program.values.length);
    for (let slot = 0; slot < program.values.length; slot += 1) {
      this.#remainingUses[slot] = retainedSlots[slot] || bindings.get(slot)?.resident !== undefined
        ? -1
        : program.storageUseCounts[slot]!;
    }
  }

  completeInputUse(slot: ProgramSlot): void {
    const remaining = this.#remainingUses[slot]!;
    if (remaining <= 0) return;
    this.#remainingUses[slot] = remaining - 1;
    if (remaining === 1) {
      const allocation = this.allocations.get(slot)!;
      this.#allocator.release(allocation);
      this.allocations.delete(slot);
    }
  }

  rollback(): void {
    for (const [slot, allocation] of this.allocations) {
      if (allocation !== this.#bindings.get(slot)?.resident) {
        this.#allocator.release(allocation);
      }
    }
  }
}
