# Security policy

Tabgrad executes user-provided Python and tensor operations in a browser and
may process private model inputs and outputs. Please report a vulnerability
privately so that it can be investigated before details expose users.

## Publication confidentiality

This policy applies to all project publication, not only vulnerability reports:
repository files and Git history, issues, pull requests, comments, CI logs,
research evidence, attachments, releases, and externally hosted artifacts.
Permission to publish project work is not permission to disclose private data.

Never publish credentials, sensitive personal or organizational information,
private inputs or outputs, or literal copies or excerpts of messages from
either participant in a private human–assistant conversation. Quoting only
the assistant, removing the speaker's name, or encoding or compressing the
content does not make a private exchange publishable. Do not request an
exception to this prohibition as a way to complete a publication step.

Write self-contained technical requirements, decisions, and evidence summaries
for the intended public audience. A summary is acceptable only when its own
content is safe: paraphrasing does not remove confidential facts. Minimize
identifying context such as private paths, account details, internal addresses,
and machine identifiers; retain only safe environment information that is
necessary to understand or reproduce the result.

Inspect the actual outgoing content before transmission. If it cannot be
inspected or prepared safely, stop that publication and report the limitation
privately. Repository checks and secret scanners can assist inspection but
cannot establish that a payload is free of private context. Apply the shared
[publication procedure](docs/agent-workflow.md#check-content-before-publication)
for evidence, attachments, and publication handoffs.

If an exposure is discovered, stop further disclosure, preserve only the
minimum necessary protected evidence, and notify the owner privately through
the reporting route below. Do not reproduce the exposed material in a public
issue or attempt an unauthorized history rewrite. Removing public content
does not establish that all copies have been recovered.

## Supported versions

Security support applies to the default branch and to releases explicitly
identified as supported in their release metadata. Availability of a tag,
package, or download does not by itself establish security support. Every
release must state its support boundary, and a security advisory must identify
the affected and corrected versions or commits.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/isaacperez/tabgrad/security/advisories/new).
Do not open a public issue, pull request, discussion, test, or log containing
exploit details, private data, credentials, or information that would make the
problem easier to abuse.

If the private form is unavailable, contact the repository owner through a
private channel and ask where to send the report. The initial message should
identify Tabgrad and request a private reporting channel without including the
sensitive details.

Include, when safely available:

- the affected revision, version, browser, backend, and environment;
- the vulnerable behavior and its likely impact;
- the smallest reproduction that does not expose unrelated private data;
- whether the problem is known to be actively exploited;
- suggested mitigations or corrections, if known; and
- a safe way to contact the reporter for follow-up.

Do not test against systems or data that you do not own or have permission to
use. Do not perform denial of service, social engineering, credential access,
privacy invasion, or destructive testing.

## What happens after a report

Maintainers should acknowledge the report when they are able, establish its
scope and severity, preserve confidentiality, and coordinate investigation,
correction, verification, release, and disclosure with the reporter. The
project does not promise a fixed response time unless a published response
policy states one.

Use the smallest group needed to investigate. Do not place sensitive evidence
in ordinary project issues or public CI. Prepare regression coverage without
publishing an exploit before disclosure is safe. A security fix receives the
same independent verification and review as other changes, with additional
specialists when the risk requires them.

The disclosure should state affected versions, impact, mitigation, corrected
versions or commits, and appropriate credit. Delay public details while they
would expose users who have not had a reasonable opportunity to update. Do not
promise a bounty or reward unless a separate published program explicitly
offers one.

## Security and privacy boundaries

Security review includes the browser sandbox, execution of user-provided code,
the Python and JavaScript bridge, worker messages, tensor storage, WebGPU and
CPU memory, package and release integrity, dependencies, examples, development
tools, and any change to where data is processed or retained.

Tabgrad's documented default is local execution. A change that sends code,
tensor data, diagnostics, or identifiers outside the device is a security and
privacy change. It requires explicit design, documentation, user control, and
review; it must not be introduced as silent telemetry or fallback behavior.

Ordinary correctness bugs that do not create a security or privacy risk should
use the public bug form.
