// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Backend bakes the upstream request id into error messages as
// `request_id=<id>; ...`. Pull it out so it can be surfaced prominently in the
// failure UI — it's the single most useful handle for diagnosing a bad run.
export function extractRequestId(message: string | null | undefined): string | null {
  if (!message) return null;
  const match = message.match(
    /(?:request[_\s-]*id\s*[=:]\s*|request\s+id\s*:\s*)([a-zA-Z0-9._:-]+)/i,
  );
  return match ? match[1].replace(/[)}\]]+$/, '') : null;
}
