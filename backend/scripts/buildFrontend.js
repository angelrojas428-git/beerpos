import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDir = path.resolve(backendDir, '..');

await build({
  absWorkingDir: workspaceDir,
  entryPoints: ['frontend/js/app.js'],
  outfile: 'frontend/dist/app.js',
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  nodePaths: [path.join(backendDir, 'node_modules')]
});
