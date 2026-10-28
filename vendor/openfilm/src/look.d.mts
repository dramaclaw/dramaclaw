import type { LaunchOptions, PageNetwork } from './host.mjs';
export declare function look(args: string[], opts?: { count?: number; root?: string; offline?: boolean; network?: PageNetwork; launch?: LaunchOptions }): Promise<{ ok: boolean; lines: string[]; files: string[] }>;
