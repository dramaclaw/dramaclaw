// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { MemberListParams } from "@/types/org";

export function normalizeMemberSearch(
  value: Record<string, unknown>,
): MemberListParams {
  const result: MemberListParams = {};
  if (
    typeof value.status === "string" &&
    ["active", "suspended", "left"].includes(value.status)
  ) {
    result.status = value.status as NonNullable<MemberListParams["status"]>;
  }
  if (
    typeof value.role === "string" &&
    ["org_admin", "org_member"].includes(value.role)
  ) {
    result.role = value.role as NonNullable<MemberListParams["role"]>;
  }
  if (typeof value.q === "string" && value.q.length <= 100) result.q = value.q;
  if (
    typeof value.sort === "string" &&
    ["username", "created_at", "updated_at", "role", "status"].includes(value.sort)
  ) {
    result.sort = value.sort as NonNullable<MemberListParams["sort"]>;
  }
  if (
    typeof value.dir === "string" &&
    ["asc", "desc"].includes(value.dir)
  ) {
    result.dir = value.dir as NonNullable<MemberListParams["dir"]>;
  }
  if (
    typeof value.limit === "number" &&
    Number.isInteger(value.limit) &&
    value.limit >= 1 &&
    value.limit <= 100
  ) {
    result.limit = value.limit;
  }
  if (
    typeof value.offset === "number" &&
    Number.isInteger(value.offset) &&
    value.offset >= 0
  ) {
    result.offset = value.offset;
  }
  return result;
}
