// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface ReferenceIssue {
  media: string;
  index: number;
  name: string;
  reference_key: string;
  code: string;
  actual?: unknown;
  expected?: unknown;
  nodeId?: string;
  label?: string;
  role?: string;
}

export function referenceIssues(error: unknown): ReferenceIssue[] {
  const body = (error as { body?: { detail?: { code?: string; errors?: unknown } } })?.body;
  const detail = body?.detail;
  if (detail?.code !== "REFERENCE_MEDIA_INVALID" || !Array.isArray(detail.errors)) return [];
  return detail.errors.filter((item): item is ReferenceIssue =>
    item && typeof item.code === "string" && typeof item.reference_key === "string"
    && typeof item.media === "string" && typeof item.index === "number",
  );
}

