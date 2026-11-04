/** film.html, as read by film-doc.mjs: the types of a project's edit (the value its file says). */

/** What a clip is, from its file: a web page (.html), a video, a still picture or a sound. */
export type FilmClipKind = 'page' | 'video' | 'still' | 'sound';
/** `[start]` or `[start, end]`, in the source's own seconds. */
export type FilmTimeSpan = [number] | [number, number];

/**
 * Where a picture sits, in CSS px from the stage's top-left (its style's left, top, width, height and rotate). `w` /
 * `h` default to the picture's own size; with one of them, the other follows its proportions. `r` turns it clockwise,
 * degrees. A video or still is its box (the picture inside as its CSS says); a page is fitted inside it, centered.
 */
export type FilmBox = {
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
}

/**
 * A person's change made in Studio: with `at`, a tweak of one element inside a web page, applied after the page draws
 * each frame; without it, the clip's own (its `fade`).
 */
export type FilmOverride = {
  /** CSS selector of the element; absent on the clip's own entry. */
  at?: string;
  /** Which match, from 1 (every match when not written). */
  n?: number;
  t?: [number, number];
  s?: number | [number, number];
  r?: number;
  /** camelCase CSS properties; numbers get px where CSS wants a length. */
  style?: Record<string, string | number>;
  /** An editor's lock: the film itself ignores it. */
  lock?: true;
  /** The element's text (only where it holds text alone). */
  text?: string;
  /** The clip's own entry only: seconds its picture and sound ramp up from 0 at its start, and down to 0 at its end. */
  fade?: [number, number];
}

/** A clip. Which fields it takes follows what its file is (film-doc.mjs CLIP_FIELDS). */
export type FilmClip = {
  src: string;
  id: string;
  at?: number;
  time?: FilmTimeSpan;
  /** pictures: pages, videos, stills */
  box?: FilmBox;
  /** pages: the CSS pixels a page without a size of its own is laid out at */
  size?: { w: number; h: number };
  /** videos and sounds */
  volume?: number;
  /** videos and sounds */
  speed?: number;
  /** pictures: class names, for the film's styles */
  class?: string;
  /** pictures: its own CSS, but for where it sits (that is `box`) */
  style?: string;
  /** a clip of a video file's sound alone: an <audio> of it in film.html (its picture is a clip of its own) */
  sound?: true;
  /** the person's changes made in Studio: a page's elements (entries with `at`), any clip's fades (the one without) */
  overrides?: FilmOverride[];
  /** attributes kept as they are: alt, title, lang, dir, data-*, aria-* (and a sound's class) */
  attrs?: Record<string, string>;
}

/** A track: clips that do not overlap. Any clip goes on any track; the first track's pictures are on top. */
export type FilmTrack = {
  clips: FilmClip[];
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
  /** attributes of its <section> kept as they are: id, class, title, lang, dir, data-*, aria-* */
  attrs?: Record<string, string>;
}

export type FilmDoc = {
  stage: { w: number; h: number };
  tracks: FilmTrack[];
}

export declare const FILM_FILE: 'film.html';
export declare const DEFAULT_STAGE: Readonly<{ w: number; h: number }>;
export declare const SPEED_MIN: number;
export declare const SPEED_MAX: number;

export declare function isStill(src: string): boolean;
export declare function isPage(src: string): boolean;
/** A clip's src as an address: its path with `%`, `#` and `?` escaped; a src with a scheme as written. */
export declare function srcHref(src: string): string;
export declare function soundRole(src: string): 'voice' | 'music' | 'sfx';
export declare function clipKind(src: unknown): FilmClipKind | null;
export declare function hasPicture(src: unknown): boolean;
/** What a clip is: its file's kind, but a video's sound alone (`sound: true`) is a sound. */
export declare function kindOf(clip: { src?: unknown; sound?: unknown } | null | undefined): FilmClipKind | null;
export declare function clipIdFor(src: string | undefined, used: Iterable<string>): string;

export declare function readFilm(value: unknown): { doc: FilmDoc | null; problems: string[]; whole?: boolean };
/** A film.html: the value it says (`value`, clips named), checked (`doc`), or every problem, each with its line. */
export declare function readFilmFile(text: string): { value: FilmDoc | null; doc: FilmDoc | null; problems: string[]; layout: unknown };
/** The part of a film.html that is not its tracks: its head (stage, styles, fonts), as text. */
export declare function filmHead(text: string): string;
/** The film.html that says `value`, written over `before` (what did not change keeps its text). */
export declare function filmHtml(value: { stage?: { w: number; h: number }; tracks: readonly unknown[] }, before?: string): string;
/** A clip's element as film.html writes it: its attributes in one order, its picture's place first in its style. */
export declare function clipTag(clip: FilmClip): string;
export declare function parseFilm(value: unknown): FilmDoc;

export declare function clipSpeed(clip: { src: string; speed?: unknown }): number;
export type FilmClipSpan = { from: number; to: number; speed: number; length: number }
export declare function clipSpan(clip: { src: string; time?: FilmTimeSpan; speed?: unknown }, native: number | undefined, where?: string): FilmClipSpan;
export declare function sourceAt(span: FilmClipSpan, localSec: number, clip: { src: string }, native?: number): number;

/** A clip's fades `[in, out]` in seconds, or null. */
export declare function clipFade(clip: { overrides?: readonly unknown[] } | null | undefined): [number, number] | null;
/** How much of a clip shows and is heard `local` seconds into its `length`, 0 to 1. */
export declare function fadeGain(local: number, length: number, fade: readonly [number, number] | null | undefined): number;
/** Fades shortened alike to fit in `length`, or null. */
export declare function fittedFade(fade: readonly [number, number] | null | undefined, length: number): [number, number] | null;

export declare function pictureRect(kind: FilmClipKind | null, own: { w: number; h: number } | null | undefined, stage: { w: number; h: number }, box?: FilmBox | null): { x: number; y: number; w: number; h: number; r: number };
/** A style attribute's declarations, in order: `[property, value]`, the property in lower case. */
export declare function declarations(style: string): [string, string][];
