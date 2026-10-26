import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AcquisitionHttpTransaction } from "../../../scripts/provenance-acquisition-http-transaction.mjs";

for (const family of ["EXEC", "ACTIVATION"]) {
  test(`shared transaction preserves ${family} diagnostics and adopts requests returned after abort`, async () => {
    for (const registrationFailure of [false, true]) for (const failClose of [false, true]) {
      const tx = new AcquisitionHttpTransaction(`${family}_HTTP`, `${family}_CLEANUP`);
      let ends = 0; let destroys = 0;
      const req = new EventEmitter();
      req.end = () => { ends++; };
      req.destroy = () => { destroys++; if (failClose) throw Error("synthetic"); req.emit("close"); };
      if (registrationFailure) req.on("newListener", name => { if (name === "error") throw Error("synthetic listener"); });
      await assert.rejects(tx.begin({}, Buffer.alloc(0), () => { tx.abort(); return req; }), { code: `${family}_HTTP` });
      tx.abort(); tx.abort();
      assert.equal(ends, 0); assert.equal(destroys, 1);
      assert.equal(tx.snapshot().cleanupError, failClose ? `${family}_CLEANUP` : null);
      assert.equal(tx.snapshot().requestClosed, !registrationFailure && !failClose);
    }
  });
}

test("shared lifecycle does not inspect Exec status or impose a response policy", async () => {
  const tx = new AcquisitionHttpTransaction("EXEC_HTTP", "EXEC_CLEANUP");
  const req = new EventEmitter(); const res = new PassThrough();
  let reads = 0;
  Object.defineProperty(res, "statusCode", { get() { reads++; throw Error("protocol owns this property"); } });
  req.end = () => queueMicrotask(() => req.emit("response", res));
  req.destroy = () => req.emit("close");
  const ready = await tx.begin({}, Buffer.alloc(0), () => req);
  assert.equal(ready.response, res); assert.equal(reads, 0); assert.equal(tx.statusCode, null);
  tx.abort(); await tx.closed;
});

test("late response renews known closure and retains only the first status without rewriting prior snapshots", async () => {
  const tx = new AcquisitionHttpTransaction("ACTIVATION_HTTP", "ACTIVATION_CLEANUP", true);
  const req = new EventEmitter(); req.end = () => {}; req.destroy = () => req.emit("close");
  const ready = tx.begin({}, Buffer.alloc(0), () => req); tx.abort();
  await assert.rejects(ready, { code: "ACTIVATION_HTTP" }); await tx.closed;
  const before = tx.snapshot(); const joined = tx.closed;
  let closes = 0; const res = new PassThrough(); res.statusCode = 204; res.destroy = () => { closes++; return res; };
  req.emit("response", res);
  assert.equal(before.responseObserved, false); assert.equal(tx.snapshot().streamClosed, false);
  assert.notEqual(tx.closed, joined); assert.equal(closes, 1); assert.equal(tx.statusCode, 204);
  res.emit("close"); await tx.closed;
  assert.equal(tx.snapshot().streamClosed, true);
});

test("a failed request factory rejects with the caller code and has no known request to close", async () => {
  const tx = new AcquisitionHttpTransaction("ACTIVATION_HTTP", "ACTIVATION_CLEANUP", true);
  await assert.rejects(tx.begin({}, Buffer.alloc(0), () => { throw Error("private native text"); }), { code: "ACTIVATION_HTTP" });
  await tx.closed; assert.equal(tx.snapshot().requestClosed, true); assert.equal(tx.statusCode, null);
});
