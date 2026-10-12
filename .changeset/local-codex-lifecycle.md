---
'skills-installer': minor
---

Add the project-local Codex lifecycle: add a directory with `-a codex`, list managed
skills, and remove an installation without deleting its source. Store a shared copy,
relative Codex link, and portable lock; protect local edits with `--force`, reject
foreign destinations, and roll back handled failures before state commit.
