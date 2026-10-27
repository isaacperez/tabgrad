import { AcquisitionRecordError, requireAcquisition } from "./provenance-acquisition-record.mjs";

/** Detect duplicate decoded keys before JSON.parse can erase them. Caller bounds received bytes. */
function uniqueJsonKeys(source, code) {
  const stack = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const begin = i;
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === "\\") i++;
      requireAcquisition(i < source.length, code);
      let next = i + 1;
      while (/\s/.test(source[next] ?? "") && next < source.length) next++;
      if (source[next] === ":") {
        const key = JSON.parse(source.slice(begin, i + 1)); const keys = stack.at(-1);
        requireAcquisition(keys instanceof Set && !keys.has(key), code); keys.add(key);
      }
    }
  }
}

/** Shared metadata grammar; each concrete caller retains its original diagnostic family. */
export function parseAcquisitionJson(bytes, code) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    uniqueJsonKeys(source, code); return JSON.parse(source);
  } catch { throw new AcquisitionRecordError(code); }
}
