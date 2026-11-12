/** These URLs must retain their bytes across updates, independently of HTTP caching.
 * @param {string} path @returns {boolean} */
export function isImmutableAsset(path) {
  return /^\/(?:vendor\/[^/]+\/[^/]+\/|diagrams\/[a-f0-9]{64}\.svg$|_astro\/)/.test(path)
    || /^\/playground\/executor-[a-f0-9]{64}\.worker\.js$/.test(path);
}
