---
'skills-installer': minor
---

Add a live find command querying the backend with a literal case-sensitive slugPrefix. Require at least two characters and show only slug, version and install count in interactive rows and non-TTY tables. Debounce edits, abort obsolete requests, ignore stale responses, show loading/errors and allow retry. Preserve Clack styling, popularity ordering, scrolling and installation of the reviewed version with latest update policy through the usual agent picker. Explicit add slug@version still pins exact. Support an initial prefix, scoped installation, force and statistics opt-out; use the same backend search for a read-only table without TTY. Replace search with find; show registry descriptions in the installation card. Preserve registry URL priority and report API failures separately from empty results.

Send bounded best-effort v1 download/install events for registry add/update, once per skill operation regardless of agent count. Skip unchanged, metadata-only and pinned operations, local sources and cancellation. Support --without-stat, DISABLE_TELEMETRY, DO_NOT_TRACK and SKILLS_TELEMETRY_ENDPOINT without changing installation outcomes.

Exclude project restore from the MVP scope as requested; retain task numbering and continue task 010 from approved task 008.

Unify add/find installation flow: select scope, select agents, show detailed selected-version metadata and actual per-agent paths, then confirm with No as the default. Honor explicit global/agent flags; add --yes for scripted installs and confirmation opt-out. Cancel preparation and metadata without installation events, preserve reviewed registry artifacts and local snapshots, and clean temporary data on decline.

Make remove interactive: select multiple managed skills without names, or pass several names directly, then review versions and affected agents and confirm the entire selection with No as the default. Add --yes for scripted removal; preserve the skill picker when names are omitted. Filter by scope and agents, skip unmatched names, continue after individual failures and show a results table. Preserve new connections added during confirmation, foreign objects, source files and independent scopes without network requests or telemetry.
