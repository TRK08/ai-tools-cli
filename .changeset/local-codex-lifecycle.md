---
'skills-installer': minor
---

Add the project-local Codex lifecycle: add a directory with `-a codex`, list managed
skills, and remove an installation without deleting its source. Store a shared copy,
direct Codex directory in `.agents/skills`, and root `skills-installer-lock.json`;
protect local edits with `--force`, reject foreign destinations, and roll back
handled failures in a temporary operation workspace without permanent tmp/backups.
