import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTectonic, parseTexLog, tectonicCompatIssues } from '../src/logParser';

test('tectonic: located errors and warnings, deduplicated across reruns, noise dropped', () => {
  const stderr = [
    'note: Running TeX ...',
    'Fontconfig warning: "/etc/fonts/conf.d/48-guessfamily.conf", line 19: invalid attribute',
    'error: main.tex:4: Undefined control sequence',
    'note: Rerunning TeX because "main.aux" changed ...',
    'error: main.tex:4: Undefined control sequence',
    'warning: chapters/intro.tex:21: Overfull \\hbox (9.6pt too wide) in paragraph at lines 18--21',
    'warning: errors were issued by the TeX engine, but were ignored; use --print and/or --keep-logs for details.',
  ].join('\n');
  assert.deepEqual(parseTectonic(stderr), [
    { file: 'main.tex', line: 4, severity: 'error', message: 'Undefined control sequence' },
    { file: 'chapters/intro.tex', line: 21, severity: 'warning', message: 'Overfull \\hbox (9.6pt too wide) in paragraph at lines 18--21' },
  ]);
});

test('tectonic: \\input names without extension are still located', () => {
  const ps = parseTectonic('error: chapters/intro:11: Undefined control sequence');
  assert.deepEqual(ps, [{ file: 'chapters/intro', line: 11, severity: 'error', message: 'Undefined control sequence' }]);
});

test('tectonic: fatal error dump yields a located problem', () => {
  const stderr = [
    'error: bad.tex:1: Text line contains an invalid character',
    'error: something bad happened inside XeTeX; its output follows:',
    '===',
    '! Text line contains an invalid character.',
    'l.1 \\documentclass{article}^^H',
    '===',
    'error: the XeTeX engine had an unrecoverable error',
    'caused by: halted on potentially-recoverable error as specified',
  ].join('\n');
  const ps = parseTectonic(stderr);
  assert.equal(ps.length, 1, JSON.stringify(ps));
  assert.equal(ps[0].file, 'bad.tex');
  assert.equal(ps[0].line, 1);
});

test('tex log (-file-line-error) and LaTeX warnings', () => {
  const log = [
    './main.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    'LaTeX Warning: Reference `fig:x\' on page 1 undefined on input line 30.',
    '',
    'Package hyperref Warning: Token not allowed in a PDF string',
    '(hyperref)                removing `math shift\' on input line 7.',
  ].join('\n');
  const ps = parseTexLog(log);
  assert.equal(ps[0].file, './main.tex');
  assert.equal(ps[0].line, 12);
  assert.equal(ps[1].severity, 'warning');
  assert.equal(ps[1].line, 30);
  assert.equal(ps[2].line, 7);
  assert.match(ps[2].message, /^hyperref: /);
});

test('tectonic compat: biblatex/biber and pdfLaTeX-only encodings are explained', () => {
  const root = [
    '\\documentclass{article}',
    '% \\usepackage{biblatex} commented out on purpose',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage[style=numeric,',
    '  backend=biber]{biblatex}',
    '\\begin{document}',
    '\\usepackage{biblatex}',
    '\\end{document}',
  ].join('\n');
  const ps = tectonicCompatIssues(root, 'warning: main.tex:9: Missing character: There is no ł ("142) in font ptmr8t!');
  assert.equal(ps.length, 2);
  assert.equal(ps[0].line, 4);
  assert.match(ps[0].message, /biber/);
  assert.equal(ps[1].line, 3);
  assert.match(ps[1].message, /pdfLaTeX/);
  assert.equal(tectonicCompatIssues('\\usepackage[backend=bibtex]{biblatex}', '').length, 0);
  assert.equal(tectonicCompatIssues('\\usepackage[utf8]{inputenc}', 'no missing chars').length, 0);
});
