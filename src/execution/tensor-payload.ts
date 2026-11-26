import { TabgradError } from "../shared/errors.js";
import { isRecord } from "../shared/object-shape.js";
import { checkedElementBytes, invalidTensorData, tensorDType, type TensorDType, type TensorDTypeDescriptor } from "../shared/tensor-dtype.js";

/** An owned, bounded encoded span. Construction freezes metadata, not the bytes. */
export interface HostTensorPayload {
  readonly kind: "host";
  readonly dtype: TensorDType;
  readonly encoding: string;
  readonly elements: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Format belongs to the live tensor identity. Its logical bytes exclude physical padding. */
export function assertResidentTensor(format: TensorDTypeDescriptor | undefined, byteLength: number,
  dtype: TensorDType, elements: number): void {
  const expected = tensorDType(dtype);
  if (format !== expected || byteLength !== checkedElementBytes(elements, expected.bytesPerElement)) {
    throw new TabgradError("BACKEND_STATUS_ERROR", "Resident tensor format or extent does not match.");
  }
}

/** Validate again after structured clone; object identity and freezing do not cross realms. */
export function assertTensorPayload(payload: unknown, dtype: TensorDType, elements: number): asserts payload is HostTensorPayload {
  assertEncodedSpan(payload, tensorDType(dtype), elements);
}

function assertEncodedSpan(payload: unknown, descriptor: TensorDTypeDescriptor, elements: number): asserts payload is HostTensorPayload {
  const byteLength = checkedElementBytes(elements, descriptor.bytesPerElement);
  if (!isRecord(payload) || payload.kind !== "host" || payload.dtype !== descriptor.name
    || payload.encoding !== descriptor.encoding || payload.elements !== elements
    || !(payload.bytes instanceof Uint8Array) || !(payload.bytes.buffer instanceof ArrayBuffer)
    || payload.bytes.byteLength !== byteLength || payload.bytes.byteOffset % descriptor.bytesPerElement !== 0) {
    throw new TabgradError("BACKEND_STATUS_ERROR", "Tensor payload does not match its encoded dtype and bounded extent.");
  }
  // Also reject detached empty buffers; byteLength alone cannot distinguish them.
  if (byteLength === 0) new Uint8Array(payload.bytes.buffer, payload.bytes.byteOffset, 0);
}

export function hostTensorPayload(dtype: TensorDType, elements: number, bytes: Uint8Array<ArrayBuffer>): HostTensorPayload {
  return encodedSpan(tensorDType(dtype), elements, bytes);
}

function encodedSpan(descriptor: TensorDTypeDescriptor, elements: number, bytes: Uint8Array<ArrayBuffer>): HostTensorPayload {
  const payload: HostTensorPayload = { kind: "host", dtype: descriptor.name, encoding: descriptor.encoding, elements, bytes };
  assertEncodedSpan(payload, descriptor, elements);
  return Object.freeze(payload);
}

/** Capture one owned span before caller-owned input can change. */
export function captureTensorData(data: Iterable<number> | ArrayLike<number>, dtype: TensorDType): HostTensorPayload {
  const descriptor = tensorDType(dtype);
  try {
    if (typeof data !== "object" || data === null) throw invalidTensorData();
    const iterator = (data as Partial<Iterable<number>>)[Symbol.iterator];
    if (iterator === undefined) {
      const length = (data as Partial<ArrayLike<number>>).length;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) throw invalidTensorData();
    } else if (typeof iterator !== "function") {
      throw invalidTensorData();
    }
    const values = descriptor.capture(data);
    return encodedSpan(descriptor, values.length, new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  } catch (error) {
    if (error instanceof TabgradError) throw error;
    throw invalidTensorData(error);
  }
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
  const descriptor = tensorDType(dtype);
  assertEncodedSpan(payload, descriptor, elements);
  return descriptor.observe(payload.bytes, elements, result === "copy");
}
