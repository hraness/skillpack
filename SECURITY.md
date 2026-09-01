# Security policy

## Reporting

Do not open a public issue for a credential exposure, arbitrary command
execution, path escape, or skill prompt-injection vulnerability. Report it to
the repository maintainers through the private security-reporting channel of
the canonical hosting project. Include the affected revision, reproduction,
impact, and whether a safe public test exists.

## Trust model

Skills are untrusted instructions until reviewed. A clean schema check or
static scan does not authorize commands, network access, credentials, or file
mutation. Review source locks and diffs, pin exact revisions, use least
privilege, and test adoption against disposable local fixtures first.

The included management helpers:

- do not execute skill content or shell fragments;
- require explicit source and destination paths;
- default to read-only preview;
- reject symbolic links and path escapes;
- refuse differing destinations unless repair is explicit;
- back up repaired content and never delete destination files.

Release artifacts should be built from the checked revision and accompanied by
the validation result and source inventory. Compromise of an upstream source
after the pinned revision does not change the checked tree, but a new source
revision requires a fresh review.
