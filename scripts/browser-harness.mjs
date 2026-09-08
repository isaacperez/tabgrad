import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = normalize(fileURLToPath(new URL("..", import.meta.url)));
const distributionRoot = join(repositoryRoot, "dist");
const browserTestRoot = join(repositoryRoot, "js-tests", "browser");

const maxRecordedRequests = 64;
const maxStandardErrorCharacters = 16_384;
const reportedPhaseOrder = Object.freeze([
  "application-started",
  "assets-loaded",
  "runtime-started",
  "runtime-finished",
]);
const requiredAssetExtensions = new Set([".html", ".js", ".json", ".wasm"]);

export const defaultNavigationTimeoutMilliseconds = 60_000;
export const defaultApplicationTimeoutMilliseconds = 30_000;

export const browserDefinitions = Object.freeze([
  {
    name: "Chrome",
    environmentVariable: "TABGRAD_CHROME",
    candidates: process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"],
    argumentsFor(profile, url) {
      return [
        "--headless=new",
        "--no-first-run",
        "--disable-background-networking",
        `--user-data-dir=${profile}`,
        url,
      ];
    },
  },
  {
    name: "Firefox",
    environmentVariable: "TABGRAD_FIREFOX",
    candidates: process.platform === "darwin"
      ? ["/Applications/Firefox.app/Contents/MacOS/firefox"]
      : ["/usr/bin/firefox"],
    argumentsFor(profile, url) {
      return ["--headless", "--no-remote", "--profile", profile, url];
    },
  },
]);

class ClassifiedBrowserFailure extends Error {
  constructor(kind, message, options = undefined) {
    super(message, options);
    this.name = "ClassifiedBrowserFailure";
    this.kind = kind;
  }
}

