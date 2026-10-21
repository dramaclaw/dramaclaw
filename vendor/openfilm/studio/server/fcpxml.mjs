// @ts-check
import { pathToFileURL } from 'node:url';
import { frameSpan, nleRate, xmlEscape } from './nle.mjs';
import { filmSubtitleCuesInRange, filmSubtitleSequence, filmSubtitleText } from './film-subtitle.mjs';

const STEM_ROLES = { voice: 'dialogue.Voice', footage: 'dialogue.Footage', sfx: 'effects', music: 'music' };
// FCP's bundled template identifier, resolved by FCP on import rather than by the exporting machine.
const BASIC_TITLE = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti';

/**
 * @typedef {import('./nle.mjs').NleClip} NleClip
 * @typedef {{ start: number, end: number, in: number, clip?: NleClip, children: string[] }} PrimarySegment
 * @typedef {{ enabled: boolean, lane: number, offset: number, kind: 'video' | 'audio',
 *   children?: string[], audio?: string[], audioRole?: string }} ClipPlacement
 */

/** XML attributes must preserve whitespace in names; text nodes keep literal line breaks. @param {string} value */
const attribute = (value) => xmlEscape(value)
  .replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');

/** Fill only actual gaps; Studio's lowest picture track stays on the primary storyline.
 * @param {readonly NleClip[]} clips @param {number} durationFrames @returns {PrimarySegment[]}
 */
function primaryStoryline(clips, durationFrames) {
  /** @type {PrimarySegment[]} */
  const segments = [];
  let cursor = 0;
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    if (clip.start < cursor) throw new Error(`primary clips overlap at frame ${clip.start}`);
    if (clip.start > cursor) segments.push({ start: cursor, end: clip.start, in: 0, children: [] });
    segments.push({ start: clip.start, end: clip.end, in: clip.in, clip, children: [] });
    cursor = clip.end;
  }
  if (cursor < durationFrames) segments.push({ start: cursor, end: durationFrames, in: 0, children: [] });
  return segments;
}

/** Connections use their parent's source time, rather than sequence time.
 * @param {readonly PrimarySegment[]} primary @param {number} frame
 */
function connectionAt(primary, frame) {
  const parent = primary.find((segment) => frame >= segment.start && frame < segment.end);
  if (!parent) throw new Error(`no primary storyline segment at frame ${frame}`);
  return { parent, offset: parent.in + frame - parent.start };
}

/**
 * FCPXML 1.10 adapter for the shared NLE plan. Media is prepared by exports.mjs;
 * HTML pages arrive as rendered ProRes clips. FCP roles and connection times belong here.
 * @param {import('./nle.mjs').NleTimeline} timeline
 * @param {{ cues?: readonly import('./film-subtitle.mjs').FilmSubtitleCue[] }} [subtitles]
 */
