// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface SceneRef {
  scene_id: string;
  variant_id?: string;
}

export interface EpisodeSceneMenuItem {
  scene_id: string;
  base_scene_id?: string;
  variant_id?: string;
  time_of_day?: string;
}

export interface EpisodePropMenuItem {
  prop_id: string;
  prop_type?: string;
  visual_prompt?: string;
  description?: string;
  owner_identity_id?: string;
  marker_color?: string;
}

export interface Episode {
  number: number;
  title: string;
  summary?: string;
  raw_content?: string;
  beat_source_text?: string;
  content_summary?: string;
  character_names?: string[];
  key_events?: string[];
  cliffhanger?: string;
  identity_ids?: string[];
  identity_default_map?: Record<string, string>;
  scene_menu?: EpisodeSceneMenuItem[];
  prop_menu?: EpisodePropMenuItem[];
  /** 该集已拆出的镜头数，由列表接口一次分组查询带出。未拆镜为 0。 */
  beat_count?: number;
}

export interface Chapter {
  number: number;
  title?: string | null;
  start_line?: number;
  end_line?: number;
  content?: string;
  word_count?: number;
  char_count?: number;
  scene_blocks?: ChapterSceneBlock[];
  /** Zero-based slice offsets for text before the first recognized scene. */
  unparsed_content_start_line?: number;
  unparsed_content_end_line?: number;
}

export interface ChapterSceneBlock {
  header: string;
  scene_no?: string;
  location?: string;
  time_of_day?: string;
  interior_exterior?: string;
  characters?: string[];
  /** Legacy payload field retained for compatibility with older backends. */
  content?: string;
  /** Zero-based slice offsets into Chapter.content.splitlines(). */
  content_start_line?: number;
  content_end_line?: number;
}

export interface Beat {
  beat_number: number;
  narration_segment: string;
  visual_description: string;
  scene_ref?: SceneRef | null;
  location?: string;
  location_description?: string;
  time_of_day?: string;
  speaker?: string;
  audio_type?: string; // "silence" | "narration" | "dialogue"
  video_prompt?: string;
  keyframe_prompt?: string;
  video_mode?: string; // "first_frame" | "keyframe"
  seedance2_config_json?: string;
  estimated_duration?: number;
  /** Identity IDs detected on the sketch for this beat (color-bound). */
  detected_identities?: string[];
  /** Prop IDs detected on the sketch for this beat (color-bound). */
  detected_props?: string[];
  /** True for user-inserted manual shots — only these can be deleted. */
  is_manual_shot?: boolean;
  sketch_url?: string | null;
  frame_url?: string | null;
  video_url?: string | null;
  audio_url?: string | null;
  /** 实测音频时长（秒）；视频时长须 >= 此值，用作时长控件默认值/下限。 */
  audio_duration_seconds?: number | null;
}

export interface PipelineEpisodeStatus {
  episode: number;
  script: boolean;
  sketch: boolean;
  audio: boolean;
  video: boolean;
  compose: boolean;
}

export interface PipelineProjectStatus {
  ingested: boolean;
  configured: boolean;
  characters: number;
  episodes: number;
  portraits_done: boolean;
}

export interface PipelineStepStatus {
  identity_plan?: boolean;
  identity_images?: boolean;
  script?: boolean;
  sketches?: boolean;
  coloring?: boolean;
  global_optimize?: boolean;
  first_frames?: boolean;
  tts?: boolean;
  video?: boolean;
}

export interface PipelineStatus {
  project: string;
  global: PipelineProjectStatus;
  current_episode: number | null;
  episode_status: PipelineStepStatus | null;
  next_step: string;
  next_step_name: string;
}
