import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const interpreter = fileURLToPath(new URL(
  process.platform === "win32" ? "../.venv/Scripts/python.exe" : "../.venv/bin/python",
  import.meta.url,
));

// Pyright can exit successfully when its configured virtual environment is
// missing. Probe the prepared interpreter first; never fall back or install.
const environment = spawnSync(interpreter, [
  "-I", "-c",
  "import sys\n"
    + "if sys.version_info[:2] != (3, 11) or sys.prefix == sys.base_prefix:\n"
    + "    raise SystemExit('Expected a Python 3.11 virtual environment')\n"
    + "import yaml\n",
], { cwd: repositoryRoot, stdio: "inherit" });
if (environment.error || environment.status !== 0) {
  console.error("Python tooling is not prepared; follow docs/development.md.");
  if (environment.error) console.error(environment.error.message);
  process.exit(environment.status || 1);
}

const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("../node_modules/pyright/index.js", import.meta.url)),
  "--project", fileURLToPath(new URL("../pyrightconfig.json", import.meta.url)),
], { cwd: repositoryRoot, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
