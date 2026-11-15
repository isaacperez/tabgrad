import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { deliveryHeaders, scriptHashes } from "../../scripts/delivery.mjs";
import { isImmutableAsset } from "../../scripts/asset-identity.mjs";
import { hostingLimits, manifestName, publicationOrigin, inventory, fileRecords, sameInventory, verifyPayload as verifyInventory } from "./inventory.mjs";
import { releaseIdentity } from "../../scripts/release-input.mjs";
import { readPredecessor } from "./predecessor.mjs";
import { documentationIndexName, validateDocumentationIndex, preserveDocumentationArchives } from "../../scripts/documentation-index.mjs";
export { hostingLimits, manifestName, publicationOrigin, inventory, deliveryManifest } from "./inventory.mjs";

/** Compress identical HTML policies only inside a wholly HTML namespace. A missing
 * path still serves the recovery page, so its executable hashes must be admitted.
 * Different policies remain exact rules and retain the same host quota check.
 * @param {object[]} rules @param {{path:string}[]} files @param {string[]} recoveryHashes @returns {object[]} */
function compactHeaderRules(rules, files, recoveryHashes) {
  const namespaces = new Map();
  for (const rule of rules.slice(1)) {
    const segment = /^\/([^/]+)\//.exec(rule.path)?.[1];
    if (!segment) continue;
    const prefix = `/${segment}/`, group = namespaces.get(prefix) ?? [];
    group.push(rule); namespaces.set(prefix, group);
  }
  const replacements = new Map();
  const omitted = new Set();
  for (const [prefix, group] of namespaces) {
    const members = files.filter(file => ("/" + file.path).startsWith(prefix));
    if (group.length < 2 || members.length !== group.length || !members.every(file => file.path.endsWith(".html")
      && group.some(rule => rule.path === ("/" + file.path).replace(/index\.html$/, "")))) continue;
    const headers = group[0].headers, policy = headers["Content-Security-Policy"] ?? "";
    if (!group.every(rule => JSON.stringify(rule.headers) === JSON.stringify(headers))
      || !recoveryHashes.every(hash => policy.includes(hash))) continue;
    replacements.set(group[0], { path: prefix + "*", headers });
    for (const rule of group.slice(1)) omitted.add(rule);
  }
  return rules.filter(rule => !omitted.has(rule)).map(rule => replacements.get(rule) ?? rule);
}

/** Native rules match the original request URL, including fallback 404s. The global
 * policy therefore admits the recovery page's scripts; exact pages and active
 * worker entries replace it with their own shared policy. Passive asset CSP does
 * not grant the executor's eval permission. No MIME-by-extension rule can corrupt a 404.
 * @param {string} root @param {Array<{path:string}>} files @returns {Promise<string>} */
export async function nativeHeaders(root, files) {
  const fallback = await readFile(join(root, "404.html"), "utf8");
  const baseline = deliveryHeaders("/404.html", fallback);
  const rules = [{ path: "/*", headers: baseline }];
  for (const file of files) {
    const url = "/" + file.path;
    const html = file.path.endsWith(".html");
    const headers = deliveryHeaders(url, html ? await readFile(join(root, file.path), "utf8") : "");
    if (!html && !headers["Cross-Origin-Embedder-Policy"]) continue;
    const differences = Object.fromEntries(Object.entries(headers).filter(([key, value]) => baseline[key] !== value));
    if (!Object.keys(differences).length) continue;
    rules.push({ path: url.replace(/index\.html$/, ""), headers: differences });
  }
  const compact = compactHeaderRules(rules, files, scriptHashes(fallback));
  if (compact.length > hostingLimits.headerRules) throw new Error("Static output exceeds the native header-rule limit");
  const lines = compact.flatMap((rule, index) => [rule.path, ...Object.entries(rule.headers).flatMap(([name, value]) =>
    index && Object.hasOwn(baseline, name) ? [`  ! ${name}`, `  ${name}: ${value}`] : [`  ${name}: ${value}`]), ""]);
  if (lines.some(line => Buffer.byteLength(line) > hostingLimits.headerLine)) throw new Error("Native header line exceeds the host limit");
  return lines.join("\n");
}

/** Producer/native qualification also reconstructs the response rules. The
 * publisher instead checks the admitted digest and every byte without loading
 * build-time HTML tooling.
 * @param {string} root @param {{digest?:string,production?:boolean}} options @returns {Promise<object>} */
