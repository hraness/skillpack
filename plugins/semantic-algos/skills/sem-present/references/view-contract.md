# Sem run view contract

`view/manifest.json` is a projection, not authoritative run state. Use a
top-level object with:

- `kind: sem-run-view`;
- a supported `schemaVersion` in the `1.x` family;
- RFC 3339 `generatedAt`;
- `run` with title, terminal or snapshot status, and snapshot flag;
- arrays of artifacts, nodes, edges, groups, and warnings;
- presentation roots and panels;
- an extensions object.

Every ID is unique and stable within the manifest. Every artifact path is a
forward-slash relative path contained by the named run root: reject absolute
paths, schemes, backslashes, empty segments, `.` or `..`, symlink escape, and
directory targets. Every node, edge, group, panel, and presentation root must
reference an existing declared ID.

Use explicit status from application records. A nonterminal run can be
projected only as a snapshot and must retain pending/running state. A terminal
projection may be `succeeded`, `failed`, `blocked`, or `partial`.

`view/notes.md` records the named source run, validation result, inferences,
warnings, unsupported extensions, and whether the projection is a snapshot.
Never rewrite request, program, interpretation, status, result, or final files
to make a projection validate.
