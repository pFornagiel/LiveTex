import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { texProgram, findLatexmkrc, latexmkArgs, directEngine } from '../src/projectOptions';

test('texProgram: magic comment spellings', () => {
  assert.deepEqual(texProgram('% !TEX program = xelatex\n\\documentclass{article}'), { program: 'xelatex', raw: 'xelatex', line: 1 });
  assert.equal(texProgram('%!TeX program=LuaLaTeX\n')?.program, 'lualatex');
  assert.equal(texProgram('% !TeX TS-program = pdflatexmk\n')?.program, 'pdflatex');
  assert.equal(texProgram('% !TEX encoding = UTF-8\n% !TEX program = xelatex -shell-escape\n')?.line, 2);
  assert.equal(texProgram('% !TEX program = xelatex % comment')?.program, 'xelatex');
  assert.deepEqual(texProgram('% !TEX program = latex\n'), { program: undefined, raw: 'latex', line: 1 });
  assert.equal(texProgram('\\documentclass{article}\n% just a comment about TeX program = xelatex\n'), undefined);
  assert.equal(texProgram('% !TEX root = main.tex\n'), undefined);
  assert.equal(texProgram('\n'.repeat(60) + '% !TEX program = xelatex\n'), undefined, 'only the top of the file counts');
});

test('findLatexmkrc: latexmkrc, then .latexmkrc, files only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-rc-'));
  assert.equal(findLatexmkrc(dir), undefined);
  fs.mkdirSync(path.join(dir, 'latexmkrc'));
  assert.equal(findLatexmkrc(dir), undefined, 'a directory is not an rc file');
  fs.writeFileSync(path.join(dir, '.latexmkrc'), '');
  assert.equal(findLatexmkrc(dir), path.join(dir, '.latexmkrc'));
  fs.rmdirSync(path.join(dir, 'latexmkrc'));
  fs.writeFileSync(path.join(dir, 'latexmkrc'), '');
  assert.equal(findLatexmkrc(dir), path.join(dir, 'latexmkrc'));
  fs.rmSync(dir, { recursive: true });
});

test('latexmkArgs: precedence is settings < latexmkrc < % !TEX program, output dirs last', () => {
  const user = ['-pdf', '-synctex=1', '-interaction=nonstopmode'];
  assert.deepEqual(latexmkArgs(user, { outDir: '/o' }), [...user, '-outdir=/o', '-auxdir=/o']);
  assert.deepEqual(latexmkArgs(user, { outDir: '/o', latexmkrc: '/p/latexmkrc' }), [...user, '-r', '/p/latexmkrc', '-outdir=/o', '-auxdir=/o']);
  assert.deepEqual(latexmkArgs(user, { outDir: '/o', latexmkrc: '/p/latexmkrc', program: 'xelatex' }),
    ['-synctex=1', '-interaction=nonstopmode', '-r', '/p/latexmkrc', '-xelatex', '-outdir=/o', '-auxdir=/o']);
  assert.deepEqual(latexmkArgs(['-pdfxe', '-pdflatex=pdflatex -foo %O %S'], { outDir: '/o', program: 'lualatex' }),
    ['-pdflatex=pdflatex -foo %O %S', '-lualatex', '-outdir=/o', '-auxdir=/o'], 'custom command settings are kept');
});

test('directEngine: document choice, else latexmkArgs', () => {
  assert.equal(directEngine(['-pdf']), 'pdflatex');
  assert.equal(directEngine(['-pdfxe']), 'xelatex');
  assert.equal(directEngine(['-lualatex']), 'lualatex');
  assert.equal(directEngine(['-pdf'], 'xelatex'), 'xelatex');
});

// End-to-end with a real latexmk, laid out like the extension does it: latexmk runs in a shadow dir (cwd) with the
// project on TEXINPUTS and the project's latexmkrc passed with -r. Skipped when no TeX distribution is installed.
function findLatexmk(): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const tiny = path.join(os.homedir(), '.TinyTeX', 'bin');
  try { for (const d of fs.readdirSync(tiny)) dirs.push(path.join(tiny, d)); } catch { /* no TinyTeX */ }
  for (const d of dirs) if (d && fs.existsSync(path.join(d, 'latexmk'))) return path.join(d, 'latexmk');
  return undefined;
}
const latexmk = findLatexmk();
const ENGINE_PROBE = '\\documentclass{article}\n\\begin{document}\n\\ifdefined\\XeTeXversion XETEX\\else\\ifdefined\\directlua LUATEX\\else PDFTEX\\fi\\fi\n\\end{document}\n';

function build(o: { magic?: string; rc?: string; user?: string[] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-mk-'));
  const proj = path.join(tmp, 'proj'), shadow = path.join(tmp, 'shadow'), out = path.join(tmp, 'out');
  for (const d of [proj, shadow, out]) fs.mkdirSync(d);
  const doc = (o.magic ? `% !TEX program = ${o.magic}\n` : '') + ENGINE_PROBE;
  fs.writeFileSync(path.join(proj, 'doc.tex'), doc);
  fs.writeFileSync(path.join(shadow, 'doc.tex'), doc);
  if (o.rc) fs.writeFileSync(path.join(proj, 'latexmkrc'), o.rc);
  const args = latexmkArgs(o.user ?? ['-pdf', '-synctex=1', '-interaction=nonstopmode'], {
    outDir: out, latexmkrc: findLatexmkrc(proj), program: texProgram(doc)?.program,
  });
  const bin = path.dirname(latexmk!);
  execFileSync(latexmk!, [...args, 'doc.tex'], {
    cwd: shadow, stdio: 'pipe',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEXINPUTS: `${shadow}${path.delimiter}${proj}//${path.delimiter}` },
  });
  const log = fs.readFileSync(path.join(out, 'doc.log'), 'utf8');
  const engine = /This is (pdfTeX|XeTeX|LuaHBTeX|LuaTeX)/.exec(log)?.[1];
  const result = { engine, pdf: fs.existsSync(path.join(out, 'doc.pdf')), synctex: fs.existsSync(path.join(out, 'doc.synctex.gz')), tmp };
  return result;
}

test('latexmk: % !TEX program picks the engine', { skip: !latexmk && 'no latexmk' }, () => {
  const r = build({ magic: 'xelatex' });
  assert.deepEqual([r.engine, r.pdf, r.synctex], ['XeTeX', true, true]);
  fs.rmSync(r.tmp, { recursive: true });
});

test('latexmk: the project latexmkrc is read and overrides latexmkArgs', { skip: !latexmk && 'no latexmk' }, () => {
  const r = build({ rc: '$pdf_mode = 5;\n' });
  assert.equal(r.engine, 'XeTeX');
  fs.rmSync(r.tmp, { recursive: true });
});

test('latexmk: % !TEX program overrides the latexmkrc', { skip: !latexmk && 'no latexmk' }, () => {
  const r = build({ rc: '$pdf_mode = 5;\n', magic: 'pdflatex' });
  assert.equal(r.engine, 'pdfTeX');
  fs.rmSync(r.tmp, { recursive: true });
});

test('latexmk: an rc that moves output dirs cannot scatter files', { skip: !latexmk && 'no latexmk' }, () => {
  const r = build({ rc: '$out_dir = "rc-out";\n$aux_dir = "rc-aux";\n' });
  assert.deepEqual([r.engine, r.pdf, r.synctex], ['pdfTeX', true, true]);
  for (const d of ['proj', 'shadow']) for (const x of ['rc-out', 'rc-aux']) assert.ok(!fs.existsSync(path.join(r.tmp, d, x)), `${d}/${x}`);
  fs.rmSync(r.tmp, { recursive: true });
});
