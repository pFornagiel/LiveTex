// Turns compiler chatter into located problems. Pure (no vscode import) so it can be unit tested.

export type Severity = 'error' | 'warning';
export interface Problem { file?: string; line?: number; severity: Severity; message: string }

const NOISE = [
  /^Fontconfig (warning|error)/,
  /(errors|warnings) were issued by the TeX engine/,
  /^the XeTeX engine had an unrecoverable error/,
  /^something bad happened inside XeTeX/,
  /^halted on potentially-recoverable error/,
];

/** Tectonic prints `error: file:line: message` / `warning: file:line: message` on stderr. */
export function parseTectonic(stderr: string): Problem[] {
  const out: Problem[] = [];
  const lines = stderr.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(error|warning): (.*)$/.exec(lines[i]);
    if (!m) continue;
    const severity = m[1] as Severity;
    const body = m[2].trim();
    if (NOISE.some(re => re.test(body))) continue;
    // TeX reports files as they were named in \input, so the extension may be missing (`chapters/intro:11:`).
    const loc = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+): (.*)$/.exec(body);
    if (loc) out.push({ file: loc[1], line: +loc[2], severity, message: loc[3] });
    else if (body && !/^caused by:/.test(body)) out.push({ severity, message: body });
  }
  // A fatal run dumps the TeX log between ==== rulers; pull `! message` + `l.N` out of it.
  out.push(...parseTexLog(stderr, true));
  return dedupe(out);
}

/**
 * Classic TeX log. With -file-line-error, errors look like `./main.tex:12: Undefined control sequence.`;
 * otherwise `! Message` followed by `l.12 ...`.
 */
export function parseTexLog(log: string, onlyBangErrors = false): Problem[] {
  const out: Problem[] = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!onlyBangErrors) {
      const fle = /^(\.{0,2}\/?[^:\s][^:]*\.(?:tex|sty|cls|bib|ltx|bbl|aux)):(\d+): (.*)$/.exec(l);
      if (fle) { out.push({ file: fle[1], line: +fle[2], severity: 'error', message: fle[3] }); continue; }
      const warn = /^(?:LaTeX|Package (\S+)) Warning: (.*)$/.exec(l);
      if (warn) {
        let msg = warn[2];
        let j = i + 1;
        while (j < lines.length && lines[j].trim() && !/^(LaTeX|Package)/.test(lines[j]) && j < i + 5) msg += ' ' + lines[j++].trim();
        msg = msg.replace(/\s+/g, ' ');
        const ln = /on input line (\d+)\.?/.exec(msg);
        out.push({ severity: 'warning', line: ln ? +ln[1] : undefined, message: (warn[1] ? `${warn[1]}: ` : '') + msg });
        continue;
      }
    }
    if (l.startsWith('! ')) {
      const message = l.slice(2).trim();
      let line: number | undefined;
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const m = /^l\.(\d+)/.exec(lines[j]);
        if (m) { line = +m[1]; break; }
      }
      out.push({ severity: 'error', line, message });
    }
  }
  return dedupe(out);
}

function dedupe(ps: Problem[]): Problem[] {
  const seen = new Set<string>();
  const res: Problem[] = [];
  // When the same message appears both with and without a file, keep the located one.
  const located = new Set(ps.filter(p => p.file).map(p => `${p.line}|${p.message.replace(/\.$/, '')}`));
  for (const p of ps) {
    if (!p.file && located.has(`${p.line}|${p.message.replace(/\.$/, '')}`)) continue;
    const key = `${p.file}|${p.line}|${p.severity}|${p.message}`;
    if (!seen.has(key)) { seen.add(key); res.push(p); }
  }
  return res;
}

/**
 * Documents written for pdfLaTeX + biber (the Overleaf default) that Tectonic (XeTeX, bundled 2022 packages,
 * no biber of its own) cannot reproduce. Reported as warnings on the root file so the reason is visible.
 */
export function tectonicCompatIssues(rootText: string, stderr: string): Problem[] {
  const pre = rootText.split(/\\begin\s*\{document\}/)[0].replace(/(^|[^\\])%.*$/gm, '$1');
  const out: Problem[] = [];
  const biblatex = /\\usepackage\s*(\[[^\]]*\])?\s*\{biblatex\}/.exec(pre);
  if (biblatex && !/backend\s*=\s*bibtex/.test(biblatex[1] ?? '')) {
    out.push({ severity: 'warning', line: lineOf(pre, biblatex.index), message:
      'biblatex with biber cannot be run by Tectonic (it bundles biblatex 2022, which does not match an installed biber). ' +
      'Install TeX Live/TinyTeX so the latexmk engine is used, or set backend=bibtex.' });
  }
  const enc = /\\usepackage\s*\[[^\]]*\]\s*\{(inputenc|fontenc)\}/.exec(pre);
  if (enc && /Missing character: There is no/.test(stderr)) {
    out.push({ severity: 'warning', line: lineOf(pre, enc.index), message:
      `This document is set up for pdfLaTeX (\\usepackage{${enc[1]}}), but Tectonic is XeTeX-based: non-ASCII characters are missing ` +
      'from the PDF. Use the latexmk engine with a TeX distribution, or switch to fontspec.' });
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
