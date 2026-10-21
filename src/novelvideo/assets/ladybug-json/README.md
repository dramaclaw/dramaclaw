# Ladybug JSON extension

Ladybug loads its JSON extension from a per-user cache and downloads it from
`extension.ladybugdb.com` on first use. That server no longer hosts the Ladybug
version this project pins, so the download fails with HTTP 404. The application
loads these files by absolute path instead (`novelvideo.ladybug_json_extension`).

- `<version>/libjson-<platform>.lbug_extension`: the unmodified upstream
  libraries, one per platform, with checksums in `<version>/SHA256SUMS`.
- `LICENSE.txt`: the upstream MIT notices for Ladybug and the bundled yyjson.

The files were recovered from the upstream extension-server image
`ghcr.io/ladybugdb/extension-repo` at a digest built before the removal; see
https://github.com/dramaclaw/ci-assets for the recovery workflow and the same
files as release assets. Two of them match, byte for byte, copies downloaded
from `extension.ladybugdb.com` while it still served this version.

When upgrading Ladybug, add the new version's files here in the same layout.
`python -m novelvideo.ladybug_json_extension` fails until they match the
installed Ladybug version.
