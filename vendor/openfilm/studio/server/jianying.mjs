// @ts-check
/**
 * The film as a 剪映 (Jianying Pro) or CapCut draft (the same editor, one for China, one for elsewhere, with the same
 * drafts in their own folders): the editor's timeline (nle.mjs planNleTimeline, the same plan the XML is
 * written from) as the draft folder 剪映 lists on its home screen, so the film opens there as a project, ready to keep
 * cutting. exports.mjs makes the media the plan asks for; this file only writes the draft's JSON, so it can be
 * checked on its own.
 *
 * What 剪映 reads (tested with 剪映 11.6 on macOS): a folder in its drafts folder with `draft_info.json` (what Windows
 * calls `draft_content.json`; both are written) and `draft_meta_info.json`, plain JSON. 剪映 saves its own drafts
 * encrypted, but opens a plain one and saves it encrypted from then on. CapCut keeps its drafts plain; a draft says
 * which of the two wrote it.
 *
 * The rules:
 *   · Times are microseconds: a clip's frames on the plan's rate, rounded edge by edge, so two clips back to back
 *     share their cut.
 *   · A picture is fitted whole inside the canvas first (as 剪映 places anything new), then scaled: `scale` is the
 *     plan's Basic Motion over that fit; its place is in half-canvas units, y upward.
 *   · Footage keeps its own sound: the sound clip linked to it in the plan becomes the video clip's level, so nothing
 *     plays twice. Other sounds are audio clips, their fades 剪映's own fades.
 *   · A hidden track's clips come hidden, a muted track's sounds muted, one click from back on.
 *   · Subtitles are text clips on a track of their own, white with a dark edge, low in the picture.
 *   · Each file is in the draft's media library (draft_meta_info.json `draft_materials`, group 0, what the app lists
 *     under its media panel), and each material names its entry there (`local_material_id`): without it the app
 *     lists none of them and finds a video by nothing but its path.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * @typedef {import('./nle.mjs').NleTimeline} NleTimeline
 * @typedef {import('./nle.mjs').NleClip} NleClip
 * @typedef {import('./nle.mjs').NleFile} NleFile
 * @typedef {{ text: string, startMs: number, durMs: number }} JianyingCue
 */

/** @typedef {'jianying' | 'capcut'} DraftApp */

/** Each app's folder, in Movies on a Mac and in the local app data on Windows. */
const APP_FOLDER = /** @type {Record<DraftApp, string>} */ ({ jianying: 'JianyingPro', capcut: 'CapCut' });

/**
 * Where 剪映 or CapCut keeps its drafts by default (its Settings › Drafts location can move them): the folder when it
 * is there, else null.
 * @param {DraftApp} app
 * @param {{ platform?: NodeJS.Platform, home: string, localAppData?: string, exists: (path: string) => boolean }} where
 */
export function draftsRoot(app, { platform = process.platform, home, localAppData, exists }) {
  const base = platform === 'darwin' ? join(home, 'Movies') : platform === 'win32' ? localAppData ?? join(home, 'AppData', 'Local') : null;
  const dir = base && join(base, APP_FOLDER[app], 'User Data', 'Projects', 'com.lveditor.draft');
  return dir && exists(dir) ? dir : null;
}

/** 剪映 ids: 32 hex digits for materials and clips, an upper-case UUID for the draft. */
const hex = () => randomUUID().replace(/-/g, '');

/** A photo's length in 剪映: three hours, so any clip of it fits. */
const PHOTO_US = 10_800_000_000;

/** The material kinds an empty draft lists (剪映 reads the draft whether or not they are there). */
const MATERIAL_KINDS = [
  'ai_translates', 'audio_balances', 'audio_effects', 'audio_fades', 'audio_track_indexes', 'audios', 'beats', 'canvases',
  'chromas', 'color_curves', 'digital_humans', 'drafts', 'effects', 'flowers', 'green_screens', 'handwrites', 'hsl', 'images',
  'log_color_wheels', 'loudnesses', 'manual_deformations', 'masks', 'material_animations', 'material_colors',
  'multi_language_refs', 'placeholders', 'plugin_effects', 'primary_color_wheels', 'realtime_denoises', 'shapes',
  'smart_crops', 'smart_relights', 'sound_channel_mappings', 'speeds', 'stickers', 'tail_leaders', 'text_templates', 'texts',
  'time_marks', 'transitions', 'video_effects', 'video_trackings', 'videos', 'vocal_beautifys', 'vocal_separations',
];

