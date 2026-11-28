import type { ComputationKind } from "../../execution/operation-contracts.js";

export const CPU_ABI_VERSION = 1;
export const CPU_MODULE_VERSION = 14;

interface Capability {
  readonly name: string;
  readonly bit: number;
}

interface KernelSymbol<Name extends string = string, Arity extends number = number> {
  readonly name: Name;
  readonly arity: Arity;
  readonly capability: Capability;
}

const ABI_ARITY = Object.freeze({ pointwise: 4, broadcast: 5, ternaryPointwise: 5, ternaryBroadcast: 6, inputLength: 3, outputLength: 3,
  coefficient: 5, matrix: 7, receiving: 4 } as const);
type PointwiseLayout = "pointwise" | "ternaryPointwise";
type SingleLayout = Exclude<keyof typeof ABI_ARITY, PointwiseLayout | "broadcast" | "ternaryBroadcast">;

export type CpuKernelDeclaration =
  | { readonly layout: PointwiseLayout; readonly dense: KernelSymbol; readonly broadcast: KernelSymbol }
  | { readonly layout: SingleLayout; readonly symbol: KernelSymbol };

function capability(name: string, bit: number): Capability { return Object.freeze({ name, bit }); }

function symbol<Name extends string, Layout extends keyof typeof ABI_ARITY>(name: Name, layout: Layout, capability: Capability)
  : KernelSymbol<Name, (typeof ABI_ARITY)[Layout]> {
  return Object.freeze({ name, arity: ABI_ARITY[layout], capability });
}

function pointwise<Dense extends string, Broadcast extends string>(denseName: Dense, denseCapability: Capability,
  broadcastName: Broadcast, broadcastCapability: Capability) {
  return Object.freeze({ layout: "pointwise" as const, dense: symbol(denseName, "pointwise", denseCapability),
    broadcast: symbol(broadcastName, "broadcast", broadcastCapability) });
}

function kernel<Layout extends SingleLayout, Name extends string>(layout: Layout, name: Name, required: Capability) {
  return Object.freeze({ layout, symbol: symbol(name, layout, required) });
}

const BROADCAST_FLOAT32 = capability("broadcast-f32", 64);
const POINTWISE_FLOAT16 = capability("pointwise-f16", 256);
const POINTWISE_BFLOAT16 = capability("pointwise-bf16", 2048);
const POINTWISE_GT = capability("gt-f32", 16384);
const POINTWISE_WHERE = capability("where-f32", 32768);

// Every CPU specialization declares its external symbols and calling layout here.
const declarations = Object.freeze({
  "add-f32": pointwise("tabgrad_add_f32", capability("add-f32", 1), "tabgrad_broadcast_add_f32", BROADCAST_FLOAT32),
  "add-alpha-f32": kernel("coefficient", "tabgrad_add_alpha_f32", capability("add-alpha-f32", 16)),
  "mul-f32": pointwise("tabgrad_mul_f32", capability("mul-f32", 4), "tabgrad_broadcast_mul_f32", BROADCAST_FLOAT32),
  "sum-f32": kernel("inputLength", "tabgrad_sum_f32", capability("sum-f32", 2)),
  "expand-f32": kernel("outputLength", "tabgrad_expand_f32", capability("expand-f32", 8)),
  "matmul-f32": kernel("matrix", "tabgrad_matmul_f32", capability("matmul-f32", 32)),
  "reduce-f32": kernel("receiving", "tabgrad_receive_f32", capability("reduce-f32", 128)),
  "add-f16": pointwise("tabgrad_add_f16", POINTWISE_FLOAT16, "tabgrad_broadcast_add_f16", POINTWISE_FLOAT16),
  "mul-f16": pointwise("tabgrad_mul_f16", POINTWISE_FLOAT16, "tabgrad_broadcast_mul_f16", POINTWISE_FLOAT16),
  "sum-f16": kernel("inputLength", "tabgrad_sum_f16", capability("sum-f16", 512)),
  "matmul-f16": kernel("matrix", "tabgrad_matmul_f16", capability("matmul-f16", 1024)),
  "add-bf16": pointwise("tabgrad_add_bf16", POINTWISE_BFLOAT16, "tabgrad_broadcast_add_bf16", POINTWISE_BFLOAT16),
  "mul-bf16": pointwise("tabgrad_mul_bf16", POINTWISE_BFLOAT16, "tabgrad_broadcast_mul_bf16", POINTWISE_BFLOAT16),
  "gt-f32": pointwise("tabgrad_gt_f32", POINTWISE_GT, "tabgrad_broadcast_gt_f32", POINTWISE_GT),
  "where-f32": Object.freeze({ layout: "ternaryPointwise", dense: symbol("tabgrad_where_f32", "ternaryPointwise", POINTWISE_WHERE),
    broadcast: symbol("tabgrad_broadcast_where_f32", "ternaryBroadcast", POINTWISE_WHERE) }),
  "where-then-gradient-f32": pointwise("tabgrad_where_then_gradient_f32", POINTWISE_WHERE,
    "tabgrad_broadcast_where_then_gradient_f32", POINTWISE_WHERE),
  "where-else-gradient-f32": pointwise("tabgrad_where_else_gradient_f32", POINTWISE_WHERE,
    "tabgrad_broadcast_where_else_gradient_f32", POINTWISE_WHERE),
  "sum-bf16": kernel("inputLength", "tabgrad_sum_bf16", capability("sum-bf16", 4096)),
  "matmul-bf16": kernel("matrix", "tabgrad_matmul_bf16", capability("matmul-bf16", 8192)),
} satisfies Partial<Record<ComputationKind, CpuKernelDeclaration>>);

