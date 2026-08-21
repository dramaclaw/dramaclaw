// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface OrgBrandingResponse {
  schema_version: 1;
  organization: { org_id: string; name: string } | null;
  branding: { logo_url: string; updated_at: string } | null;
}
