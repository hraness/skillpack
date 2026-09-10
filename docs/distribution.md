# Distribution and registry publication

The Git repository is the canonical source. Registries provide discovery and
review; they do not replace source review, immutable releases, or repository
validation.

## Public names

| Distribution ID | Public display name | Audience |
| --- | --- | --- |
| `hraness-engineering` | Repository Engineering by Hraness | General repository work |
| `code-orchestrator` | Phased Delivery | Explicitly multi-phase delivery |
| `semantic-algos` | Semantic Algorithms by Rob Cheung | Explicit semantic transforms |
| `skillpack-admin` | Hraness Skillpack Admin | Optional distribution operators |

Hraness is the publisher. None of these IDs denotes or grants access to the Oompa
product. `skillpack-admin` is intentionally not promoted as a general-purpose
capability plugin in universal directories.

## Channels

| Channel | Publication model | Repository support |
| --- | --- | --- |
| GitHub Agent Skills | `gh skill publish --tag <version>` validates skills and creates a versioned GitHub release | Native |
| GitHub Copilot CLI marketplace | Add `hraness/skillpack`, browse `hraness-skillpack`, and install a selected plugin | Native self-hosted Agent Plugins marketplace |
| GitHub `awesome-copilot` | Submit an immutable external-plugin coordinate through GitHub's reviewed issue workflow | Repository Engineering and Phased Delivery are candidates after v0.2 publication |
| skills.sh | A telemetry-enabled `npx skills add hraness/skillpack` causes the public GitHub repository to be indexed; `skills.sh.json` controls grouping | Native |
| Codex and ChatGPT Plugins Directory | Submit each skills-only capability plugin through OpenAI's reviewed portal | Repository Engineering and Phased Delivery are prepared; `semantic-algos` is deferred pending explicit third-party-directory permission |
| Cursor Marketplace | Submit the public repository for review; Teams and Enterprise can import the same repository as a team marketplace | Three MIT-licensed plugins prepared; `semantic-algos` remains outside the public listing |
| Codex repo marketplace | Add `hraness/skillpack` at an immutable tag and install selected plugins | Native |
| Agent Plugins hosts | Install an individual `plugins/<name>` directory | Native manifests |

The OpenAI and Cursor public directories require an authenticated publisher
submission and independent review. A submitted plugin is not public until the
directory operator approves and the publisher completes publication. OpenAI
also requires a verified publisher identity and Apps Management write access;
the repository packet cannot grant either prerequisite.

The OpenAI packet contains portal-complete positive and negative test details
for all three capability packs, but only Repository Engineering and Phased
Delivery are marked submission-ready. `semantic-algos` remains deferred until
Rob Cheung's permission explicitly covers redistribution and installation
through third-party public directories.

Cursor's public Marketplace requires permissively licensed open-source
components. The root Cursor marketplace therefore lists `skillpack-admin`,
`hraness-engineering`, and `code-orchestrator`, all under MIT. The
`semantic-algos` source remains public here, installable on compatible hosts,
and usable under its attributed permission grant, but it is not submitted to
Cursor unless its author supplies an accepted permissive license. We do not
misrepresent that permission as an open-source license.

## Release publication

1. Run focused validation and the repository aggregate gate on the exact tree.
2. Merge through protected `main` and verify the post-merge `Required` job.
3. Enable and verify GitHub immutable releases before creating the release;
   the setting protects only future releases.
4. Run `gh skill publish --dry-run` on the exact merged tree.
5. Publish the semver tag with `gh skill publish --tag <version>`, record the
   full 40-character commit SHA, and verify that the release is immutable.
6. Run one normal skills.sh CLI install from the public repository to trigger
   indexing, then verify the repository page and grouping after cache refresh.
7. Submit Repository Engineering and Phased Delivery to GitHub's
   `awesome-copilot` external-plugin review using the release tag and full SHA.
8. Submit the two ready capability plugins to OpenAI and the three eligible MIT
   plugins to Cursor. Record submission identifiers and review status here;
   do not submit `semantic-algos` until its recorded permission gate is met.
9. Verify a clean install from every channel that reports publication.

## Registry security boundary

Registry listing is discovery evidence, not a trust grant. Keep source locks,
permission notes, checksums, policy pages, and release validation intact.
Registry installers and agent hosts may collect their own telemetry or request
permissions under their own policies; this repository's helpers do neither.
