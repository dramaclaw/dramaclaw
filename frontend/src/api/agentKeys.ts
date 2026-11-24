// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { apiCall } from "./client";

// Agent keys let external MCP clients call this service on the user's behalf.
// Only servers that support agent keys expose these routes; CE servers do not.

export interface AgentKeySummary {
  id: string;
  label: string;
  agent_kind: string;
  scopes: string[];
  max_ttl_seconds: number;
  /** Empty means every project the user owns. */
  allowed_projects: string[];
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** The plaintext `key` is returned exactly once, by the create call. */
export interface CreatedAgentKey {
  id: string;
  key: string;
  label: string;
  agent_kind: string;
  scopes: string[];
  max_ttl_seconds: number;
}

export const AGENT_KEY_KIND = "external-mcp";
export const AGENT_KEY_LABEL_MAX_LENGTH = 120;

export async function listAgentKeys(): Promise<AgentKeySummary[]> {
  return (await apiCall<AgentKeySummary[]>("agent/keys")) ?? [];
}

export async function createAgentKey({
  label,
  allowedProjects,
}: {
  label: string;
  allowedProjects: string[];
}): Promise<CreatedAgentKey> {
  return await apiCall<CreatedAgentKey>("agent/keys", {
    method: "POST",
    json: { label, agent_kind: AGENT_KEY_KIND, allowed_projects: allowedProjects },
  });
}

export async function revokeAgentKey(id: string): Promise<{ id: string; revoked: boolean }> {
  return await apiCall<{ id: string; revoked: boolean }>(
    `agent/keys/${encodeURIComponent(id)}/revoke`,
    { method: "POST" },
  );
}
