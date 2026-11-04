/** A sound's fades in the mix: `in` / `out` film seconds of ramp, `length` its film seconds, `skip` seconds cut off its start. */
export interface MixFade { in: number; out: number; length: number; skip: number }
export interface MixClip { file: string; at: number; from: number; to?: number; volume: number; speed?: number; fade?: MixFade }
export declare function audioClips(root: string, entry: string, clips: Array<{ src: string; at?: number; from?: number; to?: number; volume?: number; speed?: number; fade?: readonly [number, number] }> | undefined, from?: number): MixClip[];
export declare function fadeFilter(fade: MixFade | undefined): string;
export declare function mix(clips: MixClip[], duration: number, file: string, codec?: string[]): Promise<void>;
/** A mix's inputs and filter graph: a file used by several clips is one input, split. */
export declare function mixGraph(clips: MixClip[], duration: number): { inputs: string[]; filter: string };
/** How long a mix's command may be before its graph goes in a file. */
export declare const COMMAND_ROOM: number;
/** A film opened in a browser to be drawn: what `look` and `render` start from. */
export interface OpenFilm {
  root: string; entry: string; dir: string; name: string;
  film: import('./host.mjs').FilmPage;
  browser: import('playwright-core').Browser;
  site: { url: string; close(): Promise<void> };
  close(): Promise<void>;
}
/** `playable`: the picture is wanted, so footage the browser does not decode is served as a copy it plays (the film's video clips, or these files). */
export declare function open(target: string, opts?: { root?: string; playable?: boolean | string[]; signal?: AbortSignal }): Promise<OpenFilm>;
/** The film's sound from `from` seconds on, as clips to mix: its sound clips and its videos' own sound. */
export declare function filmSound(s: OpenFilm, from: number): Promise<MixClip[]>;
export declare class UsageError extends Error {}
/** Stop a process at once, with its children on Windows. */
export declare function kill(proc: import('node:child_process').ChildProcess): void;
/** Run ffmpeg (`-nostdin`, errors only) with `args`; rejects with its error, or when it runs past `timeoutMs`. */
export declare function ffmpeg(args: string[], opts?: { input?: boolean; timeoutMs?: number; what?: string }): { proc: import('node:child_process').ChildProcess; done: Promise<void> };

/** Where a path the film asks for (a sound's `src`, resolved from the entry as the browser would) lives on disk; throws for one outside the film's folder, or a link out of it that is not media the person linked (src/media-links.mjs). */
export declare function fileOf(root: string, entry: string, src: string): string;
/** A sound as a film or a page lists it: a path, and numbers where numbers go; throws otherwise. */
export declare function checkSound<T extends { src: string }>(sound: T): T;
