# Tabgrad website

Private static-site build package. It is not published to npm and does not
compile a second tensor runtime. It uses the matched published Tabgrad package
for the educational CPU/WebGPU playground.

Read [the website contract](../docs/architecture/static-website.md) for the
content, execution and delivery boundaries. Read [development setup and
commands](../docs/development.md#prepare-and-preview-the-static-website) before
installing dependencies or running checks.

After selecting this directory's Node version and preparing its dependencies:

```console
npm --prefix website run dev
```

Edit documentation in `docs/`, not the generated content tree. Local edits
refresh the dev page; new documents must be selected and Git-tracked. For the
full local search and production serving rules:

```console
npm --prefix website run build
npm --prefix website run verify
npm --prefix website run preview
```

The preview serves `website/dist/` only. Missing paths return the built
`404.html` with HTTP 404, its own document policy and recovery links. The error
page follows the same output-tree boundary as other files; if it is unavailable,
the server retains a plain 404 response. The maintained `src/pages/404.astro`
owns this route; Starlight's default is disabled through `disable404Route`.
Deployment and account configuration
are not part of these commands. Keep local tools, original evidence and private
configuration outside maintained source and generated public output.

Get started renders the HTML/CDN example directly from the browser package
guide's first HTML block, and the two complete Python integration files from
the named fences in the Python host guide. Their imports use the exact published version
and raw files; the playground itself keeps its separate same-origin assets.
`IntegrationSource` gives each file the same download action and native code
disclosure; expanding it retains the full syntax-highlighted, copyable source.
`integration-files.mjs` derives the downloads from those same strings, wrapping
only the JavaScript body snippet in a complete HTML document. Source URLs end
in `.txt` and return plain text; the download attribute supplies the actual
filename. They do not introduce executable website/search routes. Output checks
compare every download's bytes and filename link; browser checks exercise the
disclosures and both Python file tabs at the existing responsive widths.

After changing that example, explicitly run `npm --prefix website run test:cdn`
with public network access. It checks the same block in Chrome and Firefox,
including manifest/Wasm delivery, repeated Python runs, partial program errors
and worker startup/native WebAssembly errors. The successful Python case serves the exact two
documented files; the failure controls use explicitly modified workers. Only
the HTML and application worker are local, with runtime/interpreter assets
loaded from the pinned CDN. The standalone HTML, worker and observations stay
in ignored `.generated/`, not the public build.

The playground keeps source and selection in a native textarea. Its syntax
view uses the pinned Prism core and language grammars, with a narrow local
declaration for that untyped dependency. Tokens become text nodes and spans,
never parsed HTML. If coloring fails, the textarea remains visible and usable
with a diagnostic notice. Browser checks cover both language grammars, edited
source, selection, wrapping and the presentation fallback.

Example explanations in `src/playground/examples.json` use single backticks
around literal code references. `InlineText` and the client renderer share the
same text-safe code-span parser and the site's central inline-code style.
These fields support code spans only, not arbitrary Markdown or HTML.
Each example keeps its introduction and editing suggestion in the shared catalogue.
Language-specific explanations can name the corresponding frontend method.
Fixed-value Python assertions belong in the shared test driver rather than the
editable presets; CPU/GPU checks cover both the original results and edited inputs.

## Public URLs and sharing cards

The optional `TABGRAD_SITE_URL` build input is an HTTPS origin, with no path,
credentials, query or fragment. Keep concrete deployment values outside source
and work records. An unset input keeps the build suitable for local authoring;
it does not invent a public origin. To qualify public URL generation locally:

```console
TABGRAD_SITE_URL=https://example.invalid npm --prefix website run build
npm --prefix website run verify
```

`example.invalid` is a reserved test address, not a deployment destination.
Astro/Starlight own canonical URLs, `og:url` and sitemap generation. The recovery
page is `noindex` and excluded from the sitemap. The verifier compares the
generated sitemap/canonical/image URLs against the build input and page inventory.
CI supplies the reserved origin to both build and verification; an explicit
verification origin must match the recorded build input. This exercises public
metadata without deployment configuration. `robots.txt` allows crawling and
announces that origin's sitemap; local builds omit only the sitemap line.
The actual host still needs separately authorized qualification.

Technical documentation summaries come from the first top-level Markdown
paragraph, flattened to plain text without changing its source. A document with
no introductory paragraph uses its own title. The adapter supplies the same
summary to native page metadata and the build inventory; output verification
checks description and Open Graph summary against that inventory.
The publication configuration owns reviewed editorial summaries for the few
decision chapters that begin with an acceptance notice; preparation rejects
entries that no longer name an admitted document.

`scripts/publication.mjs` owns origin validation and shared image metadata.
The Blog template supplies article type, author, date and its image override.
With a public origin, it also emits `BlogPosting` JSON-LD from those same validated
article fields and URLs. Calendar dates retain their precision; no publication
time or author identity is invented. Serialized data cannot end its script tag.
The post-build `social-images.mjs` renderer reads native validated article
metadata, the outlined brand logo, local Inter, shared tokens and illustration
paint. Its fixed 1200×630 PNG is a sharing format, not another responsive layout.
No renderer or remote font loads during a visitor's page visit. Changed inputs
invalidate the keyed cache; retired article images are pruned. A title that
cannot fit fails the build rather than being silently cropped. Local PNGs and
metadata can be verified before deployment; social platforms' actual previews
can only be checked after hosting.

## Write a blog article

Articles are authored in `content/blog/*.md`, separately from the normative
technical documentation. The file `introducing-tabgrad.md` becomes
`/blog/introducing-tabgrad/`. Use a unique lowercase filename with letters,
digits and single hyphens. The filename owns the route; frontmatter cannot
override it. Start the body with a paragraph or H2, since the shared article
template supplies its H1 from metadata.

```yaml
---
title: Introducing Tabgrad
description: A short, accurate summary for the article and its listing.
author: Isaac Pérez
date: "2026-11-11"
illustration: browser
---
```

Title, description, author and ISO calendar date are required. Optional
`illustration` names come from `scripts/illustrations.mjs`; the website uses
its own admitted artwork, not an external image request. Unknown metadata and
invalid dates fail validation. Posts sort newest first, then by filename.

Add a new article to Git with `git add -- website/content/blog/your-post.md`.
Only tracked Markdown without symlink ancestors is admitted. Edits to an
admitted source need no commit to refresh the dev page; an index change also
refreshes admission. Untracking or renaming retires its old generated copy and
route. Use site-absolute links such as `/start/` and `/docs/`; generated files
have a different location from original Markdown. Output verification rejects
broken local destinations and fragments. Do not edit `.generated/blog/`.

The native Astro collection reads derived copies of the original Markdown.
Listing and article pages share metadata, typography, code presentation and
navigation. Blog cards share the frame of Home’s example cards and the shared
link interaction role. Article visits do not fetch GitHub content or start the playground;
readers choose a normal link to run an example. Existing API references remain
the support authority, and articles state their example version and distinguish
future goals. Unpublished files have no invented GitHub permalink.

The dev command watches article content and membership. Build and preview
produce and serve checked static files, like the rest of this website. Markdown
edits can update the website without publishing another library package;
deployment still has its separate authorization.

## Presentation system

Browser checks derive their page inventory from every built HTML file. Each page
loads its fonts and content images and is checked at mobile and desktop widths
for page overflow, text containment and native table layout. Representative
primary and documentation pages also receive the detailed breakpoint,
navigation and text-spacing checks. These geometry checks complement native
visual inspection; they do not establish complete accessibility conformance.

`src/styles/tokens.css` extends the installed Starlight theme; `site.css` applies
it to the shared components and pages. Inter is self-hosted under the OFL;
its pin, origin and notices are recorded in the dependency documentation.
Use Starlight's type scale rather than adding nearly equivalent font sizes.
Roles are entry title, section title, card title, lead, body, interface/help and
metadata. Home, secondary introductions and the Markdown documentation overview
share one entry-title type owner, including weight, leading and tracking,
whether or not they include artwork. Their layouts retain their own purposes.
Reading pages retain the framework's restrained heading scale. Code
uses the shared body-size token in documentation and editable examples.
Marketing body text follows its allocated column; section-wide explanations
are not constrained by a separate reading-width cap. Deliberate short hero
introductions and long-form documentation/legal reading retain their measures.

Spacing follows a short quarter-rem scale; corner radii and comfortable control
sizes are shared. Measures in `ch` constrain introductions and prose. These are
explicit design choices, not values mandated by an accessibility standard.
The brand violet is used for large display text and decoration; small accent
text and links use the theme's contrasting text accent. The secondary theme
picker uses Starlight's small-text role, with the same comfortable control
height as the primary controls.
Borders, grid track counts and the syntax view's measured geometry express
their own layout meaning and are not arbitrary offsets to conceal in tokens.

Let content wrap or cards auto-fit before adding a breakpoint. The 50rem
transition follows Starlight's sidebar/menu; 70rem reserves space for full
navigation and readable paired panes. Header height and menu clearance derive
from the same controls and framework dimensions. The shared outer frame matches
Starlight's splash-page measure. Avoid manual
pixel corrections and additional device-specific shrinking. Inspect changed
components with their real text and execution states in both themes.
The editor toolbar stretches its tabs to the separator; a tools group owns
Copy's block insets and inline spacing. Its clearance must not depend on the
difference between the button and tab heights or on a per-page offset.
When text or available width requires it, the tools wrap to another row rather
than covering or clipping a control.
The navigation search shares the transparent toolbar treatment and focus ring.
GitHub and the theme picker use that same transparent surface, with the shared
underline and keyboard focus tokens instead of a separate filled hover tile.
Its label is visible alongside the icon when space permits; the compact header
keeps the accessible icon button and the same control size. Compact navigation
uses native auto-popovers, as does Starlight's documentation index: the browser
owns keyboard dismissal, outside clicks and focus return. The site menu and
documentation index use distinct labelled controls and cannot stay open over
each other. A stable scrollbar gutter keeps the header in place when the index
locks page scrolling. Resize closes a navigation whose trigger has become hidden.
The footer groups exploration and project links. Package versions belong to
Versions and the runnable examples; documentation source and local-preview
information belong to the documentation overview, where their distinct meaning
is explained. Source links pin a published revision; an unpublished local commit
links to its shared published base and is labelled as a preview. The build keeps
its actual input revision separately. The shared illustration size roles distinguish Home's
lead scene, secondary introductions, supporting cards and compact symbols.
About and Contact are secondary destinations for the project's purpose,
maintainer, contribution and professional-help enquiries. They are reachable
from the footer and compact menu without adding to the primary navigation.
Public repository, package and maintainer-contact URLs live in `scripts/config.mjs`.
Project icons use Starlight's installed icon set, with text or an accessible
link name. Contact offers the maintainer's public LinkedIn and X profiles;
professional and sponsorship enquiries use the same primary LinkedIn destination.
About links to the introductory Blog article and Contact's sponsorship section.
Voluntary contributions use `SupportLink` and
the owner-selected
support URL in the same config; About and the footer share that ordinary link
and the existing button roles. There is no provider script, embedded feed,
contact form or payment-data handling in this site.

`PageIntro` owns secondary-page introductions. Without artwork, the title,
explanation and optional action stay together in one column at every width.
Playground and Licenses use the compact spacing and
prose measure. Compact descriptions use native pretty wrapping to avoid short
last lines while retaining the natural flow of prose, rather than balancing
every line like a heading. Illustrated introductions pair the complete text group with
artwork on wide screens and stack it above the artwork on narrow screens.
When an introduction also serves as the page summary, its page-local description
is passed to both `PageIntro` and Starlight metadata, as on Blog and Get started.
Get started uses that composition and the wrapping project-actions row for its
language examples and playground link, rather than the vertical closing-actions role.
`SplitSection` owns the shared editorial columns in Home, Get started, About
and Contact: one title/optional introduction and one body, with shared spacing
and anchor clearance. Its typed stacked variant keeps the heading above the
body within the reading measure, without an outer separator. `NextStep` owns the matching heading,
description and actions at the end of Home, Get started and Playground. Pages
provide content and links through typed props/slots, not their own copies of
these structures. Integration shows the working HTML before its optional setup
and architecture diagram. The documentation overview is curated navigation; technical
pages still render the admitted repository Markdown and preserve its anchors.
Sidebar sizing and reading roles use the same theme tokens.
The runner's editor, result, toolbar, metrics and footer share the horizontal
`--tg-runner-gutter` token. It uses the spacing scale without reducing code type
or applying an example-specific width rule.
Paired documentation routes share heading, description and link rows through
subgrid. Unequal text lengths retain common alignment without fixed heights;
the narrow layout keeps each route's natural reading order.

Text-link metrics and interaction states have one shared owner in `site.css`, using
the underline tokens in `tokens.css`. Native underlining is positioned below
descenders and skips glyph ink. The same base rule covers always-underlined
prose/actions, navigation, search text and card title targets; interaction
states only choose when to show the line. Ordinary navigation and text links underline; linked
cards mark their title targets, so hovering a card does not underline its whole
description. Buttons retain their control role. Individual page and navigation
selectors leave interaction states to that shared owner.
Text navigation keeps the same underline/color treatment for hover and the
current page; it does not also paint a hover or active background.

The `ink-surface` role supplies foregrounds, diagnostics and controls for the
code workspace and release panel. The shared runner frame separates its toolbar,
editable source, output and supporting information. Example choices remain
ordinary buttons at every width. The native editor still owns source/selection;
presentation does not change execution or resource lifetime. Static Markdown
and integration code use Expressive Code's installed GitHub Dark High Contrast
theme and the shared frame colors and spacing. Its configured frame settings
remove theme shadows and tab indicator lines, keep a plain title and align its
padding with the source.
Static code titles and source share the `codePaddingInline` setting in
`astro.config.mjs`, using the existing one-rem spacing token so short examples
retain their natural line breaks on narrow screens. Explicit `wrap` blocks use
the shared wrapping rule when a longer line still needs it.
Home uses the same runner and complete catalogue code, with a brief explanation
of the original calculation.
Its output and full measurement summary share a panel beside the code on wide
screens and precede the code on narrow screens once a run starts. Before that
first run, or after Reset, the narrow compact demo puts its source before the
empty result pane, directly after the controls. Result and measurement controls
stay available when resizing or moving focus. This uses the shared
runner's existing idle state and breakpoint; it does not remove observed metrics
or change the full Playground. Summary rows become columns
only when the summary itself has enough width; the viewport alone cannot
establish that space. Playground keeps its full-width measurement summary.
The Home FAQ uses the stacked section and native disclosures; its short answers
point to the maintained capability, integration and project sources. Content
disclosures put their indicator at the right and use separators only between
questions; execution details retain their compact operational label. The hero
keeps one compatibility link; the footer groups the open-source and license
facts using the secondary text role and retains ordinary source navigation.
Home's three illustrated use cases link to existing examples or integration;
the complete four-example catalogue remains in Playground. Console results
use the shared larger text role so the outcome is distinct from editable source.
Title and frame share the corner radius so the title
background cannot cover the outer curve. The existing CSS color adapter maps the theme to the
same code-panel roles as the runner. Wrapped blocks can shrink below
the highlighter's default line minimum; text wraps without shrinking the font
or changing copied source. Blocks not configured to wrap retain their own
scrolling behavior.

The language toolbar groups Reset and Copy as editor tools. `RunControls` owns
the labelled device selector and separate Run/Stop actions below it. Segmented
device choices select a setting; language tabs and text links keep their own
roles. These groups wrap intrinsically with the shared control size and spacing,
without changing enabled states or execution lifetimes.

Home's illustrated use cases have a full-width section boundary and heading
before the card grid. The gallery uses one, two or three columns at the existing
breakpoints; equal canvas proportions and shared card painting keep the original
drawings together visually. Subgrid aligns the artwork, headings, descriptions
and actions within each row while text keeps its natural height. The quadratic drawing shares
the family's optical width while keeping its curve, points and tangent coherent.

Versions separates available capability groups, execution requirements,
versioned limits and release history. Its native rows stack on narrow screens;
links lead to the API references and the current version's support record.
Backend cards share content rows through subgrid, including their nested native
definition lists, so setup labels and reference actions align as text wraps.
Content is a curated summary of those records, not another support policy.

The footer owns the gap after page content. Final marketing sections keep their
internal layout but omit trailing padding so two components do not accumulate
the same separation.

Original vector artwork is maintained under `src/assets/illustrations/`.
The finite build-only catalogue in `scripts/illustrations.mjs` supplies both
Astro and the curated Markdown overview. It accepts no arbitrary file path.
`Illustration` hides these contextual drawings from assistive technology;
the surrounding text and controls supply their meaning. The artwork contains
no script, external resource or IDs that could collide when repeated.
`illustrations.css` owns painting, line and shadow roles through the shared
theme tokens; each SVG owns its geometry. Depth uses the same subtle panel
shadow throughout, without detached ground ellipses. No drawing is a screenshot or a live
execution indicator. The original brand logos remain unmodified.

`IntegrationMap` keeps essential labels as native text. `ExampleDiagram` reads
explanatory data from the existing example catalogue, under the original-example
disclosure. Selection exposes the matching diagram; editing code does not turn
that illustration into an observation. Actual program output stays separate.
Layout wraps labels and diagram terms rather than scaling text down on mobile.

References: [Starlight styling](https://starlight.astro.build/guides/css-and-tailwind/),
W3C [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[target sizes](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
and [text-spacing overrides](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html).
Text colors also follow the [contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
The browser checks exercise bounded layout/accessibility conditions; they do
not establish complete WCAG conformance or physical-device qualification.

## Readable documentation diagrams and disclosures

Diagram source stays in a standalone disclosure. The adapter escapes source
newlines as HTML character references so a valid Mermaid blank line cannot end
the raw HTML block during Markdown rendering and hide later chapter content.
The Markdown pipeline test preserves exact decoded source; output verification
and all-page browser checks reject chapter content inside a source disclosure.
The shared disclosure role also resets framework marker masks and chrome, so
technical pages and the playground use the same interface labels and markers.

Markdown tables keep their native headers and cells inside a named, focusable
scroll area generated by the shared rehype table plugin. Its derived column
count and the existing compact content measure keep prose readable beside API
signatures. Each column fits within the actual scroll area, so its paragraphs
can be read after panning to that column. The surrounding page stays within the
viewport; horizontal navigation uses the shared keyboard focus treatment.
Table text and code still come from the original Markdown, without mobile copies.

Technical diagrams retain the coordinate dimensions of the rendered SVG instead
of shrinking their labels to fit a phone. The build reads each viewBox and writes
image dimensions into only the diagram HTML it owns. A named, focusable viewport
contains horizontal scrolling; captions, full-size links and original Mermaid
source stay outside that viewport. Small diagrams keep their actual size, with
no fixed minimum width. SVG bytes and immutable asset identities do not change.
The adapter retains its parsed AST until the diagram dimensions are available,
sizes only its owned diagram nodes, then serializes once. Code samples and
unrelated HTML are not searched or rewritten.

Run details, original-example explanations and Mermaid source share the
`disclosure` presentation role, with interface-sized labels and the same
plus/minus and focus treatment. Labels do not inherit different sizes from
their content: metadata, explanation and source code keep their own type roles.
They remain native details/summary controls with no new client script or state.

Idle measurement guidance has one owner in `run-summary.ts`, used by both the
static markup and the live renderer. Preparing runs and runs with no available
observations receive distinct messages; neither is told to start an idle run.

## GPU execution and resource feedback

Visitor controls and ordinary messages use CPU/GPU. WebGPU remains the browser
technology name in setup explanations, technical references, asset paths and
the unchanged `webgpu` device identifier in code. The concise Finished message
still requires acknowledged ordinary closure through the private control port;
the details explain that guarantee. Unavailable measurements, encoded-work
counts, software adapters and interrupted/unknown completion remain explicit.
Peak buffer memory describes tracked memory for the selected device, never
total browser RAM or GPU VRAM. Fixed dtype information belongs in code and the
compatibility reference rather than an editor control that offers no choice.

The shared Runner owns the device choice, independent drafts and execution
lifetime. Output follows the execution controls directly: beside source on wide
screens, before source in the single-column layout. The DOM exposes output first
so it remains next in keyboard order after Run. Home keeps real resource
observations in its output panel; Playground places them after the workspace.
Execution does not scroll the page or move focus. `presets.ts` adds visible device declarations only to curated programs;
`gpu-lease.ts` owns the page's managed Python GPU service. `RunSummary` renders
validated public observations through the same ink, spacing and type roles on
Home and Playground. There are no utilisation estimates or private API reads.
The summary uses aligned label/value rows in a narrow panel and three columns
when its own content width reaches 50rem, independent of the controls' viewport
breakpoint. Values wrap within their
cells, including loading and unavailable states. Browser checks measure the
actual text fragments, not only container rectangles, so clipping cannot be
hidden by the workspace's rounded border.
Python GPU data comes from the page-owned controller's public `diagnostics()`
at acquisition, existing resource messages and closure. Observations replace the
previous snapshot; no polling, sample history, per-operation work or private
connection fields are introduced. The local Python binding supplies CPU facts through its public `diagnostics()`;
the page supplies GPU facts from its own retained controller. The executor shares
CPU projection with JavaScript, captures the reader before edited code and keeps
one pre-close CPU snapshot so normal cleanup does not erase the peak or
WebAssembly capacity. Cumulative counts use the latest observation, including
work completed during cleanup. Reader failures do not prevent the independent cleanup
attempt or replace the original script failure. If the pre-close reading fails,
memory remains unavailable even when post-close counters can be read; reset
memory values are not presented as a measured zero. CPU details include kernel calls
and byte/copy counts in both directions; these are local transfers, not network
uploads. No interpreter heap or whole-device usage is inferred.
The explanation distinguishes the retained peak from the latest current GPU
buffers and pending work, which may include cleanup observations.
Run details omit unobserved metrics, keep measured zero visible and reset
their rows when the language, device or example actually changes. Re-selecting
the active choice preserves output, measurements and the details disclosure,
including keyboard navigation. Explicit Reset still restores the original code
and clears results. Before a run, feedback says Not started/No run yet; missing
peak memory after execution is labelled Unavailable. A failed bootstrap without a supported observation remains
unavailable; a CPU-only Python program in GPU mode can report real GPU zeros.

After building, run `npm --prefix website run test:gpu` for the explicit physical
qualification (installed Chrome by default, or `TABGRAD_BROWSER`). It uses the
built UI, unmodified packaged assets and actual response policies: eight GPU
programs, explicit placement, resource scope, partial failure, cancellation and
recovery. A missing, software or undisclosed adapter fails qualification. Normal
`test:browser` remains the Chrome/Firefox CPU and responsive-layout check.
GPU availability for visitors still depends on their browser/device and secure
isolated hosting; selecting WebGPU does not promise acceleration.

The preview applies COEP to Pagefind’s dedicated search
worker, as well as the execution workers, so search can use it from isolated
execution pages and ordinary documentation. It does not isolate all documentation
or grant Pagefind JavaScript eval. Browser checks query the real index from Home,
Playground and Docs and observe worker replies and absence of fallback warnings.
`scripts/delivery.mjs` is the response-policy reference, not a generated hosting
configuration. An authorized hosting implementation must apply and qualify those
document/worker distinctions at its destination. The preview redirects repeated
path separators to one canonical path, preserving queries and isolation.
The output verifier also checks the executor's bytes against its hash-named URL;
an existing filename alone cannot establish immutable content.

Versions keeps a curated list of published releases, including the selected
runtime. The build rejects a runtime pin absent from that list, so updating the
package also requires reviewing its history entry. Entries after the selected
version form Previous releases; support documents alone do not establish publication.

## Result identity, console and example links

The shared Runner retains only the currently executed source string alongside
its displayed observations. Editing keeps that output and its real measurements,
with a visible previous-run note when the text differs. Returning to the exact
executed text removes the note. A new run replaces this snapshot; Reset and
selection changes clear it. No program history or per-operation tracking is added.

Python stdout and stderr use Pyodide's public byte-write handlers with one
streaming UTF-8 decoder per channel. The managed wrapper flushes both streams
before Python converts a raised exception
to its host diagnostic. After closure, the host flushes again for cleanup output
through the public interpreter API and completes each decoder. Text retains its
actual newline boundaries, including final partial lines, before normal
completion or a cooperative failure. Flush errors
remain run failures. Forced Stop still cannot promise final output or cleanup.
The shared character and logical-line budgets apply to the emitted text, not to
the number of writes. Rendering uses text nodes and does not append newlines.
JavaScript console formatting preserves non-finite numbers and negative zero in
scalars and containers; ordinary data keeps its compact JSON-style presentation.
This is readable console text, not a JSON export or a DevTools object inspector.

The focusable output console is at most half the small viewport height. This
leaves the surrounding workspace usable with long output rather than stretching
the whole page. Native scrolling and selection retain every admitted line;
the existing worker payload limits are separate. Errors show a headline and
available Python user line, with the original diagnostic in an expandable section
inside that same bounded console. Headline extraction is presentation-only;
unknown formats fall back to their first line and keep full details.

Playground reflects example, language and device in its address with replaceState,
without adding history entries on each selection. Unrelated query fields, the
fragment and history state are preserved. Edited source is never inserted into
the URL; reloading restores the selected preset, not an edited draft. The compact
Home runner leaves its page address unchanged and retains its existing explicit
same-tab draft handoff. Contributor qualification procedures remain repository
links rather than entries in the published usage reference.
