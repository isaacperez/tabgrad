import { pathToFileURL } from "node:url";

// Finite local child only. Its files are ordinary harness-owned FDs, not qualified FIFOs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "binary") {
    process.stdout.write(Buffer.from([0, 255, 10, 124]));
    process.stderr.write(Buffer.from([128, 0, 13]));
  } else if (mode === "diagnostic") process.stdout.write("LAUNCH_FAILED\n");
  else if (mode === "one") { process.stdout.write("x"); process.stderr.write("y"); }
  else if (mode === "fail") process.exitCode = 7;
  else if (mode !== "empty") process.exitCode = 2;
}
