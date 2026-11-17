import { TabgradError } from "../shared/errors.js";
import { isRecord } from "../shared/object-shape.js";
import { checkedElementBytes, tensorDType, type TensorDType } from "../shared/tensor-dtype.js";

/** An owned, bounded encoded span. Construction freezes metadata, not the bytes. */
export interface HostTensorPayload {
  readonly kind: "host";
  readonly dtype: TensorDType;
  readonly encoding: string;
  readonly elements: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Validate again after structured clone; object identity and freezing do not cross realms. */
export function assertTensorPayload(payload: unknown, dtype: TensorDType, elements: number): asserts payload is HostTensorPayload {
  const descriptor = tensorDType(dtype);
  const byteLength = checkedElementBytes(elements, descriptor.bytesPerElement);
  if (!isRecord(payload) || payload.kind !== "host" || payload.dtype !== dtype
    || payload.encoding !== descriptor.encoding || payload.elements !== elements
    || !(payload.bytes instanceof Uint8Array) || !(payload.bytes.buffer instanceof ArrayBuffer)
    || payload.bytes.byteLength !== byteLength || payload.bytes.byteOffset % descriptor.bytesPerElement !== 0) {
    throw new TabgradError("BACKEND_STATUS_ERROR", "Tensor payload does not match its encoded dtype and bounded extent.");
  }
  // Also reject detached empty buffers; byteLength alone cannot distinguish them.
  if (byteLength === 0) new Uint8Array(payload.bytes.buffer, payload.bytes.byteOffset, 0);
}

export function hostTensorPayload(dtype: TensorDType, elements: number, bytes: Uint8Array<ArrayBuffer>): HostTensorPayload {
  const payload: HostTensorPayload = { kind: "host", dtype, encoding: tensorDType(dtype).encoding, elements, bytes };
  assertTensorPayload(payload, dtype, elements);
  return Object.freeze(payload);
}

/** Wrap the existing import without an explicit clone or numeric conversion.
 * Exposing its buffer may materialize an engine's inline backing storage. */
export function float32TensorPayload(data: Float32Array<ArrayBuffer>): HostTensorPayload {
  return hostTensorPayload("float32", data.length, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

/** Copy exactly the bounded span at an ownership boundary, never its entire backing buffer. */
export function copyTensorPayload(payload: HostTensorPayload): HostTensorPayload {
  return hostTensorPayload(payload.dtype, payload.elements, payload.bytes.slice());
}

/** Numeric host observation is shared by JavaScript and Python, below their syntax. */
export function decodeTensorPayload(payload: HostTensorPayload, dtype: TensorDType, elements: number,
  result: "view" | "copy" = "view"): Float32Array<ArrayBuffer> {
  assertTensorPayload(payload, dtype, elements);
  const numeric = new Float32Array(payload.bytes.buffer, payload.bytes.byteOffset, elements);
  return result === "copy" ? numeric.slice() : numeric;
}
