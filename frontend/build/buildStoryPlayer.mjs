import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

const [root, destination] = process.argv.slice(2);
// Isolated from the dev server/Vitest plugin pipeline and NODE_ENV.
const result = await build({
  configFile: false, root, publicDir: false, logLevel: 'error',
  plugins: [tailwindcss()],
  resolve: { alias: { '@': path.resolve(root, 'src') } },
  esbuild: { jsx: 'automatic', jsxDev: false },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false, target: 'es2020', minify: 'esbuild', cssCodeSplit: false,
    lib: { entry: path.resolve(root, 'src/features/canvas/story/export/standalone.tsx'), formats: ['iife'], name: 'StoryPlayerExport' },
  },
});
let script = ''; let style = '';
const dependencies = new Set([
  path.resolve(root, 'build/buildStoryPlayer.mjs'),
  path.resolve(root, 'src/features/canvas/story/export/standalone.css'),
  path.resolve(root, 'src/features/canvas/story/storyPlayer.css'),
]);
for (const output of (Array.isArray(result) ? result : [result]).flatMap((item) => item.output)) {
  if (output.type === 'chunk') {
    script += output.code;
    Object.keys(output.modules).filter((file) => !file.startsWith('\0')).forEach((file) => dependencies.add(file));
  } else if (output.fileName.endsWith('.css')) style += String(output.source);
}
if (!script || !style) throw new Error('Standalone story player build is incomplete');
await writeFile(destination, JSON.stringify({ script, style, dependencies: [...dependencies] }));