export async function verifyPayload(root, options = {}) {
  const result = await verifyInventory(root, options);
  if (await readFile(join(root, "_headers"), "utf8") !== await nativeHeaders(root, result.manifest.files)) throw new Error("Native policy differs from its shared owner");
  return result;
}

/** Copy one checked output plus only its predecessor's current immutable assets.
 * Retained assets are never inherited transitively; a conflicting immutable URL
 * fails before publication. The new directory is owned by this call and removed
 * on failure, never overwriting a previous result.
 * @param {string} source @param {string} destination
 * @param {{checked:object,origin:string,revision:string,previous?:string,production?:boolean}} options
 * @returns {Promise<{manifest:object,digest:string}>} */
export async function preparePayload(source, destination, { checked, origin, revision, previous, production = true, rollback = false }) {
  const input = resolve(source), target = resolve(destination);
  const previousRoot = previous && resolve(previous);
  if ([input, previousRoot].some(root => root && (target === root || target.startsWith(root + sep) || root.startsWith(target + sep)))) throw new Error("Payload directories must be independent");
  const publicOrigin = publicationOrigin(origin, production);
  if (checked.origin !== publicOrigin || checked.revision !== revision || typeof checked.localChanges !== "boolean"
    || (production && checked.localChanges) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Output does not identify the requested clean source and origin");
  const release = checked.release && releaseIdentity(checked.release);
  if (release && !/^[a-f0-9]{40}$/.test(checked.recipeRevision)) throw new Error("Release recipe changed");
  const current = await inventory(input);
  sameInventory(fileRecords(checked.files), current);
  if (current.some(file => ["_headers", "_redirects", manifestName].includes(file.path)
    || /(?:^|\/)(?:node_modules|scripts|local|\.env|wrangler)(?:[./-]|$)/.test(file.path))) throw new Error("Hosting/private configuration in raw website output");
  const predecessor = previousRoot && await readPredecessor(previousRoot, production);
  const documentation = current.some(file => file.path === documentationIndexName)
    ? validateDocumentationIndex(JSON.parse(await readFile(join(input, documentationIndexName)))) : null;
  if (predecessor?.documentation) {
    if (!documentation) throw new Error("Published documentation archive inventory disappeared");
    preserveDocumentationArchives(predecessor.documentation, documentation);
  }
  if (documentation && documentation.versions.some(entry => entry.documents.some(document =>
    !current.some(file => file.path === document.route.slice(1) + "index.html")))) throw new Error("Documentation archive HTML is missing");
  if (predecessor && predecessor.manifest.origin !== publicOrigin) throw new Error("Predecessor origin differs");
  if (production && predecessor?.manifest.format === 2 && !release && !rollback) throw new Error("Select the completed release or explicitly authorize a rollback");
  const currentMap = new Map(current.map(file => [file.path, file]));
  for (const old of predecessor?.manifest.files ?? []) {
    if (isImmutableAsset("/" + old.path) && currentMap.has(old.path) && currentMap.get(old.path).sha256 !== old.sha256) throw new Error("Immutable URL changed bytes");
  }
  await mkdir(target);
  try {
    for (const file of current) {
      await mkdir(dirname(join(target, file.path)), { recursive: true });
      await copyFile(join(input, file.path), join(target, file.path));
    }
    for (const path of predecessor?.manifest.currentImmutable ?? []) {
      if (currentMap.has(path)) continue;
      await mkdir(dirname(join(target, path)), { recursive: true });
      await copyFile(join(previousRoot, path), join(target, path));
    }
    const previousCurrent = new Set(predecessor?.manifest.currentImmutable ?? []);
    const retained = (predecessor?.manifest.files ?? []).filter(file => previousCurrent.has(file.path) && !currentMap.has(file.path));
    sameInventory([...current, ...retained], await inventory(target));
    await writeFile(join(target, "_headers"), await nativeHeaders(target, await inventory(target)));
    const manifest = { format: release ? 2 : 1, ...(release ? { release, recipeRevision: checked.recipeRevision } : {}), origin: publicOrigin, revision, publishable: production && !checked.localChanges, previous: predecessor?.digest ?? null,
      currentImmutable: current.filter(file => isImmutableAsset("/" + file.path)).map(file => file.path), files: await inventory(target) };
    await writeFile(join(target, manifestName), JSON.stringify(manifest) + "\n");
    return await verifyPayload(target, { production });
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}
