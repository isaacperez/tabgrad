# Publish the static website

This procedure is for the maintainer delivering the reviewed website output.
It is independent of library releases. Markdown or presentation changes do not
require publishing another npm package. The [website contract](architecture/static-website.md)
owns presentation and execution; this procedure owns the delivery handoff.

## Prepare and check source

Use the website's prepared Node and npm from [development](development.md#prepare-and-preview-the-static-website).
The separate `website/hosting/` lock selects the native emulator and publisher:

```console
npm ci --prefix website/hosting --ignore-scripts --no-audit --no-fund
```

This is setup, not an implicit part of a check. The locked official platform
packages provide workerd and esbuild without running installation scripts; an
absent supported binary is a setup failure, not permission to fetch a substitute.
Set `WRANGLER_SEND_METRICS=false`. No login, global installation or host account
is needed for local qualification.

After a clean website build and `npm --prefix website run verify`, prepare and
qualify an unpublished reserved-origin payload from the repository root:

```console
TABGRAD_WEBSITE_MODE=check TABGRAD_SITE_URL=https://example.invalid/ node website/hosting/scripts/prepare.mjs website/dist website/.generated/delivery
npm --prefix website/hosting test
npm --prefix website/hosting run test:browser
npm --prefix website/hosting run test:gpu
```

The destination must be new. Reuse an existing result for inspection; choose a
new output directory through the explicit command/`TABGRAD_WEBSITE_PAYLOAD` for
another preparation. Do not overwrite an inspected payload. A publication
candidate requires a clean source revision and a real external origin; a dirty
local preview cannot be relabelled as one. The ordinary website source tests
and type check still apply. The physical GPU check remains separate from CPU
CI; an unavailable adapter is not a pass.

The exporter compares every file with the output verifier's recorded hashes,
then copies the exact bytes. `_headers` derives document and worker policies
from `scripts/delivery.mjs`. The native fallback policy admits the recovery
page's scripts; differing documents and active worker entries replace it with
their own policy. Passive assets can inherit the recovery hashes, never the
executor's eval permission. MIME remains native, so an absent `.js` URL returns
HTML with its real 404 status rather than an incorrect JavaScript type.

All responses revalidate (`Cache-Control: no-cache`), including resources and
404s. The browser may retain an asset and reuse it after an ETag/304 response.
This adds possible validation requests compared with year-long immutable
caching; no temporal advantage is claimed. URL identity remains immutable:
versioned or content-addressed URLs cannot change bytes. Native prefix rules
also match absent URLs, and enumerating this output's resources exceeds the
100-rule quota; revalidation avoids caching those failures as immutable.
The exporter rejects output exceeding the native file, file-size, rule or line
limits rather than silently weakening a policy.

## Admit the real destination separately

Source integration does not enroll a service, create an environment or publish.
Before activation, obtain operational authority and inspect the actual account,
free-plan limits, current DNS/host ownership, readers and effective protections.
Use a dedicated assets-only hosting resource. Publishing replaces a version of
that selected resource; it is not safe to repurpose an unrelated Worker.
Keep account, destination and credential values outside public work records.

Configure the fixed GitHub environment `website-publication` for protected
`main` with an admitted required reviewer and no routine bypass. For a sole
maintainer, choose its self-review policy deliberately so approval is usable.
Keep these secrets **only in that environment**, with no repository or
organization duplicate that would bypass the gate:

- `TABGRAD_HOST_CONFIG_JSON`: exactly `account_id` and `name`, identifying the
  separately admitted dedicated resource. No routes, source scripts or bindings.
- `TABGRAD_WEBSITE_TOKEN`: the separately admitted credential restricted to the
  necessary hosting account and script-publication permission. Account scope is
  not a claim of isolation to one individual Worker. Do not grant DNS, billing or
  unrelated account administration merely to run this workflow.

Repository variables `TABGRAD_SITE_URL` and `TABGRAD_WEBSITE_ENABLED=true`
select the explicit public origin and enablement. Set enablement last, after
checking the environment and secret placement. The origin necessarily appears
in public URLs/metadata; this does not disclose or authorize account details.
Missing enablement/configuration fails closed. Do not enable, configure secrets,
or dispatch a real publication merely because this source has been merged.

