// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { InviteListParams } from "@/types/org";

export function normalizeInviteSearch(
  search: Record<string, unknown>,
): InviteListParams {
  const normalized: InviteListParams = {};
  if (["pending", "expired", "revoked", "accepted"].includes(String(search.status))) {
    normalized.status = search.status as InviteListParams["status"];
  }
  if (["created_at", "expires_at", "status"].includes(String(search.sort))) {
    normalized.sort = search.sort as InviteListParams["sort"];
  }
  if (search.dir === "asc" || search.dir === "desc") normalized.dir = search.dir;
  if (
    typeof search.limit === "number" &&
    Number.isInteger(search.limit) &&
    search.limit >= 1 &&
    search.limit <= 100
  ) {
    normalized.limit = search.limit;
  }
  if (
    typeof search.offset === "number" &&
    Number.isInteger(search.offset) &&
    search.offset >= 0
  ) {
    normalized.offset = search.offset;
  }
  return normalized;
}
