import type { Plugin } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Build the actual React player as an offline IIFE. No generated copy to maintain. */
export function storyPlayerPlugin(): Plugin {
  const id = 'virtual:story-player-assets';
  let root: string;
  let cached: Promise<string> | undefined;
  const dependencies = new Set<string>();
  return {
    name: 'standalone-story-player',
    configResolved(config) { root = config.root; },
    resolveId(source) { if (source === id) return '\0' + id; },
    async load(source) {
      if (source !== '\0' + id) return;
      cached ??= (async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'story-player-'));
        try {
          const output = path.join(directory, 'assets.json');
          await promisify(execFile)(process.execPath, [path.join(root, 'build/buildStoryPlayer.mjs'), root, output], {
            env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 1024 * 1024,
          });
          const assets = JSON.parse(await readFile(output, 'utf8')) as { script: string; style: string; dependencies: string[] };
          assets.dependencies.forEach((file) => dependencies.add(file));
          return `export const PLAYER_SCRIPT = ${JSON.stringify(assets.script)};\nexport const PLAYER_STYLE = ${JSON.stringify(assets.style)};`;
        } finally { await rm(directory, { recursive: true, force: true }); }
      })().catch((error) => { cached = undefined; throw error; });
      const code = await cached;
      dependencies.forEach((file) => this.addWatchFile(file));
      return code;
    },
    handleHotUpdate({ file, server, modules }) {
      if (!dependencies.has(file) && !file.includes('/story/') && !file.includes('/components/canvas/useChoice')) return;
      cached = undefined;
      const module = server.moduleGraph.getModuleById('\0' + id);
      if (module) {
        server.moduleGraph.invalidateModule(module);
        return [...modules, module];
      }
    },
    watchChange(file) { if (dependencies.has(file)) cached = undefined; },
  };
}