export const CPU_COMPUTATIONS: readonly (keyof typeof declarations)[] = Object.freeze(
  Object.keys(declarations) as (keyof typeof declarations)[],
);

type RegisteredKernel = (typeof declarations)[keyof typeof declarations];
const catalogue: Readonly<Partial<Record<ComputationKind, RegisteredKernel>>> = declarations;

export function cpuKernel(kind: ComputationKind): RegisteredKernel | undefined {
  return catalogue[kind];
}

const kernelSymbols: KernelSymbol[] = [];
for (const declaration of Object.values(declarations)) {
  if ("dense" in declaration) kernelSymbols.push(declaration.dense, declaration.broadcast);
  else kernelSymbols.push(declaration.symbol);
}
// Capability bits define a stable order across module profiles.
kernelSymbols.sort((left, right) => left.capability.bit - right.capability.bit || left.arity - right.arity);

const capabilityBits = new Map<string, number>();
const namesByBit = new Map<number, string>();
const bootstrapExports = [
  ["tabgrad_abi_version", 0], ["tabgrad_capabilities", 0], ["tabgrad_arena_base", 0],
] as const;
type Symbols<Declaration> = Declaration extends { symbol: infer Symbol } ? Symbol
  : Declaration extends { dense: infer Dense; broadcast: infer Broadcast } ? Dense | Broadcast : never;
type RequiredSymbol = Symbols<RegisteredKernel> | { name: (typeof bootstrapExports)[number][0]; arity: 0 };
type WasmArguments<Arity extends number, Parameters extends number[] = []> = Parameters["length"] extends Arity
  ? Parameters : WasmArguments<Arity, [...Parameters, number]>;
export type KernelExports = WebAssembly.Exports & {
  readonly [Symbol in RequiredSymbol as Symbol["name"]]: (...parameters: WasmArguments<Symbol["arity"]>) => number;
};

const exportArities = new Map<string, number>(bootstrapExports);
let requiredMask = 0;
for (const { name, arity, capability: { name: capabilityName, bit } } of kernelSymbols) {
  if (exportArities.has(name)) throw new TypeError(`Duplicate CPU kernel export ${name}.`);
  if (!Number.isInteger(bit) || bit < 1 || bit > 0x8000_0000 || (bit & (bit - 1)) !== 0
    || (capabilityBits.has(capabilityName) && capabilityBits.get(capabilityName) !== bit)
    || (namesByBit.has(bit) && namesByBit.get(bit) !== capabilityName)) {
    throw new TypeError(`Invalid CPU kernel capability ${capabilityName}.`);
  }
  exportArities.set(name, arity);
  capabilityBits.set(capabilityName, bit);
  namesByBit.set(bit, capabilityName);
  requiredMask |= bit;
}

export const CPU_CAPABILITIES = Object.freeze([...capabilityBits.keys()]);
export const CPU_CAPABILITY_MASK = requiredMask;
export const CPU_REQUIRED_EXPORTS = Object.freeze([...exportArities].map(entry => Object.freeze(entry)));
