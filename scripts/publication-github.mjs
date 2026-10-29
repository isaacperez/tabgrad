import { sha256 } from "./release-record-data.mjs";
import { PublicationError, requirePublication } from "./publication-plan.mjs";

/** Fixed-origin, no-retry GitHub transport. Injectable origin is only a fixture seam. */
export function publicationGithub({ repository, token, origin = "https://api.github.com", fetcher = fetch,
  timeoutMs = 30000, maxResponseBytes = 4 * 1024 * 1024, readOnly = false }) {
  requirePublication(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && repository.split("/").every(part => part !== "." && part !== "..")
    && typeof token === "string" && token.length > 0, "PUBLICATION_GITHUB_ACCESS");
  const base = new URL(origin);
  requirePublication(base.href === "https://api.github.com/"
    || (base.protocol === "http:" && base.hostname === "127.0.0.1" && base.pathname === "/"),
  "PUBLICATION_GITHUB_ORIGIN");
  const prefix = `/repos/${repository}`;
  const observations = [];
  const assetCache = new Map();
  let checkedWorkflowPair;

  async function request(route, { method = "GET", body, binary = false, absent = false,
    upload = false, maxBytes = maxResponseBytes } = {}) {
    requirePublication(typeof route === "string" && (route === "" || route.startsWith("/"))
      && !route.includes("..") && !route.includes("#") && !route.includes("\\"), "PUBLICATION_GITHUB_ROUTE");
    requirePublication(!readOnly || method === "GET", "PUBLICATION_GITHUB_READ_ONLY");
    const url = new URL(`${prefix}${route}`, base);
    if (upload && base.hostname === "api.github.com") url.hostname = "uploads.github.com";
    const headers = { Authorization: `Bearer ${token}`, Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" };
    if (body !== undefined) headers["Content-Type"] = upload ? "application/octet-stream" : "application/json";
    const options = { method, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }) };
    let response, dispatched = false;
    try {
      dispatched = true;
      response = await fetcher(url, options);
      // Asset bytes may be redirected to GitHub's signed asset host. Credentials
      // never follow that redirect. JSON/write endpoints never redirect.
      if (binary && method === "GET" && response.status === 302) {
        const destination = new URL(response.headers.get("location"));
        requirePublication(destination.protocol === "https:" && destination.hostname === "release-assets.githubusercontent.com"
          && destination.username === "" && destination.password === "", "PUBLICATION_GITHUB_REDIRECT");
        await response.body?.cancel();
        response = await fetcher(destination, { method: "GET", redirect: "error", signal: options.signal });
      }
      const chunks = []; let length = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const next = await reader.read(); if (next.done) break;
            length += next.value.length;
            requirePublication(length <= maxBytes, "PUBLICATION_GITHUB_RESPONSE_LIMIT"); chunks.push(next.value);
          }
        } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
      }
      const raw = Buffer.concat(chunks);
      observations.push({ route, method, status: response.status, sha256: sha256(raw), byteLength: raw.length });
      if (absent && response.status === 404) return null;
      requirePublication(response.status === (method === "POST" ? 201 : method === "DELETE" ? 204 : 200),
        "PUBLICATION_GITHUB_RESPONSE");
      if (binary) return raw;
      if (response.status === 204) return null;
      return JSON.parse(raw);
    } catch (cause) {
      const error = new PublicationError(cause.code ?? "PUBLICATION_GITHUB_REQUEST", { cause });
      error.dispatched = dispatched;
      error.privateHttpEvidence = { route, method, status: response?.status, responseDigest: observations.at(-1) };
      throw error;
    }
  }

  async function pages(route) {
    const values = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await request(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      requirePublication(Array.isArray(result) && result.length <= 100, "PUBLICATION_GITHUB_PAGINATION");
      values.push(...result);
      if (result.length < 100) return values;
    }
    throw new PublicationError("PUBLICATION_GITHUB_PAGINATION_LIMIT");
  }

  async function visibility() {
    const repo = await request("");
    requirePublication(repo.full_name === repository && repo.permissions?.push === true && repo.archived === false
      && repo.disabled === false, "PUBLICATION_GITHUB_VISIBILITY");
    return repo;
  }

  async function tagRevision(tag) {
    let result = await request(`/git/ref/tags/${encodeURIComponent(tag)}`, { absent: true });
    if (result === null) return null;
    requirePublication(result.ref === `refs/tags/${tag}`, "PUBLICATION_TAG_INVALID");
    const seen = new Set();
    for (let depth = 0; depth < 16; depth += 1) {
      const object = result.object;
      requirePublication(typeof object?.sha === "string" && /^[0-9a-f]{40}$/.test(object.sha)
        && !seen.has(object.sha), "PUBLICATION_TAG_INVALID");
      seen.add(object.sha);
      if (object.type === "commit") return object.sha;
      requirePublication(object.type === "tag", "PUBLICATION_TAG_INVALID");
      result = await request(`/git/tags/${object.sha}`);
    }
    throw new PublicationError("PUBLICATION_TAG_DEPTH");
  }

  async function workflowTree(commit) {
    const source = await request(`/git/commits/${commit}`);
    requirePublication(source.sha === commit && /^[0-9a-f]{40}$/.test(source.tree?.sha), "PUBLICATION_SOURCE_TREE");
    let tree = source.tree.sha;
    for (const part of [".github", "workflows"]) {
      const result = await request(`/git/trees/${tree}`);
      requirePublication(result.sha === tree && result.truncated === false && Array.isArray(result.tree), "PUBLICATION_SOURCE_TREE");
      const matches = result.tree.filter(entry => entry.path === part);
      requirePublication(matches.length <= 1, "PUBLICATION_SOURCE_TREE");
      if (matches.length === 0) return null;
      requirePublication(matches[0].type === "tree" && /^[0-9a-f]{40}$/.test(matches[0].sha), "PUBLICATION_SOURCE_TREE");
      tree = matches[0].sha;
    }
    return tree;
  }

  async function prerequisites(plan) {
    const current = await request("/git/ref/heads/main");
    requirePublication(current.ref === "refs/heads/main" && current.object?.type === "commit"
      && current.object.sha === plan.publisher.revision, "PUBLICATION_MAIN_MOVED");
    if (plan.candidate.sourceRevision !== plan.publisher.revision) {
      const pair = `${plan.candidate.sourceRevision}:${plan.publisher.revision}`;
      if (checkedWorkflowPair !== pair) {
        const target = await workflowTree(plan.candidate.sourceRevision);
        const main = await workflowTree(plan.publisher.revision);
        // GITHUB_TOKEN cannot acquire Workflows-write. An older target which
        // changes workflow files would require that authority at release creation.
        requirePublication(target !== null && target === main, "PUBLICATION_WORKFLOWS_WRITE_REQUIRED");
        const after = await request("/git/ref/heads/main");
        requirePublication(after.object?.sha === plan.publisher.revision, "PUBLICATION_MAIN_MOVED");
        checkedWorkflowPair = pair;
      }
    }
    return { sourceRevision: plan.candidate.sourceRevision, recipeRevision: plan.publisher.revision };
  }

  async function state(plan, expectedAssets = new Map(), { forceAssetReads = false } = {}) {
    await visibility(); // Authenticated push visibility precedes interpreting absent drafts/tags.
    const tagRevision_ = await tagRevision(plan.github.tag);
    const matches = (await pages("/releases")).filter(release => release.tag_name === plan.github.tag);
    requirePublication(matches.length <= 1, "PUBLICATION_RELEASE_CONFLICT");
    const release = matches[0] ?? null;
    const assets = [];
    if (release !== null) {
      requirePublication(Number.isSafeInteger(release.id) && release.id > 0, "PUBLICATION_RELEASE_INVALID");
      const names = new Set();
      for (const asset of await pages(`/releases/${release.id}/assets`)) {
        requirePublication(typeof asset.name === "string" && !names.has(asset.name), "PUBLICATION_ASSET_CONFLICT");
        names.add(asset.name);
        const expected = expectedAssets.get(asset.name);
        requirePublication(expected && asset.state === "uploaded" && asset.size === expected.byteLength
          && Number.isSafeInteger(asset.id) && asset.id > 0, "PUBLICATION_ASSET_CONFLICT");
        let verified = assetCache.get(asset.id);
        if (forceAssetReads || asset.digest !== `sha256:${expected.sha256}`
          || verified?.name !== asset.name || verified?.byteLength !== expected.byteLength || verified?.sha256 !== expected.sha256) {
          const raw = await request(`/releases/assets/${asset.id}`, { binary: true, maxBytes: expected.byteLength });
          const identity = sha256(raw);
          requirePublication(raw.length === expected.byteLength && identity === expected.sha256, "PUBLICATION_ASSET_CONFLICT");
          verified = { name: asset.name, id: String(asset.id), byteLength: raw.length, sha256: identity };
          assetCache.set(asset.id, verified);
        }
        assets.push(verified);
      }
    }
    let latest = null;
    if (release?.draft === false) latest = await request("/releases/latest", { absent: true });
    return { tagRevision: tagRevision_, release, assets, latestId: latest === null ? null : String(latest.id) };
  }

  async function write(effect, plan, current, assetBytes, notes) {
    let result;
    try {
      switch (effect.kind) {
      case "github-tag": result = await request("/git/refs", { method: "POST",
        body: { ref: `refs/tags/${plan.github.tag}`, sha: plan.candidate.sourceRevision } }); break;
      case "github-draft": result = await request("/releases", { method: "POST", body: { tag_name: plan.github.tag,
        target_commitish: plan.candidate.sourceRevision, name: plan.github.tag, body: notes,
        draft: true, prerelease: false, make_latest: "false", generate_release_notes: false } }); break;
      case "github-asset": result = await request(`/releases/${current.release.id}/assets?name=${encodeURIComponent(effect.asset.name)}`,
        { method: "POST", body: assetBytes, upload: true }); break;
      case "github-public": result = await request(`/releases/${current.release.id}`, { method: "PATCH", body: {
        tag_name: plan.github.tag, target_commitish: plan.candidate.sourceRevision, name: plan.github.tag,
        body: notes, draft: false, prerelease: false, make_latest: plan.github.latest ? "true" : "false" } }); break;
      default: throw new PublicationError("PUBLICATION_EFFECT_UNSUPPORTED");
      }
      if (effect.kind === "github-tag") requirePublication(result.ref === `refs/tags/${plan.github.tag}`
        && result.object?.type === "commit" && result.object.sha === plan.candidate.sourceRevision,
      "PUBLICATION_GITHUB_CALL_MISMATCH");
      else {
        requirePublication(Number.isSafeInteger(result.id) && result.id > 0, "PUBLICATION_GITHUB_CALL_MISMATCH");
        if (effect.kind === "github-asset") requirePublication(result.name === effect.asset.name
          && result.size === effect.asset.byteLength && result.state === "uploaded"
          && (result.digest === null || result.digest === `sha256:${effect.asset.sha256}`), "PUBLICATION_GITHUB_CALL_MISMATCH");
        else requirePublication(result.tag_name === plan.github.tag && result.name === plan.github.tag && result.body === notes
          && result.prerelease === false && result.draft === (effect.kind === "github-draft")
          && (effect.kind !== "github-public" || result.id === current.release.id), "PUBLICATION_GITHUB_CALL_MISMATCH");
      }
      return result;
    } catch (cause) {
      // A response with the wrong identity is not a verified successful effect.
      // If the request was issued, retain uncertainty even for a 2xx response.
      if (result !== undefined) cause.dispatched = true;
      throw cause;
    }
  }
  return { request, pages, visibility, tagRevision, prerequisites, state, write, observations };
}
