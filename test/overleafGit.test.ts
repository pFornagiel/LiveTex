import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import {
  Git, GitError, parseProjectInput, projectPageUrl, writeAskpass, sync, prepareLink, planLink, ensureExcludes,
  findRemote, status,
} from '../src/overleafGit';

// Everything lives in a fresh temp dir with its own HOME and global git config: the user's config, credential store
// and documents are never read or written.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'll-overleaf-'));
const TOKEN = 'olp_test_token_123';
const isolatedEnv: NodeJS.ProcessEnv = {
  HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, '.config'), GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
};
fs.writeFileSync(isolatedEnv.GIT_CONFIG_GLOBAL!, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...isolatedEnv }, encoding: 'utf8' });
const askpass = writeAskpass(path.join(tmp, 'bin'));
let token = TOKEN;
let server: http.Server;
let baseUrl = '';
let projectN = 0;

/** A git smart-HTTP server (git http-backend) that, like git.overleaf.com, wants Basic auth git:<token>. */
before(async () => {
  server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Basic ' + Buffer.from(`git:${TOKEN}`).toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Overleaf"' });
      res.end('Authentication failed');
      return;
    }
    const url = new URL(req.url!, 'http://x');
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...isolatedEnv, GIT_PROJECT_ROOT: path.join(tmp, 'server'), GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'git',
      PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1',
    };
    for (const [k, v] of Object.entries(req.headers)) env['HTTP_' + k.toUpperCase().replace(/-/g, '_')] = String(v);
    const cgi = spawn('git', ['http-backend'], { env });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', d => chunks.push(d));
    cgi.on('close', () => {
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf('\r\n\r\n');
      const head = buf.subarray(0, sep).toString().split('\r\n');
      let code = 200;
      const headers: Record<string, string> = {};
      for (const h of head) {
        const [k, ...v] = h.split(':');
        if (/^status$/i.test(k)) code = parseInt(v.join(':'), 10); else headers[k] = v.join(':').trim();
      }
      res.writeHead(code, headers);
      res.end(buf.subarray(sep + 4));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function git(cwd: string) {
  return new Git(cwd, { askpass, token: async () => token, env: isolatedEnv });
}

/** A new "Overleaf project" (bare repo on the server) seeded like Overleaf's blank template. */
function newProject(files: Record<string, string> = { 'main.tex': '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n' }) {
  const name = `p${++projectN}`;
  const bare = path.join(tmp, 'server', name);
  fs.mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare');
  const seed = path.join(tmp, 'seed-' + name);
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); }
  sh(seed, 'add', '-A'); sh(seed, 'commit', '-qm', 'Overleaf template'); sh(seed, 'push', '-q', bare, 'HEAD:refs/heads/main');
  return { url: `${baseUrl}/${name}`, bare };
}

/** Simulates someone editing on overleaf.com: a commit pushed straight into the bare repo. */
function editOnOverleaf(bare: string, file: string, content: string) {
  const w = fs.mkdtempSync(path.join(tmp, 'web-'));
  sh(w, 'clone', '-q', bare, '.');
  fs.writeFileSync(path.join(w, file), content);
  sh(w, 'add', '-A'); sh(w, 'commit', '-qm', 'web edit'); sh(w, 'push', '-q', 'origin', 'HEAD:main');
}

async function cloneProject(url: string) {
  const dir = fs.mkdtempSync(path.join(tmp, 'local-'));
  await git(tmp).run(['clone', '-q', url, dir], true);
  return dir;
}

const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const serverFile = (bare: string, f: string) => sh(bare, 'show', `main:${f}`);
const msg = { push: true, commit: true, message: 'Update from test' };

test('parseProjectInput accepts editor URLs, git URLs, clone lines and bare ids', () => {
  const id = '65a1b2c3d4e5f60718293a4b';
  for (const s of [`https://www.overleaf.com/project/${id}`, `https://www.overleaf.com/project/${id}?x=1`, `git clone https://git.overleaf.com/${id}`, id, ` ${id} `])
    assert.deepEqual(parseProjectInput(s), { url: `https://git.overleaf.com/${id}`, id }, s);
  assert.deepEqual(parseProjectInput('https://git@git.overleaf.com/' + id), { url: 'https://git.overleaf.com/' + id, id });
  assert.equal(parseProjectInput('https://latex.example.edu/git/abc')?.url, 'https://latex.example.edu/git/abc');
  assert.equal(parseProjectInput('hello world'), undefined);
  assert.equal(parseProjectInput(''), undefined);
  assert.equal(projectPageUrl(`https://git.overleaf.com/${id}`), `https://www.overleaf.com/project/${id}`);
});