export function fcpxmlDocument(timeline, { cues = [] } = {}) {
  const { rate, width, height } = timeline;
  /** Exact rational seconds, including 1001-based rates, without decimal time drift. @param {number} frames @param {typeof rate} [r] */
  const time = (frames, r = rate) => `${frames * (r.ntsc ? 1001 : 1)}/${r.timebase * (r.ntsc ? 1000 : 1)}s`;
  const decimal = (/** @type {number} */ n) => String(Math.round(n * 1e6) / 1e6);
  const decibels = (/** @type {number} */ gain) => `${decimal(20 * Math.log10(Math.max(0.000001, gain)))}dB`;
  const format = (/** @type {string} */ id, /** @type {number} */ w, /** @type {number} */ h, r = rate) =>
    `    <format id="${id}" frameDuration="${time(1, r)}" width="${w}" height="${h}" colorSpace="1-1-1 (Rec. 709)"/>`;
  const resources = [format('sequence-format', width, height)];
  for (const file of timeline.files) {
    const video = file.video;
    if (video) resources.push(format(`format-${file.id}`, video.w, video.h, video.fps ? nleRate(video.fps) : rate));
    resources.push(
      `    <asset id="${file.id}" name="${attribute(file.name)}" start="0s" duration="${time(file.durationFrames)}"`
        + (video ? ` hasVideo="1" format="format-${file.id}" videoSources="1"` : '')
        + (file.audio ? ` hasAudio="1" audioSources="1" audioChannels="${file.audio.channels}" audioRate="${file.audio.sampleRate}"` : '') + '>',
      `      <media-rep kind="original-media" src="${attribute(pathToFileURL(file.path).href)}"/>`,
      '    </asset>',
    );
  }
  /** @param {NleClip} clip @param {ClipPlacement} placement */
  const clipXml = (clip, { enabled, lane, offset, kind, children = [], audio = [], audioRole }) => {
    const tag = kind === 'video' ? 'clip' : 'audio';
    const pad = lane === 0 ? '            ' : '              ';
    const attrs = [
      ...(kind === 'audio' ? [`ref="${clip.fileId}"`] : ['format="sequence-format"']), `name="${attribute(clip.name)}"`, `lane="${lane}"`,
      `offset="${time(offset)}"`, `start="${time(clip.in)}"`, `duration="${time(clip.end - clip.start)}"`,
      `enabled="${enabled && clip.enabled ? 1 : 0}"`,
    ];
    if (audioRole) attrs.push(`role="${attribute(audioRole)}"`);
    const lines = [`${pad}<${tag} ${attrs.join(' ')}>`];
    if (kind === 'video') {
      lines.push(`${pad}  <video ref="${clip.fileId}" name="${attribute(clip.name)}" offset="${time(clip.in)}" start="${time(clip.in)}" duration="${time(clip.end - clip.start)}">`);
      // Disable automatic fitting: the planner's scale is relative to the source's own pixels.
      lines.push(`${pad}  <adjust-conform type="none"/>`);
      if (clip.motion) {
        const { scale, center } = clip.motion;
        const position = `${decimal(center.h * width / height * 100)} ${decimal(-center.v * 100)}`;
        lines.push(`${pad}  <adjust-transform position="${position}" scale="${decimal(scale / 100)} ${decimal(scale / 100)}"/>`);
      }
      // FCP keeps footage audio connected when it is nested inside the video component.
      lines.push(...audio, `${pad}  </video>`);
    } else if (clip.levels?.length) {
      lines.push(`${pad}  <adjust-volume>`, `${pad}    <param name="amount">`, `${pad}      <keyframeAnimation>`);
      for (const key of clip.levels) {
        lines.push(`${pad}        <keyframe time="${time(clip.in + key.when)}" value="${decibels(key.value)}"/>`);
      }
      lines.push(`${pad}      </keyframeAnimation>`, `${pad}    </param>`, `${pad}  </adjust-volume>`);
    } else if (clip.gain !== undefined) lines.push(`${pad}  <adjust-volume amount="${decibels(clip.gain)}"/>`);
    return [...lines, ...children, `${pad}</${tag}>`];
  };
  const main = timeline.video[0];
  const primary = primaryStoryline(main?.clips ?? [], timeline.durationFrames);
  const sourceTracks = [...new Set(timeline.audio.flatMap((track) => track.sourceTrack === undefined ? [] : [track.sourceTrack]))]
    .sort((a, b) => a - b);
  const audioRoles = new Map(sourceTracks.map((track, i) => [track, `OpenFilm A${i + 1}`]));
  /** Paired footage sound follows its own picture; unrelated sound stays connected to the primary storyline.
   * @type {Map<string, { start: number, in: number, children: string[] }>}
   */
  const linked = new Map();
  for (const segment of primary) {
    if (!segment.clip?.linkGroup) continue;
    const children = /** @type {string[]} */ ([]);
    linked.set(segment.clip.linkGroup, { start: segment.start, in: segment.in, children });
  }
  const overlays = timeline.video.slice(1).flatMap((track, i) => track.clips.map((clip) => {
    const { parent, offset } = connectionAt(primary, clip.start);
    const audio = /** @type {string[]} */ ([]);
    if (clip.linkGroup) linked.set(clip.linkGroup, { start: clip.start, in: clip.in, children: audio });
    return { clip, parent, offset, lane: i + 1, enabled: track.enabled, audio };
  }));
  timeline.audio.forEach((track, i) => {
    const role = track.role ? STEM_ROLES[track.role] : track.sourceTrack === undefined ? undefined : audioRoles.get(track.sourceTrack);
    for (const clip of track.clips) {
      const audioRole = clip.sourceRow ? `OpenFilm ${clip.sourceRow}` : role;
      const picture = clip.linkGroup ? linked.get(clip.linkGroup) : undefined;
      const parent = picture ?? connectionAt(primary, clip.start).parent;
      const offset = parent.in + clip.start - parent.start;
      parent.children.push(...clipXml(clip, { enabled: track.enabled, lane: -i - 1, offset, kind: 'audio', audioRole }));
    }
  });
  for (const { clip, parent, ...placement } of overlays) {
    parent.children.push(...clipXml(clip, { ...placement, kind: 'video' }));
  }
  const subtitleCues = filmSubtitleCuesInRange(cues, 0, timeline.durationFrames / rate.fps * 1000);
  // Basic Title scales its 1080-high template to the sequence; only the aspect ratio changes its point size.
  const fontSize = 48 * Math.min(width, height) / height;
  // FCPXML stores twice the Blur value shown in FCP’s text inspector.
  const shadowBlurRadius = decimal(fontSize * 0.22 * 2);
  let titleCount = 0;
  for (const { cue, end } of filmSubtitleSequence(subtitleCues)) {
    const span = frameSpan(cue.startMs / 1000, end / 1000, rate);
    if (span.end <= span.start) continue;
    const { parent, offset } = connectionAt(primary, span.start);
    if (titleCount === 0) resources.push(`    <effect id="subtitle-title" name="Basic Title" uid="${BASIC_TITLE}"/>`);
    const styleId = `subtitle-style-${++titleCount}`;
    const attrs = [
      'ref="subtitle-title"', `name="${attribute(cue.text)}"`, `lane="${Math.max(1, timeline.video.length)}"`,
      `offset="${time(offset)}"`, 'start="0s"', `duration="${time(span.end - span.start)}"`, 'role="titles.OpenFilm Subtitles"',
    ];
    // Ordinary titles stay with the picture layers; native captions use FCP's separate caption area.
    // A negative strokeWidth keeps both the face and outline.
    parent.children.push(
      `              <title ${attrs.join(' ')}>`,
      `                <text><text-style ref="${styleId}">${xmlEscape(filmSubtitleText(cue))}</text-style></text>`,
      `                <text-style-def id="${styleId}">`,
      `                  <text-style font="Helvetica" fontSize="${decimal(fontSize)}" fontColor="1 1 1 1"`
        + ' strokeColor="0 0 0 1" strokeWidth="-2" shadowColor="0 0 0 0.72"'
        + ` shadowOffset="${decimal(fontSize * 0.05)} 270" shadowBlurRadius="${shadowBlurRadius}" alignment="center"/>`,
      '                </text-style-def>',
      '                <adjust-transform position="0 -40"/>',
      '              </title>',
    );
  }
  const spine = primary.flatMap((segment) => {
    if (segment.clip) return clipXml(segment.clip, {
      enabled: main?.enabled ?? true, lane: 0, offset: segment.start, kind: 'video', children: segment.children, audio: segment.clip.linkGroup ? linked.get(segment.clip.linkGroup)?.children : undefined,
    });
    return [
      `            <gap name="OpenFilm" offset="${time(segment.start)}" start="0s" duration="${time(segment.end - segment.start)}">`,
      ...segment.children, '            </gap>',
    ];
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE fcpxml>', '<fcpxml version="1.10">', '  <resources>',
    ...resources, '  </resources>', '  <library>', `    <event name="${attribute(timeline.name)}">`,
    `      <project name="${attribute(timeline.name)}">`,
    `        <sequence format="sequence-format" duration="${time(timeline.durationFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '          <spine>', ...spine, '          </spine>', '        </sequence>', '      </project>',
    '    </event>', '  </library>', '</fcpxml>', '',
  ].join('\n');
}
