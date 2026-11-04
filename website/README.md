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

The preview serves `website/dist/` only. Deployment and account configuration
are not part of these commands. Keep local tools, original evidence and private
configuration outside maintained source and generated public output.

Get started renders the HTML/CDN example directly from the browser package
guide's first HTML block. Its JavaScript import uses the exact published version
and raw files; the playground itself keeps its separate same-origin assets.
After changing that example, explicitly run `npm --prefix website run test:cdn`
with public network access. It checks the same block in Chrome and Firefox,
including manifest/Wasm delivery and completed cleanup. The generated standalone
HTML and observations stay in ignored `.generated/`, not the public build.

The playground keeps source and selection in a native textarea. Its syntax
view uses the pinned Prism core and language grammars, with a narrow local
declaration for that untyped dependency. Tokens become text nodes and spans,
never parsed HTML. If coloring fails, the textarea remains visible and usable
with a diagnostic notice. Browser checks cover both language grammars, edited
source, selection, wrapping and the presentation fallback.

## Presentation system

`src/styles/tokens.css` extends the installed Starlight theme; `site.css` applies
it to the shared components and pages. Inter is self-hosted under the OFL;
its pin, origin and notices are recorded in the dependency documentation.
Use Starlight's type scale rather than adding nearly equivalent font sizes.
Roles are Home display, page title, section title, card title, lead, body,
interface/help and metadata. Secondary introductions inherit the same heading
scale whether or not they include artwork; the Home display has its own role.
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
is explained. Source links retain the exact revision, even when a local preview
adds unpublished edits. The shared illustration size roles distinguish Home's
lead scene, secondary introductions, supporting cards and compact symbols.
About and Contact are secondary destinations for the project's purpose,
maintainer, contribution and professional-help enquiries. They are reachable
from the footer and compact menu without adding to the five primary links.
Public repository, package and maintainer-contact URLs live in `scripts/config.mjs`.
Project icons use Starlight's installed icon set, with text or an accessible
link name. Contact and sponsorship enquiries open the maintainer's public X
profile. Voluntary contributions use `SupportLink` and the owner-selected
support URL in the same config; About and the footer share that ordinary link
and the existing button roles. There is no provider script, embedded feed,
contact form or payment-data handling in this site.

`PageIntro` owns secondary-page introductions, including the legal page's compact
heading. `SplitSection` owns the shared editorial columns in Get started, About
and Contact: one title/optional introduction and one body, with a single grid,
spacing and anchor-clearance rule. `NextStep` owns the matching heading,
description and actions at the end of Home, Get started and Playground. Pages
provide content and links through typed props/slots, not their own copies of
these structures. Integration shows the working HTML before its optional setup
and architecture diagram. The documentation overview is curated navigation; technical
pages still render the admitted repository Markdown and preserve its anchors.
Sidebar sizing and reading roles use the same theme tokens.
Paired documentation routes share heading, description and link rows through
subgrid. Unequal text lengths retain common alignment without fixed heights;
the narrow layout keeps each route's natural reading order.

Link hover and visible focus states have one shared owner in `site.css`, using
the underline tokens. Ordinary navigation and text links underline; linked
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
padding with the source. Title and frame share the corner radius so the title
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

Home's examples have a full-width section boundary and heading before the card
grid, distinct from the preceding benefits. The gallery uses one, two or four
columns at the existing breakpoints; equal canvas proportions and shared card
painting keep the original drawings together visually. Text keeps its natural
height and each card's action follows its content. The quadratic drawing shares
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
theme tokens; each SVG owns its geometry. No drawing is a screenshot or a live
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
lifetime. `presets.ts` adds visible device declarations only to curated programs;
`gpu-lease.ts` owns the page's managed Python GPU service. `RunSummary` renders
validated public observations through the same ink, spacing and type roles on
Home and Playground. There are no utilisation estimates or private API reads.
Python GPU data comes from the page-owned controller's public `diagnostics()`
at acquisition, existing resource messages and closure. Observations replace the
previous snapshot; no polling, sample history, per-operation work or private
connection fields are introduced. Interpreter messages remain timing/lifecycle
reports; the page supplies GPU facts from its own retained controller.
Run details omit unobserved metrics, keep measured zero visible and reset
their rows when language/device changes. Missing peak memory is labelled
Not measured. CPU/interpreter memory without a supported observation remains
unavailable; a CPU-only Python program in GPU mode can report real GPU zeros.

After building, run `npm --prefix website run test:gpu` for the explicit physical
qualification (installed Chrome by default, or `TABGRAD_BROWSER`). It uses the
built UI, unmodified packaged assets and actual response policies: eight GPU
programs, explicit placement, resource scope, partial failure, cancellation and
recovery. A missing, software or undisclosed adapter fails qualification. Normal
`test:browser` remains the Chrome/Firefox CPU and responsive-layout check.
GPU availability for visitors still depends on their browser/device and secure
isolated hosting; selecting WebGPU does not promise acceleration.
