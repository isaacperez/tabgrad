# Static website and executable documentation

This chapter is for contributors maintaining Tabgrad's public website and
applications learning from its examples. It explains source ownership, the
static build and execution boundaries. The library's identity remains in the
[README](../../README.md); its APIs and release support retain their primary
references. Website presentation does not extend those support claims.

The decision follows [research #297](https://github.com/isaacperez/tabgrad/issues/297),
accepted by the maintainer on 2 November 2026 after independent challenge
([acceptance record](https://github.com/isaacperez/tabgrad/issues/297#issuecomment-6572111002)).

## One website, different reader tasks

The site separates practical and editorial destinations: Home introduces Tabgrad and a runnable
example; Get started explains integration into an application; Documentation
provides concepts, interfaces and deeper technical perspectives; Playground
lets visitors edit and execute examples; Versions and compatibility identifies
the selected release and its evidenced limits. Blog publishes articles and
examples about the project, separately from normative technical documentation.

About and Contact are secondary destinations for the project, its maintainer
and contribution, sponsorship or professional-help enquiries. They do not
extend the library's support guarantees. External source, package and contact
links are ordinary links; the site does not embed social feeds, collect
contact-form submissions or process payments.

The visitor can try CPU or explicitly selected WebGPU examples without installing a local toolchain or
creating an account. Python still requires loading a browser interpreter.
Direct JavaScript integration can import the matched distribution from a
versioned CDN URL, or serve the files from the application's own origin,
as described in the [browser package guide](../reference/browser-package.md).
The application still owns its optional interpreter and worker lifetimes. The
playground's preparation must not be presented as automatic integration for
every application or bundler.

The maintained brand assets supply the artwork and palette. A shared catalogue
and execution component connect Home and Playground, while documentation uses
the existing reader perspectives. Integration programs retain their setup and
cleanup rather than silently becoming snippets that depend on playground globals.
The integration page's downloadable files are derived from those same Markdown
blocks. Source downloads use plain-text URLs and named download links, keeping
them separate from executable website routes and the search inventory.

## Repository Markdown is the documentation source

Authors edit the original Markdown files in the repository. The website build
reads its reviewed GitHub checkout; it does not fetch mutable Markdown from
GitHub in each visitor's browser. The resulting pages remain usable if a
GitHub API request would fail. Local development reads the same source files
and refreshes generated content after an edit.

Editorial articles live in `website/content/blog/`. They follow the same
Git-tracked, symlink-rejected source admission and are copied unchanged into
an ignored native Astro collection. A filename owns its unique article route;
validated frontmatter supplies title, summary, author, calendar date and optional
existing artwork. The shared index and article template render that collection
at build time. Neither article visits nor local reading fetch Markdown from
GitHub, acquire a computation device or start an interpreter. New articles and
edits use the existing source/index watch and do not require an npm release.
Articles distinguish version-specific capabilities from future goals and link
to maintained references. They do not replace or extend those contracts.

A publication register identifies admitted sources, routes and navigation.
Only Git-tracked source files are admitted; new pages enter the local preview
after they are added to Git. Ordinary edits to existing pages need no commit
or package release to appear locally. Untracked notes and ignored local files
cannot become website documentation merely by sharing a Markdown extension.
Technical concepts, architecture, components and flows keep their existing
owners. Public usage references are selected explicitly; contributor procedures,
measurement records and operational protocols remain linked repository material.
The website does not publish the entire checkout or blindly copy a directory
because it contains Markdown.

The build may generate ignored intermediate Markdown with page metadata. Those
files are derived inputs to the generator, never another maintained source.
Titles come from original headings; adaptations preserve code and contract
content. Included document links become website routes. Other repository links
identify their source revision rather than depending on a developer's path.
Route collisions, missing local destinations and invalid internal fragments
are build failures.

Editing documentation can update the website without publishing another npm
version. The deployment automation consumes a checked website output after its
own authorization. It does not become part of the tensor package release.
The documentation overview identifies its source separately from the version of
Tabgrad used by examples. Local previews distinguish unpublished edits from the
linked published base revision, including clean local commits that have not
been pushed. The build records its actual input revision separately. Architecture
explains accepted design; version-specific
support records establish implemented support. Unpublished API behavior is not
silently presented as stable. Historical versions link to their actual source
and records instead of relabelling current documentation as an archive.

## Static generation owns presentation

Astro generates static HTML pages; Starlight supplies the documentation layout,
navigation, code presentation and local search. Custom pages implement the
project's Home, integration and Playground experiences in the same build.
Small browser controls do not require another client UI framework.

The private website package owns its build dependency resolution and toolchain.
It neither extends the public library's exports nor changes the tensor runtime's
release environment. Its reproducible setup and commands belong in
[development](../development.md), with dependency origin and obligations in the
[dependency register](../dependencies.md).

Mermaid is converted to SVG during construction through the official CLI.
Readers receive diagrams without loading Mermaid. Source remains consultable;
diagrams require meaningful textual alternatives and legible layouts. Rendering
failure stops the build. The SVG is served as an image, with active content and
styles checked against the delivery policy, rather than inserted as executable
markup from an untrusted source. The rendering browser and fonts are build
dependencies with their own maintenance and attribution obligations.

## The playground owns execution, not tensor semantics

The host consumes the published exact Tabgrad package under the
[distribution contract](browser-distribution.md). It serves the complete matched
tree unchanged, at a versioned same-origin location. Optional Pyodide assets are
separately pinned and loaded only when Python is executed. The website does not
bundle separate copies of cooperating runtime entries or follow a mutable
registry channel during a visit.

Each Run creates a fresh interpreter/script worker and private control channel.
The host owns its session, interpreter attachment, output, errors and finalization.
JavaScript examples receive the documented host session; Python uses the managed
script entry. The numerical work and meaning remain in the library.

Preparation stages describe observed work. Expected results are labelled
separately from actual execution. Successful completion follows acknowledged
ordinary closure; Stop terminates the owned worker and retires its messages,
without claiming acknowledged cleanup or immediate physical reclamation.
Subsequent runs start fresh. Partial output and errors remain observable;
output rendering is text-safe and bounded independently of arbitrary program
memory or computation.

Execution requires an explicit visitor action. The application neither uploads
programs/tensor data nor provides a computation server, visitor account or
telemetry. Workers keep execution off the document's main thread, but do not
establish a security sandbox for hostile programs. Browser permissions and
response policies constrain what edited code can request; arbitrary third-party
package imports and automatic execution from shared URLs are not promised.

CPU is the initial selection and never acquires a GPU. Device selection chooses
an independent editable preset/draft; it does not rewrite a visitor's edited
program or silently fall back to CPU. Both frontends show explicit tensor
placement in their presets. Acquisition starts only after Run.

Direct JavaScript owns its GPU session in the executor. Managed Python owns a
physical GPU controller in the page, transfers its public opaque connection and
all transferables to the interpreter worker, closes the Python binding before
the controller, and retires the interpreter last. Stop revokes the controller
and discards the interpreter; it reports interrupted completion as unconfirmed.
Generation checks exclude late messages and setup results from a later run.

The shared workspace displays device state, total time and scoped memory peak,
with native expandable details. Public JavaScript diagnostics are captured
before edited code runs, and sampled before and after session close. CPU peak
counts allocator payload; Wasm memory is sampled before close. GPU counters
cover owned buffers, encoded dispatches and transfers, not physical VRAM or
utilisation. A successful script, closed session, no pending/unknown completion
and nonzero dispatch count are required to report GPU work completed. Software
adapters are identified. Acquiring a GPU alone is not numerical-use evidence.

Python uses the page-owned controller's public `diagnostics()` snapshot from
the matched distribution. Read at acquisition, existing resource messages and
after controller closure; replace the current observation without a timer,
per-operation instrumentation or sample history. The interpreter sends only its
own timing/lifecycle facts, never fabricated GPU counters. Acknowledged binding
cleanup and controller closure remain separate from observing counters; stopped
or failed programs do not become completed GPU work. CPU/interpreter memory
without a supported observation remains unavailable, distinct from measured zero.
Program time includes frontend work, computation and observation; total time
also includes preparation and cleanup. Neither is an isolated kernel benchmark.
The website does not estimate CPU load, total RAM, GPU utilisation or VRAM.
Physical qualification is an explicit browser check, separate from ordinary CPU
CI, with unavailable/nonhardware adapters rejected rather than silently skipped.

## Delivery is a static-host responsibility

The output needs HTTPS, correct JavaScript/JSON MIME and `application/wasm`, plus
same-origin worker URLs. Home and Playground use COOP `same-origin` and COEP
`require-corp`; their executor and physical GPU workers, and Pagefind’s
dedicated search worker, carry COEP as well. This admits managed Python GPU shared memory without requiring those
headers on documentation pages. Effective isolation must be checked in the
browser, including embedding constraints. Same-origin delivery avoids
unnecessary broad CORS permissions.

Document and worker responses have distinct content-security policies. Required
dynamic evaluation for edited JavaScript and Wasm belongs to the executor's
response policy, not every documentation page. Inline scripts/styles from the
theme and generated diagrams must be checked together with the actual policy.

HTML revalidation and immutable resource caching have different purposes.
An immutable URL cannot change bytes. Updates and rollback select coherent
website/runtime sets and account for older pages still requesting assets.
The site does not promise offline operation or introduce a service worker.

The production origin is an explicit external build input. Astro/Starlight
generate canonical URLs and the sitemap from it; an unset input does not invent
a production address. Shared social metadata uses that same origin. A build-only
renderer produces sharing PNGs from the brand, shared design styles and native
validated article metadata. It introduces no visitor-side renderer or remote
font request. The recovery page is not indexed or listed in the sitemap.
The same origin supplies sitemap discovery in the static robots file and article
structured data derived from the native validated Blog metadata. The documentation
adapter derives summaries from original introductions or reviewed publication
metadata; neither creates another editable technical documentation source.

CI builds and checks source changes with a reserved test origin and without
deployment credentials, including the public URL and sitemap invariants. An authorized
deployment uses the checked output; host-dependent routes, headers, resource
loading and recovery need verification at that destination. Static-host limits
are checked against the actual output. No vendor/account/domain configuration
belongs in this public contract.

## Alternatives and reconsideration

Astro/Starlight combines maintained documentation facilities and custom static
pages without an additional UI framework. The cost is a generator dependency
chain, a Markdown adapter and integration of the project's design with the
documentation theme.

VitePress is viable: it provides Markdown, a documentation theme, local search
and custom Vue components. Its normal navigation hydrates a Vue application,
which requires integrating worker lifetime and custom presentation with that
route lifecycle. No measured speed, size or accessibility superiority was used
to reject it.

A custom generator gives direct control and can reuse the prototype's Pandoc
approach. It also makes Tabgrad maintain search, accessible navigation, code and
diagram presentation and the generator itself. Separate documentation and
playground builds can isolate larger independent products, but introduce two
outputs to coordinate for navigation, brand, versions and publication.

Reconsider the choice if preserving the design requires a theme fork or replacing
its principal components, if dependency/license consequences change materially,
or if a verified integration cannot satisfy the source, delivery and lifecycle
boundaries. Build and host qualification establish actual behavior; prototype
success alone is not a production qualification, universal browser claim,
accessibility certification or quantitative performance guarantee.
