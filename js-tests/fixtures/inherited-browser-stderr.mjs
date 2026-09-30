// A finite test-owned writer models inherited stderr without launching an updater.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runBrowserPage, startBrowserServer } from "../../scripts/browser-harness.mjs";

const fixture = fileURLToPath(import.meta.url);
const [mode, ...arguments_] = process.argv.slice(2);

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function joinWriter(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) return;
    await delay(20);
  }
  throw new Error("Test-owned stderr writer did not exit after its gate closed.");
}

async function runWriter(port, token) {
  const connection = createConnection({ host: "127.0.0.1", port: Number(port) });
  // The failsafe also bounds this writer if the runner itself crashes.
  const deadline = setTimeout(() => process.exit(2), 10_000);
  connection.once("connect", () => {
    connection.write(JSON.stringify({ token, pid: process.pid }) + "\n");
    process.send({ ready: true });
  });
  connection.once("end", () => { clearTimeout(deadline); connection.end(); });
  connection.once("error", () => process.exit(3));
}

async function runBrowser(port, token, pageUrl, scenario) {
  const writer = spawn(process.execPath, [fixture, "writer", port, token], {
    stdio: ["ignore", "ignore", 2, "ipc"],
  });
  await new Promise((resolve, reject) => {
    writer.once("message", resolve);
    writer.once("error", reject);
  });
  writer.disconnect();
  await new Promise((resolve) => process.stderr.write("inherited stderr fixture\n", resolve));
  await fetch(pageUrl);
  const url = new URL("/__result", pageUrl);
  url.searchParams.set("token", new URL(pageUrl).searchParams.get("token"));
  await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: scenario === "success" }),
  });
  setInterval(() => {}, 1_000);
}

async function runHarness(scenario) {
  const token = randomUUID();
  let writer;
  let writerPid;
  let profile;
  const gate = createServer((connection) => {
    let message = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      message += chunk;
      if (!message.endsWith("\n")) return;
      const record = JSON.parse(message);
      assert.equal(record.token, token);
      assert(Number.isInteger(record.pid));
      writer = connection;
      writerPid = record.pid;
    });
  });
  await new Promise((resolve) => gate.listen(0, "127.0.0.1", resolve));
  const server = await startBrowserServer(["runtime.html"]);
  let outcome;
  try {
    const result = await runBrowserPage({
      server, executable: process.execPath, page: "runtime.html", version: process.version,
      browser: {
        name: "InheritedStderrBrowser",
        argumentsFor(directory, url) {
          profile = directory;
          return [fixture, "browser", String(gate.address().port), token, url, scenario];
        },
      },
      validateResult(result) { assert.equal(result.ok, true, "controlled application failure"); },
    });
    outcome = { result };
  } catch (error) {
    outcome = { failureKind: error.diagnostics?.failureKind, diagnostics: error.diagnostics };
  } finally {
    outcome.writerStillAlive = processExists(writerPid);
    try { await access(profile); outcome.profileRemoved = false; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      outcome.profileRemoved = true;
    }
    writer.end();
    await joinWriter(writerPid);
    outcome.writerJoined = true;
    await new Promise((resolve, reject) => gate.close((error) => error ? reject(error) : resolve()));
    await server.close();
  }
  // Do not emit ephemeral paths or the gate/run tokens in fixture output.
  if (outcome.diagnostics !== undefined) {
    const { failureKind, process: processState, terminationFailure, standardErrorClosedEarly,
      standardError, standardErrorTruncated } = outcome.diagnostics;
    outcome.diagnostics = { failureKind, process: processState, terminationFailure,
      standardErrorClosedEarly, standardError, standardErrorTruncated };
  }
  process.stdout.write(`OUTCOME ${JSON.stringify(outcome)}\n`);
}

if (mode === "writer") await runWriter(...arguments_);
else if (mode === "browser") await runBrowser(...arguments_);
else if (mode === "harness") await runHarness(...arguments_);
else throw new Error("Unknown inherited-stderr fixture mode.");