test('auth: the token goes through askpass only, never into config or a credential store', async () => {
  const p = newProject();
  token = 'wrong';
  const err = await cloneProject(p.url).catch(e => e);
  assert.ok(err instanceof GitError && err.authFailed, String(err));
  token = TOKEN;
  const dir = await cloneProject(p.url);
  assert.match(read(dir, 'main.tex'), /Hello/);
  assert.ok(!read(dir, '.git', 'config').includes(TOKEN));
  assert.ok(!fs.existsSync(path.join(tmp, '.git-credentials')));
  assert.ok(!read(isolatedEnv.GIT_CONFIG_GLOBAL!).includes(TOKEN));
  assert.equal(await findRemote(git(dir)), undefined, 'origin is not an Overleaf host');
  sh(dir, 'remote', 'add', 'other', 'https://git.overleaf.com/123456');
  assert.deepEqual(await findRemote(git(dir)), { name: 'other', url: 'https://git.overleaf.com/123456' });
  sh(dir, 'remote', 'add', 'overleaf', p.url);
  assert.deepEqual(await findRemote(git(dir)), { name: 'overleaf', url: p.url });
});

test('sync: local and Overleaf edits to different files are merged and pushed', async () => {
  const p = newProject({ 'main.tex': 'main\n', 'ch1.tex': 'one\n' });
  const dir = await cloneProject(p.url);
  editOnOverleaf(p.bare, 'ch1.tex', 'one (web)\n');
  fs.writeFileSync(path.join(dir, 'main.tex'), 'main (local)\n');
  fs.writeFileSync(path.join(dir, 'main.aux'), 'build output');
  fs.writeFileSync(path.join(dir, 'new.tex'), 'new file\n');
  const r = await sync(git(dir), dir, 'origin', msg);
  assert.equal(r.kind, 'ok');
  assert.equal(read(dir, 'ch1.tex'), 'one (web)\n');
  assert.equal(read(dir, 'main.tex'), 'main (local)\n');
  assert.equal(serverFile(p.bare, 'main.tex'), 'main (local)\n');
  assert.equal(serverFile(p.bare, 'new.tex'), 'new file\n');
  assert.throws(() => serverFile(p.bare, 'main.aux'), 'build output is not uploaded');
  assert.ok(fs.existsSync(path.join(dir, 'main.aux')), 'excluded files are left alone locally');
  const st = await status(git(dir), 'origin');
  assert.deepEqual([st.ahead, st.behind, st.merging], [0, 0, false]);
  assert.equal((await sync(git(dir), dir, 'origin', msg)).kind, 'nothing');
});

test('sync: a conflict stops before pushing, can be aborted back to the local version, or resolved by hand', async () => {
  const p = newProject({ 'main.tex': 'line A\n' });
  const dir = await cloneProject(p.url);
  editOnOverleaf(p.bare, 'main.tex', 'line A (web)\n');
  fs.writeFileSync(path.join(dir, 'main.tex'), 'line A (local)\n');
  const r = await sync(git(dir), dir, 'origin', msg);
  assert.equal(r.kind, 'conflict');
  assert.deepEqual(r.kind === 'conflict' && r.files, ['main.tex']);
  assert.equal(serverFile(p.bare, 'main.tex'), 'line A (web)\n', 'nothing pushed');

  // Abort: back to exactly the local text.
  await git(dir).run(['merge', '--abort']);
  assert.equal(read(dir, 'main.tex'), 'line A (local)\n');

  // Sync again, then resolve by editing the file (no staging) and sync once more.
  assert.equal((await sync(git(dir), dir, 'origin', msg)).kind, 'conflict');
  assert.equal((await sync(git(dir), dir, 'origin', msg)).kind, 'conflict', 'markers still present');
  fs.writeFileSync(path.join(dir, 'main.tex'), 'line A (both)\n');
  const r2 = await sync(git(dir), dir, 'origin', msg);
  assert.equal(r2.kind, 'ok');
  assert.equal(serverFile(p.bare, 'main.tex'), 'line A (both)\n');
});

test('pull-only: fast-forwards without committing and never overwrites uncommitted edits', async () => {
  const p = newProject({ 'main.tex': 'main\n', 'ch1.tex': 'one\n' });
  const dir = await cloneProject(p.url);
  const pull = { push: false, commit: false, message: '' };
  editOnOverleaf(p.bare, 'ch1.tex', 'one (web)\n');
  fs.writeFileSync(path.join(dir, 'main.tex'), 'main (unsaved work)\n');
  assert.equal((await sync(git(dir), dir, 'origin', pull)).kind, 'ok');
  assert.equal(read(dir, 'ch1.tex'), 'one (web)\n');
  assert.equal(read(dir, 'main.tex'), 'main (unsaved work)\n');
  assert.equal(serverFile(p.bare, 'main.tex'), 'main\n', 'pull-only pushes nothing');

  editOnOverleaf(p.bare, 'main.tex', 'main (web)\n');
  const r = await sync(git(dir), dir, 'origin', pull);
  assert.equal(r.kind, 'behind');
  assert.equal(read(dir, 'main.tex'), 'main (unsaved work)\n', 'local edit untouched');
});

