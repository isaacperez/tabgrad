import assert from "node:assert/strict";
import test from "node:test";
import { buildContext } from "../scripts/ci-context.mjs";

test("manual preparation requires main, explicit enablement, a real origin and first-attempt context", () => {
  assert.doesNotThrow(() => buildContext({ TABGRAD_WEBSITE_MODE: "check" }));
  const env = { TABGRAD_WEBSITE_MODE: "publish", TABGRAD_WEBSITE_ENABLED: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40), TABGRAD_SITE_URL: "https://site.example.edu/", TABGRAD_WEBSITE_INITIAL: "false" };
  buildContext(env);
  for (const key of Object.keys(env)) assert.throws(() => buildContext({ ...env, [key]: undefined }), key);
  for (const [key, value] of [["GITHUB_EVENT_NAME", "pull_request"], ["GITHUB_REF", "refs/heads/other"], ["GITHUB_RUN_ATTEMPT", "2"], ["TABGRAD_SITE_URL", "https://example.invalid"]]) assert.throws(() => buildContext({ ...env, [key]: value }));
});
