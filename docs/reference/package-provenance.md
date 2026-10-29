# Verifying retained producer proofs

This contributor tool checks retained producer evidence under an independently
admitted plan. It implements the verification boundary of the
[release policy](../releases.md#preserve-the-qualified-bytes-and-their-producer-evidence).
It does not sign, download proofs or trust roots, enroll operational trust,
execute a candidate, publish, or admit a release.

## Inputs and commands

Use the prepared repository Node environment and a separately prepared,
identified GitHub CLI **2.102.0**. No installation or credential fallback occurs.
The verifier checks both the binary's admitted SHA-256 and its reported version.
Changing a dependency record alone does not qualify another client version.

```console
node scripts/package-provenance.mjs private-plan.json archive.tgz candidate.json static-dist archive-proof.json inventory-proof.json trusted-root.jsonl admitted-ci.json
```

The eight positional inputs are the plan, original archive, original producer
inventory, matching static tree, original archive bundle, original inventory
bundle, offline trust material and independently admitted CI corroboration.
The static input is the contents corresponding to `package/dist`, without its
parent `package` directory. Retain all originals; the tool removes only its own
temporary copies/client state. Neither a pathname nor this command makes an
input trusted.

`verifyPackageProvenance({plan, archive, inventory, staticDirectory,
archiveBundle, inventoryBundle, trustRoot, ciEvidence})`, exported by
`scripts/package-provenance.mjs`, supplies the same API. `plan` is a data object;
the other values are paths. Success returns a safe report. Failure throws
`ProvenanceError` with `code`, safe `message`, and `report`; its raw `cause`
and client evidence are private. Do not serialize the whole error.

## Admit expectations separately

The private plan has exactly the following keys. This schema illustration uses
placeholders for digests, identities and the client path; it is not an admitted
plan. Millisecond/output bounds are explicit operational choices, not measured
performance guarantees.

```json
{
  "schemaVersion": 1,
  "expiresAt": "2030-01-01T00:00:00.000Z",
  "trustRootSha256": "<64 lowercase hexadecimal characters>",
  "client": {
    "path": "/absolute/path/to/gh",
    "version": "2.102.0",
    "sha256": "<admitted binary SHA-256>"
  },
  "limits": { "timeoutMs": 15000, "maxOutputBytes": 1048576 },
  "identity": {
    "repository": "example/project",
    "repositoryId": "17",
    "ownerId": "23",
    "sourceRevision": "<40 lowercase hexadecimal characters>",
    "sourceRef": "refs/heads/main",
    "workflowPath": ".github/workflows/prepare.yml",
    "workflowRevision": "<same revision as sourceRevision>",
    "signerUri": "https://github.com/example/signing/.github/workflows/sign.yml@refs/heads/main",
    "signerRevision": "<separately admitted signer commit>",
    "runId": "131",
    "runAttempt": "2",
    "event": "workflow_dispatch"
  },
  "candidate": {
    "inventorySha256": "<exact original inventory SHA-256>",
    "archiveSha512": "<128 lowercase hexadecimal characters>"
  },
  "ciEvidenceSha256": "<exact admitted CI record SHA-256>",
  "inventorySubject": "candidate.json"
}
```

The plan's expiry is a future canonical UTC ISO timestamp with milliseconds.
It is checked before proof use and completion. Client timeout is a positive
integer no greater than Node's `2147483647` timer limit; output bound is a
positive safe integer and covers stdout/stderr together. A bound failure kills
the owned client and waits for its close. This does not establish termination
of unrelated descendants after host failure or bound all hostile-input memory.

The supported profile is public GitHub, source `refs/heads/main`, hosted
runners, and `push` or `workflow_dispatch`. Workflow paths are direct YAML
files under `.github/workflows`. The approved signer URI may identify another
repository/reusable workflow; its digest is independent of the source commit.
Repository/owner/run/attempt IDs are positive decimal strings, avoiding numeric
precision loss. Matching a repository name alone is insufficient.

Offline trust input is original JSONL, with one Sigstore trusted-root v0.1 JSON
object per line and a final LF, identified by `trustRootSha256`. The client uses
only that explicit file and local bundles. An isolated HOME/configuration and
allowlisted environment remove ambient credentials, proxy and injection
settings. The binary and host are trusted execution inputs, not a sandbox.
No root refresh, revocation lookup or actual provider admission occurs.

The separately admitted CI record has exactly these fields:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `identity` | Exactly the plan's identity object |
| `candidate` | Exactly the plan's inventory/archive identities |
| `tools` | Exactly the original inventory's `node` and `npm` record |
| `qualification` | Exactly `{ "status": "passed", "evidenceSha256": "<64 lowercase hex>" }` |

`qualification.evidenceSha256` identifies the separately retained qualification
evidence. It is not a download instruction. The caller must establish the
record's authenticity, actual preparation/checks and source/protection context
before admitting its identity into the plan. Writing a matching JSON record or
hash cannot supply that authority. Acquisition/authentication of CI observations
remains an explicitly unqualified operational prerequisite.

## What the verifier establishes

The inventory uses the existing package producer's exact field order, sorted
file list, `JSON.stringify(record, null, 2)` encoding and final LF. The tool
checks its original SHA-256 and supported encoding; it never reformats a signed
subject. Existing unsigned candidate preparation and content verification are
unchanged. The supported inventory records Node/npm; it does not claim to
capture every system, compiler or network input.

The archive owner checks original compressed identity, supported archive
structure, complete allowed files, sizes and hashes, package name/version and
source documentation. The static tree must match every `dist/` file, with no
omission, addition, link or special entry. These are observations of the supplied
tree at verification; they do not freeze a caller-controlled pathname against
later mutation. Future handoffs must conserve and verify identified bytes.

Both bundles are checked by the actual admitted client using explicit local
trust and exact signer/source options. The returned original statement must
agree with the original envelope payload. The archive statement contains
exactly one npm PURL/SHA-512 subject; leading `@` in scoped names becomes `%40`,
as in the selected npm publication client's PURL construction. The other
statement identifies the plan's inventory subject name and original SHA-256.

The candidate profile requires in-toto Statement v1, SLSA provenance v1 and the
exact Actions workflow build type
`https://actions.github.io/buildtypes/workflow/v1`. Its
[format specification](https://github.com/actions/buildtypes/blob/055cb51e699272e4928520287e99d91fd8e9cca2/workflow/v1/README.md)
defines the builder as the signing workflow. Certificate issuer, SAN, signer URI/digest,
repository URI/immutable IDs, source digest/ref, workflow configuration/digest,
event, hosted runner and run/attempt must exactly match policy. Authenticated
time evidence must be present. The two proofs must identify the same admitted
producer execution and signer policy.

Workflow-controlled predicate fields are then compared separately: source
workflow path/ref/repository, IDs/event, the one qualified resolved-source
dependency, builder and invocation. The builder must equal the independently
admitted `signerUri`, including when the signer is a reusable workflow in
another repository. Signed `runner_environment` must agree with the
certificate's required `github-hosted` runner. External parameters contain
only `workflow`, with exactly `path`, `ref` and `repository`; unknown parameters
are rejected. The original inventory's source/tools,
certificate-bound source/run, signed claims and independently admitted CI
record must agree. A signature authenticates the selected workflow's claim;
it does not independently prove a build happened or a test was adequate.
Unsupported result/claim formats fail rather than selecting another profile.

## Interpret results and failures

The command emits one JSON report and exits nonzero on failure. Reports include
actual client identity, environment, input digests, completed checks, failure
phase and owned cleanup. No private paths, configuration, raw client output,
issuer/source URLs or operational account details are printed. The CLI also
identifies the exact original plan bytes; the API's `planSha256` identifies its
parsed plan serialization. Preserve original inputs to resolve those digests.

`operationalTrust`, `ciEvidenceAcquisition`, `generatorInteroperability` and
`releaseAdmission` remain `unqualified` on success. `PLAN_INVALID`, identity/
subject/claim disagreement, unsupported client/result, client timeout/output
failures and existing archive-content errors are distinct safe classifications.
The report retains partial progress; a failed second proof does not claim the
first proof was never checked. Success follows owned cleanup.

## Qualify the actual client offline

The specialized command requires a separately prepared exact client and fixture
directory. It does not use the incidental GitHub CLI on a CI runner, install
anything, fetch fixtures/roots, or require credentials:

```console
node scripts/qualify-provenance-client.mjs /absolute/path/to/gh ADMITTED_BINARY_SHA256 prepared-fixture-directory
```

The [fixture manifest](../../js-tests/fixtures/provenance-client.json) identifies
five original files from GitHub CLI commit
`26d2302cb8d6a327de6ab48f85bb039df57848c3` (`sourceVersion: 2.90.0`), their
Git blob IDs, SHA-256, sizes and source paths. This identifies the fixture
source separately from the selected client version. Prepare those exact public originals separately;
no archive/bundle is vendored or executed by this repository. Upstream source
uses the [MIT license](https://github.com/cli/cli/blob/26d2302cb8d6a327de6ab48f85bb039df57848c3/LICENSE).
The command copies them into owned storage and identifies its local JSONL root
encoding separately. It verifies an npm/SHA-512 artifact and an artifact signed
through another repository's reusable workflow; checks actual output mapping;
and observes rejection of changed artifacts/signatures/payloads, wrong signer/
source/ref case, signer-prefix lookalikes, missing trusted authorities and
independently changed expected IDs/run/attempt/subject name. Its fixed
local-control bounds are not release-run bounds.

These identified upstream fixtures use the older build type
`https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1` and
builder `https://github.com/actions/runner/github-hosted`, without the signed
runner field required for candidates. Only the fixture qualifier selects that
fixed mapping. It shares certificate, time, subject and common claim checks
with the candidate verifier; it does not provide a candidate fallback or a
profile selector in the plan. Candidate and fixture policies reject each
other's build-type/builder pair.

Default Node tests separately use clearly synthetic, unsigned envelopes and a
controlled adapter for project-policy, original-byte, error and composition
controls. Modeled fixture-policy tests characterize the legacy mapping without
repeating actual-client qualification. These kinds of evidence do not constitute a real Tabgrad
Actions-signed archive/inventory round trip. Client/platform/fixture/schema
changes require affected requalification. Actual generator claims, protected
handoffs, root freshness/enrollment, npm bundle acceptance and publication still
need their separately authorized operational evidence under the release policy.
An offline replay of retained genuine proofs establishes only the checks it
actually completes. Preserve failed CI records and original plans separately;
a corrected replay does not turn a failed historical CI job into a successful
one or admit a release.
