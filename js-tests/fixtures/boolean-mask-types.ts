import { createRuntimeSession } from "../../dist/index.js";

const session = createRuntimeSession();
const mask = session.tensor([true, false, 1], { dtype: "bool" });
const numericObservation: Promise<Float32Array> = mask.toArray();
const typedObservation: Promise<Float32Array | Uint8Array | Int32Array | BigInt64Array> = mask.toArray({ format: "typed" });
const integers = session.tensor([2n ** 53n + 1n, 1], { dtype: "int64" });
void integers.argmax(null, true).toArray({ format: "typed" });
void numericObservation;
void typedObservation;

// @ts-expect-error Boolean input requires explicit bool selection.
session.tensor([true]);
// @ts-expect-error Floating constructors accept only numeric input.
session.tensor([true], { dtype: "float32" });
// @ts-expect-error BigInts require explicit signed integer dtype.
session.tensor([1n]);
// @ts-expect-error An axis is a Number, not a BigInt.
integers.argmax(0n);