test('link: an existing local folder is merged with the Overleaf project; local files stay byte-identical', async () => {
  const p = newProject();
  const dir = fs.mkdtempSync(path.join(tmp, 'thesis-'));
  const files: Record<string, string | Buffer> = {
    'thesis.tex': '\\documentclass{report}\n\\begin{document}\nZażółć gęślą jaźń\n\\end{document}\n',
    'chapters/intro.tex': 'Intro\n', 'bib.bib': '@book{x, title={T}}\n',
    'images/logo.pdf': Buffer.from('%PDF-1.4 logo'), 'images/fig.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]),
    'thesis.pdf': Buffer.from('%PDF-1.4 compiled'), 'thesis.aux': 'aux', '.vscode/settings.json': '{}',
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }

  const plan = await planLink(git(dir), dir, p.url, path.join(tmp, 'scratch'));
  assert.deepEqual(plan, { initialize: true, files: ['bib.bib', 'chapters/intro.tex', 'images/fig.png', 'images/logo.pdf', 'thesis.tex'] });
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'planning leaves the folder untouched');
  await prepareLink(git(dir), dir, p.url);
  const r = await sync(git(dir), dir, 'overleaf', { ...msg, allowUnrelated: true });
  assert.equal(r.kind, 'ok');
  for (const [f, c] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(dir, f)), Buffer.from(c), f);
  assert.match(read(dir, 'main.tex'), /Hello/, 'Overleaf files arrive');
  assert.equal(serverFile(p.bare, 'chapters/intro.tex'), 'Intro\n');
  assert.equal(sh(p.bare, 'rev-parse', 'main:images/fig.png'), sh(dir, 'hash-object', 'images/fig.png'), 'binary uploaded intact');
  for (const f of ['thesis.pdf', 'thesis.aux', '.vscode/settings.json']) assert.throws(() => serverFile(p.bare, f), f);
});

test('link: refuses a repository with uncommitted changes and changes nothing', async () => {
  const p = newProject();
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  sh(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.tex'), 'a\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'mine');
  fs.writeFileSync(path.join(dir, 'a.tex'), 'a (wip)\n');
  const before = read(dir, '.git', 'config');
  await assert.rejects(planLink(git(dir), dir, p.url, path.join(tmp, 'scratch')), /uncommitted changes/);
  await assert.rejects(prepareLink(git(dir), dir, p.url), /uncommitted changes/);
  assert.equal(read(dir, '.git', 'config'), before);
  assert.equal(read(dir, 'a.tex'), 'a (wip)\n');
});

test('link: a folder inside another repository is refused', async () => {
  const p = newProject();
  const outer = fs.mkdtempSync(path.join(tmp, 'outer-'));
  sh(outer, 'init', '-q');
  const inner = path.join(outer, 'paper');
  fs.mkdirSync(inner);
  await assert.rejects(planLink(git(inner), inner, p.url, path.join(tmp, 'scratch')), /inside the git repository/);
  await assert.rejects(prepareLink(git(inner), inner, p.url), /inside the git repository/);
  assert.ok(!fs.existsSync(path.join(inner, '.git')));
});

test('link: an empty folder simply receives the project', async () => {
  const p = newProject();
  const dir = fs.mkdtempSync(path.join(tmp, 'empty-'));
  await prepareLink(git(dir), dir, p.url);
  assert.equal((await sync(git(dir), dir, 'overleaf', { ...msg, allowUnrelated: true })).kind, 'ok');
  assert.match(read(dir, 'main.tex'), /Hello/);
});

test('excludes: our block is idempotent and the user\'s own lines survive', async () => {
  const p = newProject();
  const dir = await cloneProject(p.url);
  const file = path.join(dir, '.git', 'info', 'exclude');
  fs.writeFileSync(file, '# mine\nsecret.txt');
  await ensureExcludes(git(dir), dir);
  const once = read(file);
  await ensureExcludes(git(dir), dir);
  assert.equal(read(file), once);
  assert.match(once, /^# mine\nsecret\.txt\n/);
  assert.match(once, /^\/main\.pdf$/m);
  assert.equal(once.match(/livetex: local build output/g)?.length, 1);
});

test('excludes: a block written under the old extension name is replaced, not duplicated', async () => {
  const p = newProject();
  const dir = await cloneProject(p.url);
  const file = path.join(dir, '.git', 'info', 'exclude');
  fs.writeFileSync(file, '# mine\n# >>> latex-live: local build output, not synced to Overleaf\n*.aux\n# <<< latex-live\nkeep.me\n');
  await ensureExcludes(git(dir), dir);
  const out = read(file);
  assert.ok(!out.includes('latex-live'));
  assert.equal(out.match(/livetex: local build output/g)?.length, 1);
  assert.match(out, /^# mine\n/);
  assert.match(out, /^keep\.me$/m);
});
