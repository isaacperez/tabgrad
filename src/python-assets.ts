import { TabgradError } from "./errors.js";

const SOURCE_PATHS = ["bootstrap.py", "torch/__init__.py"] as const;

interface SourceDescriptor {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

/** @internal Verified maintained Python source; loading does not touch Pyodide. */
export interface PythonSources {
  readonly bootstrap: string;
  readonly package: string;
}

function parseManifest(value: unknown): SourceDescriptor[] {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Python manifest.");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || manifest.bridgeVersion !== 1
    || manifest.pyodideVersion !== "314.0.6" || !Array.isArray(manifest.files)
    || manifest.files.length !== SOURCE_PATHS.length) {
    throw new Error("Incompatible Python artifact manifest.");
  }
  const files = manifest.files;
  return SOURCE_PATHS.map((path) => {
    const descriptor = files.find((entry: unknown) =>
      typeof entry === "object" && entry !== null && "path" in entry && entry.path === path);
    if (descriptor === undefined || !Number.isSafeInteger(descriptor.byteLength)
      || descriptor.byteLength < 0 || typeof descriptor.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(descriptor.sha256)) {
      throw new Error(`Invalid Python source descriptor: ${path}.`);
    }
    return descriptor as SourceDescriptor;
  });
}

async function fetchResponse(url: URL): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading Python source.`);
  return response;
}

async function readSource(descriptor: SourceDescriptor, manifestUrl: URL): Promise<string> {
  const response = await fetchResponse(new URL(descriptor.path, manifestUrl));
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== descriptor.byteLength) throw new Error("Python source size mismatch.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== descriptor.sha256) throw new Error("Python source hash mismatch.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** @internal No source is executed until the whole package has been verified. */
export async function loadPythonSources(manifestUrl: URL): Promise<PythonSources> {
  try {
    const response = await fetchResponse(manifestUrl);
    const descriptors = parseManifest(await response.json());
    const sources = await Promise.all(descriptors.map((entry) => readSource(entry, manifestUrl)));
    return { bootstrap: sources[0]!, package: sources[1]! };
  } catch (cause) {
    throw new TabgradError("PYTHON_ASSET_INVALID", "Python assets could not be validated.", {}, cause);
  }
}
