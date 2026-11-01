# Tabgrad 0.1.1 source and support record

This record identifies ordinary `@tabgrad/tabgrad@0.1.1`, selected npm channel
`latest` and repository tag `v0.1.1`. It defines the version's source and support
boundary under the [release policy](../releases.md). Registry availability,
actual source revision, archive/static inventory, producer proofs and publication
outcome are established separately by the authenticated release evidence.
A version number in source does not establish publication.

## Correction and affected builds

[The build correction](https://github.com/isaacperez/tabgrad/pull/373) makes Cargo
and the browser distribution copy use the same explicit checkout `target/`
directory. Previously an ambient `CARGO_TARGET_DIR` or Cargo configuration could
compile elsewhere while the copy read an older default-directory module,
potentially labelling SIMD bytes as scalar. The corrected build preserves the
two variants and their immediate compile/copy order.

This affects contributors producing browser artifacts with redirected Cargo
output. Use the corrected build source; browser builds now own the output
directory as described in [development](../development.md). Direct Cargo
commands retain their own configuration. The normal published `0.1.0` artifacts
were separately verified; this investigation establishes no defective public
package. A manifest matching copied bytes alone does not prove that those bytes
came from the intended compilation.

The intervening maintainer-tool corrections concern human authentication,
producer-proof association and explicitly approved release-history recovery.
Their [publication](release-publication.md) and [record](release-record.md)
references own those procedures and protocol boundaries. They do not add a
browser runtime API or convert an uncertain earlier publication into success.

## Preserved public support

The [0.1.0 source and support record](release-0.1.0.md) remains the complete
versioned API-group table inherited by `0.1.1`: creation/observation, whole-storage
views, equal-shape addition/multiplication, total sum, 2D matrix product,
persistent copy, recording scopes, first-order functional/backward gradients
and basic SGD. Its Python and JavaScript names/signatures, float32 contiguous
domains, CPU/WebGPU distinctions, errors, aliases, differentiation limits and
intentional numerical departures apply unchanged. Support first became public
in `0.1.0`; `0.1.1` adds no operation, overload, dtype, layout or gradient mode.

The overall PyTorch status remains **Partially supported**, against the same
declared PyTorch `2.14.0` oracle and retained fixture metadata. Values, errors,
warnings, identity, aliasing, gradients and partial progress retain their
documented observable contracts. No oracle regeneration or broader native
equivalence is implied. Unavailable operations and **Not evaluated** device or
browser combinations in the inherited record remain so.

The public entries, declarations, matched Wasm/Python assets, Apache-2.0 license
and [application responsibilities](browser-package.md) remain unchanged.
Pyodide `314.0.6` is supplied separately by the application. CPU remains the
default; WebGPU is explicit without silent fallback. Python GPU keeps its
same-origin physical worker and isolation requirements. Updates and restores
replace the complete matching asset tree together.

## Qualification and limits

The correction has producer/copy regression coverage, including stale and
absent default output, plus four real prepared-Cargo cases preserving the
ordinary scalar and SIMD module bytes. Runtime, Python, kernel, toolchain and
conformance inputs are unchanged from that checked correction; reused evidence
is identified by its actual revision rather than described as a new execution.

The `0.1.1` source candidate receives its own
[external package qualification](package-qualification.md): archive/inventory,
metadata, installed/static bytes, public entries/types, CPU assets and the
shipped examples. The source PR records the exact candidate revision and
archive identity, six direct/Python/prerequisite CPU profiles in Chrome
`156.0.8078.79` and Firefox `159.0` on Darwin `25.6.0` arm64, and the two
physical GPU/origin profiles in Chrome. The GPU report identifies the actual
adapter, fallback status, features and limits. An EOF notice does not establish
termination of every browser descendant.

Source checks and package examples are distinct from numerical conformance and
from final publication. Selected CI checks record their actual hosted
environments and execution. The final protected-main producer archive and its
original dual proofs require their own admission; an earlier source candidate
or `0.1.0` proof cannot be relabelled as that subject. Registry consumers are
checked again against the installed version before GitHub completion under the
[publication procedure](release-publication.md).

No general GPU/browser coverage, whole-model compatibility, throughput improvement,
RSS/VRAM bound or exactly-once remote effect follows from this patch.

## Maintenance and migration

When admitted as the latest ordinary release, `0.1.1` supersedes `0.1.0` for
ongoing corrections under the existing default-branch maintenance policy.
There is no separate backport branch, LTS promise or new grace period. The
historical `0.1.0` record remains valid for that version.

Applications need no tensor API migration. Install the exact verified version
and replace its complete matching static files together. Contributors who
previously redirected the browser build's Cargo output use the explicit
checkout directory instead; running Cargo directly remains configurable.
