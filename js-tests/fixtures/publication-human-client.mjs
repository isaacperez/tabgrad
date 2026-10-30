/** Controlled external effects around the actual human child implementation. */
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHumanClient } from "../../scripts/publication-human.mjs";
import { identifyPublicationClient } from "../../scripts/publication-client.mjs";
import { inspectBootstrapNamespace, prepareNpmRole } from "../../scripts/publication-npm.mjs";
import { npmCallReceipt } from "../../scripts/publication-effects.mjs";

const root = process.cwd();
const config = JSON.parse(await readFile(join(root, "fixture.json")));
const plan = JSON.parse(await readFile(join(root, "input/plan.json")));
const admission = JSON.parse(await readFile(join(root, "admission/admission.json")));
const trace = name => appendFile(join(root, "trace.txt"), `${name}\n`);
const result = () => ({ status: 0, dispatched: true, stdout: JSON.stringify({ [plan.candidate.name]: {
  name: plan.candidate.name, version: plan.candidate.version,
  integrity: `sha512-${Buffer.from(plan.candidate.archiveSha512, "hex").toString("base64")}` } }) });
const send = process.send.bind(process);
process.send = (message, callback) => {
  if (message.kind === "ready" && config.mode === "wrong-session") message = { ...message, session: "0".repeat(64) };
  const sent = send(message, callback);
  if (message.kind === "ready" && config.mode === "duplicate-ready") send(message, () => {});
  if (message.kind === "ready" && config.mode === "disconnect") process.disconnect();
  return sent;
};

process.once("message", async message => {
  try {
    assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
    assert.equal(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined); assert.equal(process.env.NODE_OPTIONS, undefined);
    await trace("closed-environment");
    if (config.mode === "early-receipt") {
      const receipt = npmCallReceipt(plan, admission.handoff, { manifestSha256: plan.publisher.clientSha256 }, result());
      receipt.status = "passed"; receipt.cleanup = "completed";
      send({ kind: "receipt", session: message.session, receipt }); process.disconnect(); return;
    }
    await runHumanClient(message, {
      identifyClient: async (...args) => {
        await trace("identify");
        if (config.mode === "changed-client") {
          const changed = await readFile(join(root, "client-changed"), "utf8").catch(error => {
            if (error.code !== "ENOENT") throw error; return "";
          });
          if (changed) throw Object.assign(new Error("synthetic client changed while waiting"), { code: "PUBLICATION_CLIENT_CHANGED" });
        }
        return config.actual ? identifyPublicationClient(...args) : { manifestSha256: plan.publisher.clientSha256 };
      },
      prepareRole: options => prepareNpmRole({ ...options, registry: config.registry ?? "http://127.0.0.1:9/",
        authentication: { kind: "fixture" } }),
      inspectNamespace: async options => {
        await trace("namespace-start");
        if (config.mode === "hang") await new Promise(() => {});
        const value = config.actual ? await inspectBootstrapNamespace(options) : { status: "passed" };
        await trace("namespace-complete"); return value;
      },
      publish: async options => {
        assert.equal(options.signal.aborted, false);
        await trace("publish");
        if (config.mode === "output-lost") throw Object.assign(new Error("synthetic response lost"),
          { code: "SYNTHETIC_RESPONSE_LOST", dispatched: true });
        return result();
      },
    });
  } catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
});
