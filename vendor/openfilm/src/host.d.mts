import type { Browser, Page } from 'playwright-core';
export declare const HOST_FLAG: string;
export declare const SEEK_INSIDE_FRAME: string;
export declare const FILM_CLOCK: string;
export declare function injectFirst(html: string, tag: string): string;
export declare function serve(root: string, opts?: { port?: number }): Promise<{ url: string; close(): Promise<void> }>;
export interface LaunchOptions { headed?: boolean; channel?: string | null; args?: string[]; env?: Record<string, string | undefined> }
export declare function launch(opts?: LaunchOptions): Promise<Browser>;
/** A renderer string that is not a GPU: WebGL drawn on the CPU. */
export declare const SOFTWARE_GL: RegExp;
/** Windows: open with Vulkan once, and keep it only when its renderer is a GPU; otherwise Chromium's default. */
export declare function vulkanFirst(renderer?: (browser: Browser) => Promise<string>): (open: (angle: string[]) => Promise<Browser>) => Promise<Browser>;
/** Close every browser launch() opened that is still open: what waits on one fails at once instead of never answering. */
export declare function closeBrowsers(): Promise<void>;
/** With `offline`: the origins still open to a page, and optionally who answers them (a cache). */
export interface PageNetwork { allow?: readonly string[]; fetch?(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> }
export declare class FrameError extends Error {}
/** A page's facts once ready: its length (null: it has no end), and its viewport (its own size, or 1920 × 1080 when it says none). */
/** `sized`: the page sets its own width and height (without, it is laid out at its clip's size or the stage's). */
export interface FilmMeta { duration: number | null; width: number; height: number; sized: boolean; sounds: FilmSound[] }
/** One sound of the film as the built-in timeline plays it: `src` a path on the film's origin, placed at film second `at`, its source seconds [from, to). */
export interface FilmSound { clip: string; src: string; at: number; from: number; to?: number; volume: number; speed: number }
export declare class FilmPage {
  static open(browser: Browser, origin: string, entry: string, opts?: { scale?: number; size?: { w: number; h: number } | null; transparent?: boolean; black?: boolean; readyMs?: number; offline?: boolean; network?: PageNetwork; waitMs?: number }): Promise<FilmPage>;
  page: Page;
  meta: FilmMeta;
  problems: Array<{ kind: string; message: string }>;
  seek(t: number, opts?: { timeoutMs?: number }): Promise<void>;
  capture(opts?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<Buffer>;
  close(): Promise<void>;
}
/** Serves one request for the files of `root` at `path`; false when the path leaves the folder. */
export declare function folderFiles(root: string, opts?: { inject?: string; timelineInject?: string; headers?: Record<string, string>; swap?: (file: string) => string | null }): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string, query?: URLSearchParams) => boolean;
