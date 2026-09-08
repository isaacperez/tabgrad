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
  const pendingResults = new Map();
  const allowedPages = new Set(pageNames);
  const isolationHeaders = crossOriginIsolation
    ? {
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
      }
    : {};
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://localhost");
      if (requestUrl.pathname === "/__result" && request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        const token = requestUrl.searchParams.get("token");
        const receiver = pendingResults.get(token);
        if (receiver === undefined) {
          response.writeHead(404).end();
          return;
        }
        try {
          receiver.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          response.writeHead(204, isolationHeaders).end();
        } catch (error) {
          receiver.reject(error);
          response.writeHead(400, isolationHeaders).end();
        } finally {
          pendingResults.delete(token);
        }
        return;
      }

      const requestedPage = requestUrl.pathname.replace(/^\/+/, "");
      const isPage = allowedPages.has(requestedPage);
      const sourceRoot = isPage ? browserTestRoot : distributionRoot;
      const relativePath = isPage
        ? requestedPage
        : requestUrl.pathname.replace(/^\/+/, "");
      const path = normalize(join(sourceRoot, relativePath));
      const pathFromRoot = relative(sourceRoot, path);
      if (
        pathFromRoot === ".."
        || pathFromRoot.startsWith(`..${sep}`)
        || isAbsolute(pathFromRoot)
      ) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      const contentType = extname(path) === ".wasm"
        ? "application/wasm"
        : extname(path) === ".json"
          ? "application/json"
          : extname(path) === ".html"
            ? "text/html; charset=utf-8"
            : "text/javascript; charset=utf-8";
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": contentType,
        ...isolationHeaders,
      }).end(body);
    } catch {
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
    receive(token) {
      return new Promise((resolve, reject) => {
        pendingResults.set(token, { resolve, reject });
      });
    },
    cancel(token) {
      const receiver = pendingResults.get(token);
      if (receiver !== undefined) {
        pendingResults.delete(token);
        receiver.reject(new Error("Browser run ended before receiving a result."));
      }
    },
    async close() {
      for (const receiver of pendingResults.values()) {
        receiver.reject(new Error("Browser server closed before receiving a result."));
      }
      pendingResults.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function withTimeout(promise, milliseconds, description) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${description} timed out after ${milliseconds} ms.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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
  timeoutMilliseconds = 30_000,
}) {
  const token = randomUUID();
  const profile = await mkdtemp(join(tmpdir(), "tabgrad-browser-profile-"));
  const url = new URL(page, `${server.origin}/`);
  url.searchParams.set("token", token);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  const resultPromise = server.receive(token);
  const child = spawn(executable, browser.argumentsFor(profile, url.href), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const prematureExit = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `${browser.name} exited before reporting a result (code ${code}, signal ${signal}).`,
        ),
      );
    });
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 16_384) {
      stderr += chunk;
    }
  });

  try {
    return await withTimeout(
      Promise.race([resultPromise, prematureExit]),
      timeoutMilliseconds,
      `${browser.name} ${page}`,
    );
  } catch (error) {
    if (stderr) {
      process.stderr.write(stderr);
    }
    throw error;
  } finally {
    server.cancel(token);
    if (child.exitCode === null && child.signalCode === null) {
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
    await removeBrowserProfile(profile);
  }
}
