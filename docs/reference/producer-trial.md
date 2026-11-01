# Experimental hosted producer trial

This is a retained experimental recipe for qualifying the producer mechanism.
It does not admit a release. [Release policy](../releases.md) owns approval,
artifact provenance, publication order, recovery and release records. The
[offline verifier](package-provenance.md) owns proof and claim admission;
[package qualification](package-qualification.md) owns external consumers.

## Roles and entry

`.github/workflows/producer-trial.yml` uses three ordinary GitHub-hosted jobs.
It requires neither a nested Docker service nor the experimental acquisition
supervisor. GitHub's runner, scheduler, artifact service, action implementations
and effective repository protections are trusted service boundaries. Job and
client timeouts do not prove physical termination, deletion or a strict wire
deadline.

The workflow has only `workflow_dispatch`. It is inert unless the repository
variable `TABGRAD_PRODUCER_TRIAL_ENABLED` is exactly `true`. Merging source does
not authorize setting that variable, dispatching the trial or signing. Before
activation the maintainer must separately authorize the concrete source,
public/private outputs and readers, resources, deadlines, trust inputs and
effective environment protection. Check those settings directly in GitHub.
An absent environment can be created automatically without protection: a YAML
environment name alone is never evidence of approval enforcement.

The four required dispatch inputs are:

| Input | Meaning |
| --- | --- |
| `source_revision` | Exact reviewed 40-character lowercase main commit; also the workflow revision and checkout SHA |
| `expires_at` | Finite absolute UTC deadline, canonical ISO spelling with milliseconds and `Z`; it must remain in the future at admission and before either signature |
| `trusted_root_sha256` | Independently admitted SHA-256 of the exact original trusted-root JSONL; it must not be learned from the received proofs |
| `confirmation` | Literal `producer-trial`, supplied after operational authorization |

The local entry is `node scripts/producer-trial.mjs COMMAND ...`. It requires
the workflow's `TABGRAD_TRIAL_*` context and GitHub-provided repository/owner
IDs, run ID, source, ref and workflow identity. It admits only main,
`workflow_dispatch` and attempt 1. A shell comparison checks exact values before
checkout, avoiding case-insensitive expression comparisons. The Node entry
checks the full context. Re-running an attempt is not a recovery path. An
expired context permits only conservation of proof bytes already produced.
The enable variable is an admission switch, not a reliable emergency stop for
work already running.

## Prepare, sign, verify

1. **`prepare-and-qualify`**, without signing permissions, invokes the existing
   package producer once from clean identified source. It preserves the current
   package version and private status. It qualifies the supplied archive in
   Chrome and Firefox: direct JavaScript, Python CPU and prerequisite rejection,
   including installed/relocated contents and cleanup. It retains the archive,
   complete static/package tree, original `candidate.json`, qualification report
   and `producer.json` binding those hashes to this source/run/attempt. Failed
   qualification can retain observed partial data but cannot enable signing.
   The final summary identifies the frozen artifact and hashes for review.
2. **`sign-qualified-candidate`** depends on successful preparation and awaits
   the separately admitted `tabgrad-producer-signing` protected environment.
   The maintainer reviews the source, artifact identity/hashes and preparation
   results before approving. This is the only job with `id-token: write` and
   `attestations: write`; all jobs have only Contents/Actions read otherwise.
   After receiving and rechecking the exact data, `actions/attest` produces
   separate proofs for the npm PURL/SHA-512 archive subject and the
   `candidate.json`/SHA-256 inventory subject. The recipe invokes no npm
   publication and supplies no npm credentials; its token cannot write
   repository contents. Effective isolation from a publisher identity also
   depends on provider OIDC bindings and remains separately unqualified.
   Attestation service writes and possible public
   transparency entries are real effects requiring prior authorization.
3. **`verify-retained-proofs`**, without signing permissions, receives both
   artifacts by exact numeric IDs and checks digests. It corroborates the
   repository, source, event, run, attempt and completed producer/signer jobs
   through authenticated GitHub API reads. It retains each original JSON
   observation before validating it or making the next query, checks both raw
   proof hashes, obtains the independently admitted root bytes and composes the
   existing offline verifier. Its original
   inputs, plan and verification/failure report form a separate diagnostic
   artifact, not a third candidate handoff or a release record.

The source-controlled helpers do not themselves request signatures. `prepare`
composes existing build/qualification; `announce` summarizes the frozen data;
`subjects` rechecks and emits exact subjects; `admit` rechecks the current
context; `retain` copies original action bundle bytes; `verify` composes service
observations with offline proof verification. Imports perform none of these
operations. Caller-supplied context and locally matching JSON are not evidence
of a real GitHub execution.

## Transfer, client and failures

Data and proofs have separate immutable upload IDs and SHA-256 digests. Names
include run and attempt. There is no overwrite, latest-by-name selection or
cross-run fallback. Download digest mismatch is fatal; received contents and
candidate/proof identities are also checked. Artifact metadata corroborates
the run and source, while the fixed recipe and context bind attempt 1; the
artifact API alone does not independently certify an attempt. Each upload
requests 90 days. Observe its actual expiry and copy admitted originals before
that expiry: requested retention is not an archival or durability guarantee.

Preparation data is bounded to 128 MiB by artifact admission, each original
proof to 16 MiB, and each retained API/root-client output to 2 MiB. Local data
inspection bounds the compressed archive and uses the shared archive/static
reader. These are finite experimental acceptance limits, not measured runtime
memory, decompression or aggregate service storage guarantees. The job limits
are 20 minutes for preparation and 10 each for signing and verification.

The optional CI-only `scripts/prepare_provenance_client.py` selects Linux
x86-64 gh 2.102.0 from the official release archive, checks its exact 15,319,960
compressed bytes and admitted SHA-256 before reading the one regular binary,
and records that binary's separate hash. It never adopts an existing output
directory or extracts archive paths to the filesystem. TLS, the admitted
upstream archive and hosted platform remain premises. Synthetic installer
tests do not qualify the actual platform binary. This setup is not part of
default CI, library use or ordinary development installation.

The identified client executes the documented
[`gh attestation trusted-root --hostname github.com`](https://cli.github.com/manual/gh_attestation_trusted-root)
in fresh isolated client state, with no inherited credentials/proxies. This
one root acquisition is online; exact output must match the input hash. Proof
verification then uses the original local root and bundles offline. API reads
use an explicit read token at fixed `api.github.com` routes, reject redirects,
bound each body and make no application retry. The HTTP library/service owns
transport behavior; this recipe does not recreate a bounded wire laboratory.

If one signature fails, preserve any first bundle and mark missing/failed
results; never synthesize a second proof or declare completion. Qualification,
packet substitution, mismatched service identity, missing/expired artifacts,
root mismatch or proof failure blocks success. A failed upload or cancellation
can leave unknown remote effects: inspect the same run and admitted originals
before authorizing any new run. There is no automatic retry, re-sign, deletion
or publication recovery. A verification failure retains safe diagnostics when
its output directory exists; infrastructure failures can prevent conservation.

## Qualification boundary

Local tests exercise finite synthetic packets, injected API responses, a
controlled client adapter, missing/changed proof bytes and workflow mutations.
They do not prove cryptography, real producer interoperability, effective
approval/permission enforcement, hosted image compatibility or service
retention. A successful offline report also retains its explicit unqualified
operational/release fields. Admission of those properties requires the separate
authorized real trial and independent inspection of its originals and settings.
Publication, the first human npm publication, publisher OIDC qualification,
serialized release recording and the public release remain outside this recipe.
