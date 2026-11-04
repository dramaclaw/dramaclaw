#!/usr/bin/env bash
# Keep old automation from reinstalling a retired runtime.
set -euo pipefail
printf '%s\n' 'Hermes runtime has been retired. Use scripts/start-ce.sh to start DramaClaw with the verified Codex runtime.' >&2
exit 2
