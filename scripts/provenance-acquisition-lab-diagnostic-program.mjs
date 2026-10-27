import { requireAcquisition } from "./provenance-acquisition-record.mjs";
import { LAB_DIAGNOSTIC_CASES } from "./provenance-acquisition-lab-diagnostic-profile.mjs";
import { launchPath } from "./provenance-acquisition-launch-profile.mjs";

const stdout = Object.freeze([0, 65, 255, 10]);
const stderr = Object.freeze([254, 0, 66, 13]);

/** Literal sources and oracles. Intervals are declared observability inputs, never speed thresholds. */
export function labDiagnosticProgram(kind, nodePath, timing) {
  requireAcquisition(LAB_DIAGNOSTIC_CASES.includes(kind) && typeof nodePath === "string"
    && Number.isInteger(timing.holdMs) && timing.holdMs > 0 && timing.holdMs <= 2147483647
    && Number.isInteger(timing.descendantMs) && timing.descendantMs > 0 && timing.descendantMs <= 2147483647, "LAB_INPUT");
  launchPath(nodePath);
  const exit = kind === "B" ? 7 : 0;
  const descendant = kind === "C" ? `const child=spawn(process.execPath,["--input-type=module","--eval",${JSON.stringify(`setTimeout(()=>{},${timing.descendantMs});`)}],{stdio:["ignore",1,2],env:{},detached:false});child.on("error",()=>process.exit(1));child.unref();` : "";
  const source = `import{writeSync}from"node:fs";import{spawn}from"node:child_process";writeSync(1,Buffer.from([0,65,255,10]));writeSync(2,Buffer.from([254,0,66,13]));${descendant}setTimeout(()=>process.exit(${exit}),${timing.holdMs});`;
  return Object.freeze({ argv: Object.freeze([nodePath, "--input-type=module", "--eval", source]), env: Object.freeze([]),
    exitCode: exit, stdout, stderr, descendant: kind === "C" });
}