export class BrowserRunError extends Error {
  constructor(message, diagnostics, options = undefined) {
    super(`${message}\nBrowser run diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`, options);
    this.name = "BrowserRunError";
    this.diagnostics = diagnostics;
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function roundedElapsedMilliseconds(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function isRequiredAsset(pathname) {
  return requiredAssetExtensions.has(extname(pathname));
}

function classifyFailure(error, fallbackKind) {
  if (error instanceof ClassifiedBrowserFailure) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ClassifiedBrowserFailure(fallbackKind, message, { cause: error });
}

function requestToken(requestUrl, activeToken, runs) {
  const explicitToken = requestUrl.searchParams.get("token");
  if (explicitToken !== null) {
    return runs.has(explicitToken) ? explicitToken : undefined;
  }
  return activeToken;
}

function recordRequest(run, request, pathname, status) {
  if (run === undefined) {
    return;
  }
  if (run.requests.length >= maxRecordedRequests) {
    run.requestsTruncated = true;
    return;
  }
  run.requests.push({
    elapsedMilliseconds: roundedElapsedMilliseconds(run.startedAt),
    method: request.method,
    path: pathname,
    status,
  });
}

function markPhase(run, phase) {
  if (run === undefined) {
    return;
  }
  run.lastPhase = phase;
  run.phases.push({
    elapsedMilliseconds: roundedElapsedMilliseconds(run.startedAt),
    phase,
  });
}

function rejectRun(run, kind, message) {
  if (run === undefined) {
    return;
  }
  const failure = new ClassifiedBrowserFailure(kind, message);
  run.navigation.reject(failure);
  run.result.reject(failure);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function contentTypeFor(path) {
  const extension = extname(path);
  if (extension === ".wasm") {
    return "application/wasm";
  }
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  return "text/javascript; charset=utf-8";
}

export async function resolveBrowser(definition) {
  const configured = process.env[definition.environmentVariable];
  const candidates = configured === undefined ? definition.candidates : [configured];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next documented candidate.
    }
  }
  throw new Error(
    `${definition.name} was not found. Set ${definition.environmentVariable} to its executable.`,
  );
}

export function selectBrowserDefinitions(requestedBrowser, definitions = browserDefinitions) {
  if (requestedBrowser === undefined || requestedBrowser === "") {
    return definitions;
  }
  const selected = definitions.filter(
    (definition) => definition.name.toLowerCase() === requestedBrowser.toLowerCase(),
  );
  if (selected.length !== 1) {
    const supported = definitions.map((definition) => definition.name).join(", ");
    throw new Error(
      `Unsupported TABGRAD_BROWSER value ${JSON.stringify(requestedBrowser)}. `
      + `Choose one of: ${supported}.`,
    );
  }
  return selected;
}

export function browserVersion(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Could not read browser version from ${executable}.`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

export async function startBrowserServer(
  pageNames,
  { crossOriginIsolation = false } = {},
) {
  const runs = new Map();
  const allowedPages = new Set(pageNames);
  let activeToken;
  const isolationHeaders = crossOriginIsolation
    ? {
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
      }
    : {};
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    const token = requestToken(requestUrl, activeToken, runs);
    const run = token === undefined ? undefined : runs.get(token);
    const pathname = requestUrl.pathname;

    if (pathname === "/__phase" && request.method === "POST") {
      if (run === undefined) {
        response.writeHead(404).end();
        return;
      }
      try {
        const phase = JSON.parse(await readRequestBody(request)).phase;
        const previousIndex = reportedPhaseOrder.indexOf(run.lastPhase);
        const nextIndex = reportedPhaseOrder.indexOf(phase);
        if (nextIndex < 0 || nextIndex <= previousIndex) {
          throw new Error(`Invalid browser lifecycle phase ${JSON.stringify(phase)}.`);
        }
        markPhase(run, phase);
        recordRequest(run, request, pathname, 204);
        response.writeHead(204, isolationHeaders).end();
      } catch (error) {
        recordRequest(run, request, pathname, 400);
        rejectRun(
          run,
          "phase-reporting",
          error instanceof Error ? error.message : String(error),
        );
        response.writeHead(400, isolationHeaders).end();
      }
      return;
    }

    if (pathname === "/__result" && request.method === "POST") {
      if (run === undefined) {
        response.writeHead(404).end();
        return;
      }
      try {
        const result = JSON.parse(await readRequestBody(request));
        markPhase(run, "result-received");
        recordRequest(run, request, pathname, 204);
        run.result.resolve(result);
        response.writeHead(204, isolationHeaders).end();
      } catch (error) {
        recordRequest(run, request, pathname, 400);
        rejectRun(
          run,
          "result-reporting",
          error instanceof Error ? error.message : String(error),
        );
        response.writeHead(400, isolationHeaders).end();
      }
      return;
    }

    const requestedPage = pathname.replace(/^\/+/, "");
    const isPage = allowedPages.has(requestedPage);
    const sourceRoot = isPage ? browserTestRoot : distributionRoot;
    const relativePath = isPage ? requestedPage : pathname.replace(/^\/+/, "");
    const path = normalize(join(sourceRoot, relativePath));
    const pathFromRoot = relative(sourceRoot, path);
    if (
      pathFromRoot === ".."
      || pathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(pathFromRoot)
    ) {
      recordRequest(run, request, pathname, 403);
      rejectRun(run, "asset-loading", `Browser request for ${pathname} was forbidden.`);
      response.writeHead(403).end();
      return;
    }

    try {
      const body = await readFile(path);
      recordRequest(run, request, pathname, 200);
      if (isPage && run !== undefined) {
        if (requestedPage !== run.page) {
          rejectRun(run, "navigation", `Browser requested unexpected page ${requestedPage}.`);
        } else {
          markPhase(run, "page-requested");
          run.navigation.resolve();
        }
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": contentTypeFor(path),
        ...isolationHeaders,
      }).end(body);
    } catch {
      recordRequest(run, request, pathname, 404);
      if (isPage || isRequiredAsset(pathname)) {
        rejectRun(run, "asset-loading", `Required browser asset ${pathname} returned 404.`);
      }
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    const handleError = (error) => reject(error);
    server.once("error", handleError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    register(token, page) {
      if (activeToken !== undefined) {
        throw new Error("The browser harness supports one active browser run at a time.");
      }
      const run = {
        lastPhase: "browser-process-requested",
        navigation: createDeferred(),
        page,
        phases: [{ elapsedMilliseconds: 0, phase: "browser-process-requested" }],
        requests: [],
        requestsTruncated: false,
        result: createDeferred(),
        startedAt: performance.now(),
      };
      runs.set(token, run);
      activeToken = token;
      return {
        navigation: run.navigation.promise,
        result: run.result.promise,
        markBrowserLaunched() {
          markPhase(run, "browser-launched");
        },
        snapshot() {
          return {
            elapsedMilliseconds: roundedElapsedMilliseconds(run.startedAt),
            lastPhase: run.lastPhase,
            phases: [...run.phases],
            requests: [...run.requests],
            requestsTruncated: run.requestsTruncated,
          };
        },
        cancel(reason = new Error("Browser run ended before receiving a result.")) {
          if (runs.get(token) !== run) {
            return;
          }
          runs.delete(token);
          activeToken = undefined;
          run.navigation.reject(reason);
          run.result.reject(reason);
        },
      };
    },
    async close() {
      for (const [token, run] of runs) {
        const error = new Error("Browser server closed before receiving a result.");
        run.navigation.reject(error);
        run.result.reject(error);
        runs.delete(token);
      }
      activeToken = undefined;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function withTimeout(promise, milliseconds, description, kind) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(
            new ClassifiedBrowserFailure(
              kind,
              `${description} timed out after ${milliseconds} ms.`,
            ),
          ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function terminateBrowser(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timeout;
  const terminated = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 2_000);
    }),
  ]);
  clearTimeout(timeout);
  if (!terminated) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

function failureDiagnostics({
  browser,
  executable,
  failure,
  page,
  processState,
  registration,
  standardError,
  standardErrorTruncated,
  version,
  cleanupFailure,
  terminationFailure,
}) {
  return {
    browser: browser.name,
    browserVersion: version,
    cleanupFailure,
    executable,
    failureKind: failure.kind,
    page,
    process: {
      error: processState.error,
      exitCode: processState.exitCode,
      signal: processState.signal,
    },
    standardError,
    standardErrorTruncated,
    terminationFailure,
    ...registration.snapshot(),
  };
}

function redactBrowserOutput(output, url, token) {
  const redactedUrl = `${url.origin}${url.pathname}?[redacted-query]`;
  return output.replaceAll(url.href, redactedUrl).replaceAll(token, "[redacted-token]");
}

export async function removeBrowserProfile(profile, removeDirectory = rm) {
  await removeDirectory(profile, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}

export async function runBrowserPage({
  server,
  browser,
  executable,
  page,
  parameters = {},
  navigationTimeoutMilliseconds = defaultNavigationTimeoutMilliseconds,
  applicationTimeoutMilliseconds = defaultApplicationTimeoutMilliseconds,
  version = "unknown",
  validateResult,
  removeProfile = removeBrowserProfile,
}) {
  const token = randomUUID();
  const profile = await mkdtemp(join(tmpdir(), "tabgrad-browser-profile-"));
  const url = new URL(page, `${server.origin}/`);
  url.searchParams.set("token", token);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  const registration = server.register(token, page);
  registration.navigation.catch(() => {});
  registration.result.catch(() => {});

  const child = spawn(executable, browser.argumentsFor(profile, url.href), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const processState = { error: null, exitCode: null, signal: null };
  const processClosed = createDeferred();
  const prematureExit = new Promise((_, reject) => {
    child.once("spawn", () => registration.markBrowserLaunched());
    child.once("error", (error) => {
      processState.error = error.message;
      reject(new ClassifiedBrowserFailure("browser-process", error.message, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      processState.exitCode = code;
      processState.signal = signal;
      reject(
        new ClassifiedBrowserFailure(
          "browser-process",
          `${browser.name} exited before reporting a result (code ${code}, signal ${signal}).`,
        ),
      );
    });
    child.once("close", () => processClosed.resolve());
  });
  prematureExit.catch(() => {});

  let standardError = "";
  let standardErrorTruncated = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const remaining = maxStandardErrorCharacters - standardError.length;
    if (remaining > 0) {
      standardError += chunk.slice(0, remaining);
    }
    if (chunk.length > remaining) {
      standardErrorTruncated = true;
    }
  });

  let result;
  let primaryFailure;
  try {
    await withTimeout(
      Promise.race([registration.navigation, prematureExit]),
      navigationTimeoutMilliseconds,
      `${browser.name} navigation to ${page}`,
      "navigation-timeout",
    );
    result = await withTimeout(
      Promise.race([registration.result, prematureExit]),
      applicationTimeoutMilliseconds,
      `${browser.name} application in ${page}`,
      "application-timeout",
    );
    if (validateResult !== undefined) {
      try {
        await validateResult(result);
      } catch (error) {
        throw new ClassifiedBrowserFailure(
          "application-result",
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
    }
  } catch (error) {
    primaryFailure = classifyFailure(error, "browser-run");
  }

  registration.cancel();
  let terminationFailure;
  try {
    await terminateBrowser(child);
    await withTimeout(
      processClosed.promise,
      2_000,
      `${browser.name} process stream closure`,
      "browser-termination",
    );
  } catch (error) {
    terminationFailure = error instanceof Error ? error.message : String(error);
  }
  let cleanupError;
  try {
    await removeProfile(profile);
  } catch (error) {
    cleanupError = error;
  }

  if (primaryFailure !== undefined || terminationFailure !== undefined || cleanupError !== undefined) {
    const failure = primaryFailure ?? new ClassifiedBrowserFailure(
      cleanupError === undefined ? "browser-termination" : "profile-cleanup",
      cleanupError === undefined
        ? `Could not terminate ${browser.name}: ${terminationFailure}.`
        : `Could not remove the ${browser.name} browser profile: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
    );
    const cleanupFailure = cleanupError === undefined
      ? null
      : cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    const causes = [primaryFailure, cleanupError].filter((error) => error !== undefined);
    const cause = causes.length > 1 ? new AggregateError(causes) : causes[0];
    const diagnostics = failureDiagnostics({
      browser,
      cleanupFailure,
      executable,
      failure,
      page,
      processState,
      registration,
      standardError: redactBrowserOutput(standardError, url, token),
      standardErrorTruncated,
      terminationFailure: terminationFailure ?? null,
      version,
    });
    throw new BrowserRunError(
      `${browser.name} ${page} failed during ${failure.kind}: ${failure.message}`,
      diagnostics,
      cause === undefined ? undefined : { cause },
    );
  }

  return result;
}
