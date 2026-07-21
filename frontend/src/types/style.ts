// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Style descriptor. Two response shapes coexist:
 *  - List endpoint (`GET /styles`) returns metadata only:
 *    `{ id, name, label, type }`
 *  - Single endpoint (`GET /styles/{id}`) returns the full record with all
 *    config fields at the top level (NOT nested under `config`).
 *
 * The optional `config` wrapper is kept for create/analyze payloads
 * (`POST /styles` accepts `{ id, name, project, config: {...} }`).
 */
export interface Style {
  id: string;
  name: string;
  label?: string;
  type?: "preset" | "custom";
  is_preset?: boolean;
  base?: string | null;
  // Top-level config fields (returned by single GET).
  style_instructions?: string;
  avoid_instructions?: string;
  style_tag?: string;
  created_at?: string | null;
  created_by?: string | null;
  preview_path?: string | null;
  preview_url?: string | null;
  // Nested config used by create/analyze flows.
  config?: Record<string, unknown>;
}
