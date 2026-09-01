# Semantic Algos

Portable, explicit-only Agent Skills for repeatable semantic computation over
questions and authorized text.

The plugin adapts Rob Cheung's `semantic-algos` standard library. It includes
the individual reasoning operators plus `sem-compile`, `sem-run`, and
`sem-present`. The upstream `five-whys` preset is folded into `n-whys`; invoke
`$n-whys` with depth 5 instead of routing through a competing skill.

Every Codex skill sets `policy.allow_implicit_invocation: false`; invoke an
operator as `$skill-name`. Cursor installs thin explicit slash-command adapters
from `commands/` and intentionally suppresses automatic discovery of the
canonical skills; invoke the same operator as `/skill-name`. This split is
necessary because Codex and Cursor express explicit-only behavior in different
metadata locations. The adapters point back to the one canonical `skills/`
source and contain no duplicate procedure.

The operators do not route ordinary coding, repository analysis, testing,
delivery, or operations. Semantic runs may write their declared Markdown
artifacts, but do not authorize external effects.

The pinned upstream revision has no published license file. This adaptation is
attributed to Rob Cheung and is used with permission; it is not described as
MIT-licensed. See [PROVENANCE.md](PROVENANCE.md).
