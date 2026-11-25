import { TabgradError } from "../../shared/errors.js";
import { CPU_ABI_VERSION, CPU_CAPABILITY_MASK, CPU_REQUIRED_EXPORTS, type KernelExports } from "./kernel-catalogue.js";

function unsignedLeb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    const low = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? low : low | 0x80);
  } while (value !== 0);
  return bytes;
}

function wasmName(encoder: TextEncoder, name: string): number[] {
  const bytes = encoder.encode(name);
  return [...unsignedLeb128(bytes.length), ...bytes];
}

function section(id: number, contents: readonly number[]): number[] {
  return [id, ...unsignedLeb128(contents.length), ...contents];
}

/** Use Wasm linking to check parameters and result types without calling a kernel. */
function compileExportSignatureCheck(): WebAssembly.Module {
  const encoder = new TextEncoder();
  const arities = [...new Set(CPU_REQUIRED_EXPORTS.map(([, arity]) => arity))];
  const i32 = 0x7f;
  const types = [...unsignedLeb128(arities.length), ...arities.flatMap(arity => [
    0x60, ...unsignedLeb128(arity), ...new Array<number>(arity).fill(i32), 0x01, i32,
  ])];
  const imports = [...unsignedLeb128(CPU_REQUIRED_EXPORTS.length), ...CPU_REQUIRED_EXPORTS.flatMap(([name, arity]) => [
    ...wasmName(encoder, "kernels"), ...wasmName(encoder, name), 0x00, ...unsignedLeb128(arities.indexOf(arity)),
  ])];
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  return new WebAssembly.Module(Uint8Array.from([...header, ...section(1, types), ...section(2, imports)]));
}

let exportSignatureCheck: WebAssembly.Module | undefined;

export function assertCpuArtifactAbi(exports: WebAssembly.Exports): asserts exports is KernelExports {
  for (const [name] of CPU_REQUIRED_EXPORTS) {
    if (typeof exports[name] !== "function") {
      throw new TabgradError("BACKEND_ABI_MISMATCH", "The WebAssembly module is missing a required function export.", {
        exportName: name,
      });
    }
  }
  exportSignatureCheck ??= compileExportSignatureCheck();
  try { new WebAssembly.Instance(exportSignatureCheck, { kernels: exports }); }
  catch (error) {
    throw new TabgradError("BACKEND_ABI_MISMATCH", "The WebAssembly module has an incompatible function signature.", {
      backend: "webassembly-cpu", phase: "abi-validation",
    }, error);
  }
  const kernels = exports as KernelExports;
  const version = kernels.tabgrad_abi_version();
  if (version !== CPU_ABI_VERSION) {
    throw new TabgradError("BACKEND_ABI_MISMATCH", "The WebAssembly module ABI version is incompatible.", {
      actual: version, backend: "webassembly-cpu", expected: CPU_ABI_VERSION, phase: "abi-validation",
    });
  }
  if ((kernels.tabgrad_capabilities() & CPU_CAPABILITY_MASK) !== CPU_CAPABILITY_MASK) {
    throw new TabgradError("BACKEND_CAPABILITY_MISMATCH", "The WebAssembly module does not provide the required numerical capabilities.", {
      backend: "webassembly-cpu", phase: "abi-validation",
    });
  }
}
