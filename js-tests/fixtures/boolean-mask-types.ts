import { createRuntimeSession } from "../../dist/index.js";

const session = createRuntimeSession();
const mask = session.tensor([true, false, 1], { dtype: "bool" });
const numericObservation: Promise<Float32Array> = mask.toArray();
const typedObservation: Promise<Float32Array | Uint8Array> = mask.toArray({ format: "typed" });
void numericObservation;
void typedObservation;

// @ts-expect-error Boolean input requires explicit bool selection.
session.tensor([true]);
// @ts-expect-error Floating constructors accept only numeric input.
session.tensor([true], { dtype: "float32" });
