---
'skills-installer': minor
---

Support local .tar.gz and .tgz skills in project and global scopes through the
existing agent selector and installation lifecycle. Validate archive paths,
entry types, gzip/tar completeness and actual size/count limits before writing
prepared files. Preserve binary resources and executable file modes, record the
permanent archive source and SHA-256, and keep prior installations on preparation
failure. Repacked identical content updates its archive digest without replacing
the installed directory.
