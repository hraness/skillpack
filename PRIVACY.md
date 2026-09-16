# Privacy policy

Effective: 2026-09-16

Hraness Agent Skills is a static, publicly reviewable distribution of
instructions, resources, and local helper scripts. The distribution does not operate a
hosted service, create user accounts, collect analytics, transmit prompts, or
store personal data.

The audit, adoption and repair helpers operate only on paths explicitly supplied
by the user. They do not read credentials, make network requests, or send
telemetry. Preview and audit modes do not write files. Repair mode writes only
to the selected destination and its adjacent backup directory after explicit
authorization.

The separate optional support helper stores only invitation cadence, temporary
claim receipts and opt-out preferences in the shared local Hraness support
state directory. Its protocol read does not write. It does not inspect skill
contents, Git email, credentials, accounts or billing state, and makes no
network requests. Opening its public support link is a separate human choice;
the account website has its own privacy policy.

Agent hosts, Git providers, package managers, and public registries used to
download or run these skills are independent services with their own privacy
practices. In particular, skills.sh documents anonymous installation telemetry
for its CLI unless a user disables it. That telemetry is not collected or
received by Hraness Agent Skills.

GitHub issues and discussions are public. Do not include credentials, private
repository content, or other sensitive information in them. Report security
issues through the private process described in [SECURITY.md](SECURITY.md).

Material changes to this policy will be committed to the public repository and
included in the release history.