/** The app a draft says wrote it: for 剪映 the one tested to open as a plain draft; CapCut's own id for CapCut. */
const PLATFORM = /** @type {Record<DraftApp, object>} */ ({
  jianying: { app_id: 3704, app_source: 'lv', app_version: '5.9.0', os: 'windows' },
  capcut: { app_id: 359289, app_source: 'cc', app_version: '5.9.0', os: 'windows' },
});

/** A clip's picture settings: none (as placed), or scaled and moved. */
const clipSettings = (/** @type {number} */ scale, /** @type {number} */ x, /** @type {number} */ y) => ({
  alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: scale, y: scale }, transform: { x, y },
});

const round6 = (/** @type {number} */ n) => { const r = Math.round(n * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };

/**
 * The draft: `info` (draft_info.json) and `meta` (draft_meta_info.json), for the folder `folder` in the app's drafts
 * folder `root`.
 * @param {NleTimeline} timeline
 * @param {{ app?: DraftApp, name: string, folder: string, root: string, cues?: readonly JianyingCue[], now?: number }} opts
 */
export function jianyingDraft(timeline, opts) {
  const platform = PLATFORM[opts.app ?? 'jianying'];
  const fps = timeline.rate.fps;
  /** frame → microseconds, on the plan's rate */
  const us = (/** @type {number} */ frame) => Math.round((frame * 1e6) / fps);
  const span = (/** @type {number} */ from, /** @type {number} */ to) => ({ start: us(from), duration: us(to) - us(from) });
  const files = new Map(timeline.files.map((f) => [f.id, f]));
  /** @type {Record<string, any[]>} */
  const materials = Object.fromEntries(MATERIAL_KINDS.map((k) => [k, []]));
  /** @type {Map<string, string>} one material a file, however many clips use it */
  const materialOf = new Map();
  /** @type {Record<string, unknown>[]} the media library: one entry a file */
  const library = [];
  /** @type {Map<string, string>} a file's entry in the library, by its path */
  const entryOf = new Map();
  const register = (/** @type {NleFile} */ file, /** @type {'video' | 'photo' | 'music'} */ kind, /** @type {string} */ name) => {
    const known = entryOf.get(file.path);
    if (known) return known;
    const id = randomUUID().toUpperCase();
    library.push({
      ai_group_type: '', create_time: -1, duration: kind === 'photo' ? 5_000_000 : us(file.durationFrames), enter_from: 0,
      extra_info: name, file_Path: file.path, height: file.video?.h ?? 0, id, import_time: -1, import_time_ms: -1, item_source: 1,
      material_color_tag: '', md5: '', metetype: kind, roughcut_time_range: { duration: -1, start: -1 },
      sub_time_range: { duration: -1, start: -1 }, type: 0, width: file.video?.w ?? 0,
    });
    entryOf.set(file.path, id);
    return id;
  };

  const material = (/** @type {NleFile} */ file, /** @type {'video' | 'audio'} */ media) => {
    const key = `${media}:${file.id}`;
    const known = materialOf.get(key);
    if (known) return known;
    const id = hex();
    const name = file.path.split(/[\\/]/).pop() ?? file.name;
    if (media === 'video') {
      const still = Boolean(file.video?.still);
      materials.videos.push({
        audio_fade: null, category_id: '', category_name: 'local', check_flag: 63487,
        crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 },
        crop_ratio: 'free', crop_scale: 1, duration: still ? PHOTO_US : us(file.durationFrames),
        height: file.video?.h ?? timeline.height, width: file.video?.w ?? timeline.width,
        id, local_material_id: register(file, still ? 'photo' : 'video', name), material_id: id, material_name: name, media_path: '',
        path: file.path, type: still ? 'photo' : 'video',
      });
    } else {
      materials.audios.push({
        app_id: 0, category_id: '', category_name: 'local', check_flag: 3, copyright_limit_type: 'none',
        duration: us(file.durationFrames), effect_id: '', formula_id: '', id, local_material_id: register(file, 'music', name), music_id: id,
        name, path: file.path,
        source_platform: 0, type: 'extract_music', wave_points: [],
      });
    }
    materialOf.set(key, id);
    return id;
  };
  const speed = () => {
    const id = hex();
    materials.speeds.push({ curve_speed: null, id, mode: 0, speed: 1, type: 'speed' });
    return id;
  };

  /** @type {Record<string, any>[]} */
  const tracks = [];
  let renderIndex = 0;
  const segment = (/** @type {Record<string, any>} */ fields) => ({
    enable_adjust: true, enable_color_correct_adjust: false, enable_color_curves: true, enable_color_match_adjust: false,
    enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false, last_nonzero_volume: 1, reverse: false,
    track_attribute: 0, track_render_index: 0, visible: true, id: hex(), common_keyframes: [], keyframe_refs: [],
    speed: 1, volume: 1, is_tone_modify: false, ...fields,
  });

  /* footage's own sound, by the picture it belongs to: the video clip plays it at its level */
  /** @type {Map<string, number>} linkGroup → level */
  const ownSound = new Map();
  for (const t of timeline.audio) {
    for (const c of t.clips) if (c.linkGroup && !c.levels) ownSound.set(c.linkGroup, t.enabled && c.enabled ? c.gain ?? 1 : 0);
  }

  /* pictures: the plan's first track is the bottom one, as 剪映's first video track (its main track) is */
  for (const t of timeline.video) {
    const index = renderIndex++;
    tracks.push({
      attribute: 0, flag: 0, id: hex(), is_default_name: false, name: t.name, type: 'video',
      segments: t.clips.map((c) => {
        const file = /** @type {NleFile} */ (files.get(c.fileId));
        const w = file.video?.w ?? timeline.width, h = file.video?.h ?? timeline.height;
        /* 剪映 first fits it whole in the canvas; the plan's scale is of its own pixels, 100 when none */
        const fit = Math.min(timeline.width / w, timeline.height / h);
        const scale = round6((c.motion ? c.motion.scale / 100 : 1) / fit);
        const x = round6((c.motion?.center.h ?? 0) * 2), y = round6(-(c.motion?.center.v ?? 0) * 2);
        const level = c.linkGroup && ownSound.has(c.linkGroup) ? /** @type {number} */ (ownSound.get(c.linkGroup)) : 0;
        return segment({
          material_id: material(file, 'video'), target_timerange: span(c.start, c.end),
          source_timerange: file.video?.still ? { start: 0, duration: us(c.end) - us(c.start) } : span(c.in, c.out),
          visible: t.enabled && c.enabled, volume: level, last_nonzero_volume: level || 1,
          extra_material_refs: [speed()], clip: clipSettings(scale, x, y), uniform_scale: { on: true, value: 1 },
          hdr_settings: { intensity: 1, mode: 1, nits: 1000 }, render_index: index,
        });
      }),
    });
  }

  /* sounds: footage's own are already its picture's */
  for (const t of timeline.audio) {
    const clips = t.clips.filter((c) => !(c.linkGroup && ownSound.has(c.linkGroup) && timeline.video.some((v) => v.clips.some((p) => p.linkGroup === c.linkGroup))));
    if (!clips.length) continue;
    const index = renderIndex++;
    tracks.push({
      attribute: t.enabled ? 0 : 1, flag: 0, id: hex(), is_default_name: false, name: t.name, type: 'audio',
      segments: clips.map((c) => {
        const file = /** @type {NleFile} */ (files.get(c.fileId));
        const level = c.levels ? Math.max(...c.levels.map((k) => k.value)) : c.gain ?? 1;
        const refs = [speed()];
        /* a fade: the plan's level keyframes (silent at an end) as 剪映's fade in and out */
        if (c.levels && c.levels.length > 1) {
          const keys = c.levels;
          const fadeIn = keys[0].value === 0 ? keys[1].when : 0;
          const last = keys[keys.length - 1];
          const fadeOut = last.value === 0 ? last.when - keys[keys.length - 2].when : 0;
          if (fadeIn > 0 || fadeOut > 0) {
            const id = hex();
            materials.audio_fades.push({ id, fade_in_duration: us(fadeIn), fade_out_duration: us(fadeOut), fade_type: 0, type: 'audio_fade' });
            refs.push(id);
          }
        }
        return segment({
          material_id: material(file, 'audio'), target_timerange: span(c.start, c.end), source_timerange: span(c.in, c.out),
          volume: c.enabled ? round6(level) : 0, last_nonzero_volume: round6(level) || 1,
          extra_material_refs: refs, clip: null, hdr_settings: null, render_index: index,
        });
      }),
    });
  }

  /* subtitles: a text track over everything */
  const cues = (opts.cues ?? []).filter((c) => c.text.trim() && c.durMs > 0);
  if (cues.length) {
    const index = renderIndex++;
    const frame = (/** @type {number} */ ms) => Math.round((ms / 1000) * fps);
    tracks.push({
      attribute: 0, flag: 0, id: hex(), is_default_name: false, name: 'Subtitles', type: 'text',
      segments: cues.map((cue) => {
        const id = hex();
        const text = cue.text.trim();
        materials.texts.push({
          id, type: 'text', typesetting: 0, alignment: 1, letter_spacing: 0, line_spacing: 0.02, line_feed: 1,
          line_max_width: 0.82, force_apply_line_max_width: false, check_flag: 15, global_alpha: 1,
          content: JSON.stringify({
            styles: [{
              fill: { alpha: 1, content: { render_type: 'solid', solid: { alpha: 1, color: [1, 1, 1] } } },
              range: [0, [...text].length], size: 6, bold: false, italic: false, underline: false,
              strokes: [{ content: { render_type: 'solid', solid: { alpha: 1, color: [0, 0, 0] } }, width: 0.08 }],
            }],
            text,
          }),
        });
        const from = frame(cue.startMs), to = Math.max(from + 1, frame(cue.startMs + cue.durMs));
        return segment({
          material_id: id, target_timerange: span(from, to), source_timerange: null, extra_material_refs: [],
          clip: clipSettings(1, 0, -0.8), uniform_scale: { on: true, value: 1 }, render_index: index,
        });
      }),
    });
  }

  const duration = us(timeline.durationFrames);
  const draftId = randomUUID().toUpperCase();
  const now = opts.now ?? Date.now();
  const info = {
    canvas_config: { width: timeline.width, height: timeline.height, ratio: 'original' },
    color_space: 0,
    config: {
      adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1,
      lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [], maintrack_adsorb: false, material_save_mode: 0,
      multi_language_current: 'none', multi_language_list: [], multi_language_main: 'none', multi_language_mode: 'none',
      original_sound_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_keywords_config: null,
      subtitle_recognition_id: '', subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [], video_mute: false,
      zoom_info_params: null,
    },
    cover: null, create_time: 0, duration, extra_info: null, fps, free_render_index_mode_on: false, group_container: null,
    id: draftId, keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: platform, platform, materials, mutable_config: null, name: opts.name,
    new_version: '110.0.0', relationships: [], render_index_track_mode_on: false, retouch_cover: null, source: 'default',
    static_cover_image_path: '', time_marks: null, tracks, update_time: 0, version: 360000,
  };
  const meta = {
    cloud_package_completed_time: '', draft_cloud_capcut_purchase_info: '', draft_cloud_last_action_download: false,
    draft_cloud_materials: [], draft_cloud_purchase_info: '', draft_cloud_template_id: '', draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '', draft_cover: '', draft_deeplink_url: '',
    draft_enterprise_info: { draft_enterprise_extra: '', draft_enterprise_id: '', draft_enterprise_name: '', enterprise_material: [] },
    draft_fold_path: opts.folder, draft_id: draftId, draft_is_ai_packaging_used: false, draft_is_ai_shorts: false,
    draft_is_ai_translate: false, draft_is_article_video_draft: false, draft_is_from_deeplink: 'false', draft_is_invisible: false,
    draft_materials: [0, 1, 2, 3, 6, 7, 8].map((type) => ({ type, value: type === 0 ? library : [] })), draft_materials_copied_info: [],
    draft_name: opts.name, draft_new_version: '', draft_removable_storage_device: '', draft_root_path: opts.root,
    draft_segment_extra_info: [], draft_type: '', tm_draft_cloud_completed: '', tm_draft_cloud_modified: 0,
    tm_draft_create: now * 1000, tm_draft_modified: now * 1000, tm_draft_removed: 0, tm_duration: duration,
  };
  return { info, meta };
}
