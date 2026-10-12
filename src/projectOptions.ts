// Build options that travel with the document rather than the editor: the `% !TEX program` magic comment (understood
// by TeXShop, TeXworks, TeXstudio, LaTeX Workshop…) and a project latexmkrc (also read by Overleaf).
// No vscode imports, so this is unit-testable.
import * as fs from 'fs';
import * as path from 'path';

export type TexProgram = 'pdflatex' | 'xelatex' | 'lualatex';

const PROGRAM = /^[ \t]*%[ \t]*![ \t]*TeX[ \t]+(?:TS-)?program[ \t]*=[ \t]*([^\s%]+)/im;
const PROGRAMS: Record<string, TexProgram> = {
  pdflatex: 'pdflatex', pdftex: 'pdflatex', pdflatexmk: 'pdflatex',
  xelatex: 'xelatex', xetex: 'xelatex', xelatexmk: 'xelatex',
  lualatex: 'lualatex', luatex: 'lualatex', lualatexmk: 'lualatex',
};

export interface ProgramMagic {
  program?: TexProgram;   // undefined if the comment names something unsupported
  raw: string;            // as written, e.g. "XeLaTeX"
  line: number;           // 1-based
}

/** `% !TEX program = xelatex` (or TeXShop's `% !TeX TS-program = …`) near the top of the root document. */
export function texProgram(text: string): ProgramMagic | undefined {
  const head = text.split('\n').slice(0, 50).join('\n');
  const m = PROGRAM.exec(head);
  if (!m) return undefined;
  return { program: PROGRAMS[m[1].toLowerCase()], raw: m[1], line: head.slice(0, m.index).split('\n').length };
}

/** The project's latexmk configuration, as latexmk (and Overleaf) look for it in the project directory. */
export function findLatexmkrc(dir: string): string | undefined {
  for (const name of ['latexmkrc', '.latexmkrc']) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not there */ }
  }
  return undefined;
}

// latexmk options that choose the TeX engine / output route; replaced when the document names its program.
const ENGINE_FLAG = /^-(pdf|pdfxe|xelatex|xe|pdflua|lualatex|lua|pdfdvi|pdfps|dvi|ps)$/;
const LATEXMK_FLAG: Record<TexProgram, string> = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

/**
 * latexmk arguments (without the file name). latexmk applies options in command-line order, so the order sets the
 * precedence: the editor's `latexmkArgs` < the project latexmkrc < the document's `% !TEX program`. The output
 * and aux directories always come last: the build must land in our output directory whatever the rc file says.
 */
export function latexmkArgs(userArgs: string[], o: { program?: TexProgram; latexmkrc?: string; outDir: string }): string[] {
  const base = o.program ? userArgs.filter(a => !ENGINE_FLAG.test(a)) : userArgs;
  return [
    ...base,
    ...(o.latexmkrc ? ['-r', o.latexmkrc] : []),
    ...(o.program ? [LATEXMK_FLAG[o.program]] : []),
    `-outdir=${o.outDir}`, `-auxdir=${o.outDir}`,
  ];
}

/** Engine for a single direct pass (fast preview): the document's choice, else what `latexmkArgs` selects. */
export function directEngine(userArgs: string[], program?: TexProgram): TexProgram {
  if (program) return program;
  if (userArgs.some(a => /^-(xelatex|pdfxe|xe)$/.test(a))) return 'xelatex';
  if (userArgs.some(a => /^-(lualatex|pdflua|lua)$/.test(a))) return 'lualatex';
  return 'pdflatex';
}
