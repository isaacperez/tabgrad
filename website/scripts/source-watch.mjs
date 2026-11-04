import { watch } from "node:fs";
import { basename, dirname } from "node:path";

/** Watch the parent because Git replaces its index atomically. Vite deliberately
 * ignores .git; do not widen its filesystem admission to work around that rule.
 * @param {string} index @param {() => void} changed @returns {import('node:fs').FSWatcher}
 */
export function watchGitIndex(index, changed) {
  return watch(dirname(index), { persistent: false }, (_event, filename) => {
    if (filename === null || filename.toString() === basename(index)) changed();
  });
}
