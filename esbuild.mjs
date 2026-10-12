import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// pdf.js runtime assets the webview loads by URL.
mkdirSync('media', { recursive: true });
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'media/pdf.worker.min.mjs');
// PDF JavaScript (QuickJS sandbox) is never executed by the preview, so its runtime is left out.
cpSync('node_modules/pdfjs-dist/wasm', 'media/wasm', { recursive: true, filter: src => !/quickjs/.test(src) });
rmSync('media/wasm/quickjs-eval.js', { force: true });
rmSync('media/wasm/quickjs-eval.wasm', { force: true });
if (production) { rmSync('media/viewer.js.map', { force: true }); rmSync('dist/extension.js.map', { force: true }); rmSync('dist/flattenWorker.js.map', { force: true }); }
cpSync('node_modules/pdfjs-dist/standard_fonts', 'media/standard_fonts', { recursive: true });
cpSync('webview/viewer.css', 'media/viewer.css');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };
const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
  esbuild.context({ ...common, entryPoints: ['src/flattenWorker.ts'], outfile: 'dist/flattenWorker.js', platform: 'node', format: 'cjs', target: 'node18' }),
  esbuild.context({ ...common, entryPoints: ['webview/viewer.ts'], outfile: 'media/viewer.js', platform: 'browser', format: 'esm', target: 'chrome114' }),
]);
if (watch) {
  await Promise.all(contexts.map(c => c.watch()));
} else {
  await Promise.all(contexts.map(c => c.rebuild()));
  await Promise.all(contexts.map(c => c.dispose()));
}
