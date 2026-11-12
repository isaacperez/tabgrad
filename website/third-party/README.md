# Website third-party notices

These upstream notice files accompany the unmodified optional Pyodide runtime
copied by the website build. They are source inputs, not execution reports.
The authoritative dependency and redistribution record is
[Dependencies and third-party code](../../docs/dependencies.md#website-build-and-browser-assets).

| File | Exact upstream source | SHA-256 |
| --- | --- | --- |
| `PYODIDE-LICENSE` | [Pyodide 8cec1b9](https://github.com/pyodide/pyodide/blob/8cec1b9bb8ead68c7c09b0a6443576bec7512268/LICENSE) | `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5` |
| `PYTHON-LICENSE` | [CPython v3.14.2](https://github.com/python/cpython/blob/v3.14.2/LICENSE) | `b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231` |
| `EMSCRIPTEN-LICENSE` | [Emscripten 5.0.3](https://github.com/emscripten-core/emscripten/blob/5.0.3/LICENSE) | `620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86` |

Pyodide's `pyodide-lock.json` identifies Python 3.14.2 and Emscripten 5.0.3.
The website license page offers these notices and exact source links. Preserve
the prebuilt files' own embedded notices as well. Changes to the interpreter
pin require checking this source correspondence, the selected asset inventory,
licenses and browser behavior together.

`SVELTE-LICENSE` preserves the MIT notice from [Svelte 4.2.20](https://github.com/sveltejs/svelte/blob/svelte%404.2.20/LICENSE.md)
for the Svelte 4 runtime bundled by Pagefind's prebuilt search UI. Pagefind's
package declares Svelte `^4.2.1` as a build dependency without identifying its
exact resolution; this notice source does not assert a particular compiler
version. The site incorporates the notice in its browser-component attribution.

## Inter font

The unmodified Inter 4.1 variable fonts come from
[`rsms/inter` revision `e3a3d4c57d5ecc01453a575621882a384c1995a3`](https://github.com/rsms/inter/tree/e3a3d4c57d5ecc01453a575621882a384c1995a3).
They are self-hosted build inputs, not installed system fonts. The complete
OFL notice is incorporated in the site's component notices.

| Local file | Path at that revision | SHA-256 |
| --- | --- | --- |
| `src/assets/fonts/InterVariable.woff2` | `docs/font-files/InterVariable.woff2` | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| `src/assets/fonts/InterVariable-Italic.woff2` | `docs/font-files/InterVariable-Italic.woff2` | `e564f652916db6c139570fefb9524a77c4d48f30c92928de9db19b6b5c7a262a` |
| `third-party/INTER-LICENSE` | `LICENSE.txt` | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |
