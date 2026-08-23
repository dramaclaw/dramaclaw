// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type SpineTemplate = "drama" | "narrated";

export interface ProjectConfig {
  spine_template?: SpineTemplate;
  aspect_ratio?: "2:3" | "9:16" | "16:9";
  visual_style?: string;
  narration_style?: string;
  ethnicity?: string;
  rhythm?: string;
  tts_provider?: string;
  tts_model?: string;
  tts_voice?: string;
  grid_mode?: string;
  grid_model?: string;
  video_backend?: string;
  use_director_render?: boolean;
  video_resolution?: string;
  add_subtitles?: boolean;
  sketch_image_selection?: string;
  render_image_selection?: string;
  sketch_aspect_padding?: boolean;
  // Server-computed: whether a project-level scene build can produce anything.
  // Narrated structured projects have no scene headings to build a catalogue
  // from, so their scenes are created per episode during planning instead.
  // Absent on older responses, which is why callers treat undefined as true.
  readonly scene_build_supported?: boolean;
}

export type Project = string;

// Project lifecycle states. Mutually exclusive.
//   active   — working state (default)
//   archived — parked for reference, hidden from Active view
//   deleted  — soft-deleted, recoverable from Trash
export type ProjectStatus = "active" | "archived" | "deleted";

export type ProjectRole = "viewer" | "editor" | "admin" | "owner";

export interface ProjectSummary {
  id: string;
  name: string;
  status: ProjectStatus;
  ownerUsername?: string;
  ownerId?: string;
  ownerType?: "user" | "team";
  effectiveRole?: ProjectRole;
  homeNodeId?: string;
  archivedAt?: string; // ISO8601 timestamp
  deletedAt?: string; // ISO8601 timestamp
  updatedAt?: string; // ISO8601 timestamp — latest mutation on the project
  episodeCount?: number; // number of planned episodes (null for Trash)
  beatCount?: number; // number of beats across all episodes (null for Trash)
  // TODO(backend): createdAt when API returns it.
}