The publisher has no request-handler `main`, routes or domain-association input.
It disables the selected resource's `workers.dev` endpoint and version preview
URLs. It does not manage separately configured custom-domain previews. Domain,
DNS, certificate and any service enrollment remain separately admitted operator
work. Hosting setup and the final destination need actual verification; native
emulation cannot establish their behavior or an effective cost guarantee.

## One checked handoff and one protected publication

Run **Website checks** manually on `main` with `publish=true`. For an admitted
first delivery only, also select `initial=true`; this skips predecessor lookup
and requires the operator to have established there is no existing delivery.
Ordinary PR/main CI never receives the hosting secrets and never publishes.

The source job builds with the explicit origin, runs source/output/native and
Chrome/Firefox CPU checks, and uploads `website-delivery`. It includes only the
static payload and a public `website-delivery.json` inventory; private native
configuration and credentials are excluded. The digest identifies the complete
manifest, which identifies every payload byte including the native rules.
The candidate is downloadable for inspection before the environment approval.
Artifact retention is requested for 30 days, not a waiting period. The
workflow's public logs/artifacts contain the public origin and reviewed source
identity; account and credential values must remain outside them.

For updates the source job obtains the currently served manifest and its
**current** immutable assets anonymously from that same origin. It reuses exact
current files instead of downloading them again, checks every acquired hash,
and rechecks the manifest after acquisition. It has one 60-second acquisition
deadline and a 128 MiB transfer-admission budget, including an at-most-8 MiB
manifest. These are tooling budgets, not service limits or performance claims;
a larger legitimate predecessor requires a reviewed budget change. It never
inherits retained assets transitively. Normal updates therefore do not depend
on an earlier CI artifact remaining downloadable.

Approve only after inspecting the selected main revision, output digest,
checks, origin and predecessor identity. The protected job downloads the same
run's artifact, verifies the manifest digest and every file again, and rejects
extra/changed files, a reserved origin or a different revision. Before an
update it also checks that the live predecessor is still the one prepared.
One serialized publication may proceed; it is not cancelled by a newer run.

The official fixed CLI receives the private assets-only configuration in a
new temporary directory and its token only at the publication step. Its own
internal upload/retry behavior remains the vendor's; the wrapper performs no
outer retry. Unfiltered CLI text is not emitted or uploaded because it may
identify private hosting configuration. The bounded public receipt records the
source, payload digest, attempted state, exit and confirmed/unknown outcome.
After the command succeeds, a separate public manifest read must match the
exact delivered bytes before the workflow reports confirmation.

## Updates, recovery and remaining hosted checks

The payload contains current files plus the predecessor's current immutable
files. Two sets are intentional: the current page and its immediate predecessor
can still request their known versioned resources. Assets retained only for a
two-generations-old page are retired at the next update. This is not an
indefinite old-tab or offline guarantee; older tabs may need a reload. A URL
collision with different immutable bytes is rejected.

A normal rollback restores the reviewed website source on `main` through a PR
and uses the same publication path. It retains the then-current assets as the
predecessor, preserving both sets. Blind native-version rollback may drop those
newer resources and is not the equivalent recovery procedure. No unbounded
archive, service worker, library release or signing protocol is introduced.

If a credential-bearing call fails, is interrupted or cannot be confirmed, its
result stays **unknown**. Preserve its receipt and candidate. Inspect the live
manifest and the actual service version with separately admitted read access;
do not rerun the job or repeat deployment merely because CI is red. The first
attempt restriction rejects GitHub re-runs. New recovery writes require an
explicitly admitted plan, including any still-uncertain earlier call. Public
manifest confirmation is not an atomicity guarantee for every cached client.

Before announcing the first hosted delivery, verify HTTPS/certificate and
canonical origin; real 404/redirect/MIME/headers; effective browser isolation;
search and both languages' CPU/GPU programs, metrics, partial failure, Stop and
recovery; public asset identities and a bounded update/rollback. Check the
actual service's free-plan admission and protections rather than relabelling
local results. These account operations remain outside source-only preparation.

Native behavior and quotas follow the provider's [static assets documentation](https://developers.cloudflare.com/workers/static-assets/),
[header format](https://developers.cloudflare.com/workers/static-assets/headers/),
[limits](https://developers.cloudflare.com/workers/platform/limits/) and
[deployment tool](https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler).
