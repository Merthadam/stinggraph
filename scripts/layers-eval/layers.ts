/**
 * Service-layer spike (docs/design/service-layers.md), part 1: map every indexed
 * file to an L1 service / L2 module twice — from `.stinggraph/layers.yaml`
 * (declared) and from manifests + compose run config alone (inferred) — and
 * report how far the two agree.
 *
 *   npm run build
 *   npx tsx --tsconfig scripts/layers-eval/tsconfig.json scripts/layers-eval/layers.ts --repo <indexed repo> [--out <dir>]
 *
 * Reads the repo's existing `.codegraph/` index (files + import edges); never
 * writes to the repo. No src/ changes: this is the measurement before the engine.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';

/* eslint-disable @typescript-eslint/no-var-requires */
const dist = path.resolve(__dirname, '../../dist');
const { getDatabasePath } = require(dist);
const { createDatabase } = require(path.join(dist, 'db/sqlite-adapter'));

// ---------------------------------------------------------------------------
// Minimal YAML subset: block maps, block lists (incl. `- key: v` items), flow
// `[..]` / `{..}`, quoted scalars, `#` comments. No new dependency, same call as
// workspace-packages.ts's pnpm-workspace reader.
// shortcut: no anchors, multi-line scalars or `key:\n- item` lists at the key's own indent; enough for layers.yaml and compose run config, swap for a real parser if the engine adopts this.
// ---------------------------------------------------------------------------
export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string): Yaml {
  const s = raw.trim();
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === '' || s === 'null' || s === '~') return null;
  return s;
}

function parseFlow(src: string): Yaml {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  const value = (): Yaml => {
    ws();
    const c = src[i];
    if (c === '[') {
      i++; const out: Yaml[] = [];
      for (ws(); src[i] !== ']'; ws()) { out.push(value()); ws(); if (src[i] === ',') i++; ws(); }
      i++; return out;
    }
    if (c === '{') {
      i++; const out: { [k: string]: Yaml } = {};
      for (ws(); src[i] !== '}'; ws()) {
        const colon = src.indexOf(':', i);
        const key = src.slice(i, colon).trim(); i = colon + 1;
        out[key] = value(); ws(); if (src[i] === ',') i++;
      }
      i++; return out;
    }
    if (c === '"' || c === "'") { const end = src.indexOf(c, i + 1); const s = src.slice(i + 1, end); i = end + 1; return s; }
    const start = i;
    while (i < src.length && !',]}'.includes(src[i]!)) i++;
    return parseScalar(src.slice(start, i));
  };
  const out = value();
  if (src.slice(i).trim()) throw new Error(`yaml: trailing text after flow value: ${src}`);
  return out;
}

export function parseYaml(text: string): Yaml {
  const lines: Array<{ indent: number; text: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const body = stripComment(raw).replace(/\s+$/, '');
    if (!body.trim()) continue;
    let indent = body.length - body.trimStart().length;
    let rest = body.trimStart();
    // `- key: v` → a bare `-` plus `key: v` one level in, so items parse as maps.
    while (rest.startsWith('- ') && /^[^\s"'[{][^:]*:(\s|$)/.test(rest.slice(2).trimStart())) {
      lines.push({ indent, text: '-' });
      const inner = rest.slice(2);
      indent += 2 + (inner.length - inner.trimStart().length);
      rest = inner.trimStart();
    }
    lines.push({ indent, text: rest });
  }
  let pos = 0;
  const block = (indent: number): Yaml => {
    if (lines[pos]!.text === '-' || lines[pos]!.text.startsWith('- ')) {
      const list: Yaml[] = [];
      while (pos < lines.length && lines[pos]!.indent === indent && (lines[pos]!.text === '-' || lines[pos]!.text.startsWith('- '))) {
        const t = lines[pos++]!.text;
        if (t === '-') list.push(pos < lines.length && lines[pos]!.indent > indent ? block(lines[pos]!.indent) : null);
        else list.push(parseScalar(t.slice(2)));
      }
      return list;
    }
    const map: { [k: string]: Yaml } = {};
    while (pos < lines.length && lines[pos]!.indent === indent) {
      const t = lines[pos++]!.text;
      const m = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(t);
      if (!m) throw new Error(`yaml: expected "key: value" at "${t}"`);
      const key = m[1]!.replace(/^["']|["']$/g, '').trim();
      if (m[2] !== undefined && m[2] !== '') map[key] = parseScalar(m[2]);
      else map[key] = pos < lines.length && lines[pos]!.indent > indent ? block(lines[pos]!.indent) : null;
    }
    return map;
  };
  return lines.length ? block(lines[0]!.indent) : null;
}

assert.deepStrictEqual(
  parseYaml('a: 1 # c\nb:\n  - id: x\n    tags: [p, "q r"]\n  - { id: y, inc: ["s/**"] }\n  - plain\nc: "x: y"\nd:\n  e: f\n'),
  { a: 1, b: [{ id: 'x', tags: ['p', 'q r'] }, { id: 'y', inc: ['s/**'] }, 'plain'], c: 'x: y', d: { e: 'f' } },
  'yaml subset self-check',
);

// ---------------------------------------------------------------------------
// Declared layers (.stinggraph/layers.yaml)
// ---------------------------------------------------------------------------
export interface LayerUnit { id: string; label: string; aliases: string[]; include: string[]; exclude: string[] }
export interface LayerService extends LayerUnit { modules: LayerUnit[] }
export interface Assignment { service: string | null; module: string | null }

const strings = (v: Yaml | undefined): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
const unit = (v: { [k: string]: Yaml }): LayerUnit => ({
  id: String(v.id), label: String(v.label ?? v.id), aliases: strings(v.aliases), include: strings(v.include), exclude: strings(v.exclude),
});

export function loadLayers(root: string): LayerService[] | null {
  const file = path.join(root, '.stinggraph', 'layers.yaml');
  if (!fs.existsSync(file)) return null;
  const doc = parseYaml(fs.readFileSync(file, 'utf8')) as { [k: string]: Yaml };
  if (doc.version !== 1) throw new Error(`layers.yaml: unsupported version ${String(doc.version)}`);
  return (doc.services as Array<{ [k: string]: Yaml }>).map((s) => ({
    ...unit(s), modules: ((s.modules ?? []) as Array<{ [k: string]: Yaml }>).map(unit),
  }));
}

const matcher = (u: LayerUnit) => {
  const inc = picomatch(u.include, { dot: true });
  const exc = u.exclude.length ? picomatch(u.exclude, { dot: true }) : () => false;
  return (f: string) => inc(f) && !exc(f);
};

/** The folder a glob list is rooted at (`services/crud/**` → `services/crud`), with `src/` stepped into when present. */
function sourceRoot(root: string, include: string[]): string {
  const bases = include.map((g) => { const parts = g.split('/'); const glob = parts.findIndex((s) => /[*?{[]/.test(s)); return glob === -1 ? parts.slice(0, -1) : parts.slice(0, glob); });
  const common = bases.reduce((a, b) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return a.slice(0, n); });
  const dir = common.join('/');
  return fs.existsSync(path.join(root, dir, 'src')) ? path.posix.join(dir, 'src') : dir;
}

/** Default L2: the first folder level under the service's source root. */
function folderModule(srcRoot: string, file: string): string {
  const rel = srcRoot ? path.posix.relative(srcRoot, file) : file;
  const parts = rel.split('/');
  return parts.length > 1 && !rel.startsWith('..') ? parts[0]! : '(root)';
}

export function assignDeclared(root: string, files: string[], services: LayerService[]) {
  const byFile = new Map<string, Assignment>();
  const conflicts: Array<{ file: string; services: string[] }> = [];
  const compiled = services.map((s) => ({ s, match: matcher(s), src: sourceRoot(root, s.include), modules: s.modules.map((m) => ({ m, match: matcher(m) })) }));
  for (const f of files) {
    const hits = compiled.filter((c) => c.match(f));
    if (hits.length > 1) conflicts.push({ file: f, services: hits.map((h) => h.s.id) });
    const c = hits[0];
    if (!c) { byFile.set(f, { service: null, module: null }); continue; }
    const mod = c.modules.find((m) => m.match(f));
    byFile.set(f, { service: c.s.id, module: mod ? mod.m.id : folderModule(c.src, f) });
  }
  return { byFile, conflicts };
}

// ---------------------------------------------------------------------------
// Inferred layers: workspace packages, manifest roots, compose run commands.
// ---------------------------------------------------------------------------
export interface InferredService { id: string; dir: string; sources: string[]; modules: Array<{ id: string; entry: string; files: string[] }> }

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.codegraph', '.stinggraph', 'dist', 'build', '.venv', 'venv', 'target']);

function manifestDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.posix.join(rel, e.name));
      else if (e.isFile() && MANIFESTS.includes(e.name) && rel) out.push(rel);
    }
  };
  walk('');
  return [...new Set(out)];
}

function workspaceGlobs(root: string): string[] {
  const out: string[] = [];
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces;
    out.push(...strings(Array.isArray(ws) ? ws : ws?.packages));
  } catch { /* no root package.json */ }
  try {
    const doc = parseYaml(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')) as { [k: string]: Yaml };
    out.push(...strings(doc.packages));
  } catch { /* no pnpm workspace */ }
  return out;
}

/** The command a compose service runs: its `command`, else the CMD of the Dockerfile it builds (compose's own fallback). */
function composeCommand(root: string, svc: { [k: string]: Yaml }): { argv: string[]; from: string } | null {
  if (svc.command != null) return { argv: Array.isArray(svc.command) ? svc.command.map(String) : String(svc.command).split(/\s+/), from: 'command' };
  const build = svc.build as { [k: string]: Yaml } | string | undefined;
  if (!build) return null;
  const ctx = typeof build === 'string' ? build : String(build.context ?? '.');
  const dockerfile = path.join(root, ctx, typeof build === 'string' ? 'Dockerfile' : String(build.dockerfile ?? 'Dockerfile'));
  if (!fs.existsSync(dockerfile)) return null;
  const cmd = fs.readFileSync(dockerfile, 'utf8').split(/\r?\n/).filter((l) => /^CMD\s/.test(l)).pop();
  if (!cmd) return null;
  const body = cmd.replace(/^CMD\s+/, '');
  return { argv: body.startsWith('[') ? (JSON.parse(body) as string[]) : body.split(/\s+/), from: `${path.basename(dockerfile)} CMD` };
}

/** Repo file a run command enters: `-m pkg.mod`, `uvicorn pkg.mod:app`, or a path argument. */
function commandEntry(root: string, argv: string[], workdir: string): string | null {
  const moduleFile = (mod: string) => {
    const base = mod.replace(/\./g, '/');
    return [`${base}.py`, `${base}/__init__.py`].find((f) => fs.existsSync(path.join(root, f))) ?? null;
  };
  const m = argv.indexOf('-m');
  if (m >= 0 && argv[m + 1]) return moduleFile(argv[m + 1]!);
  const server = argv.findIndex((a) => /^(uvicorn|gunicorn|hypercorn)$/.test(a));
  if (server >= 0) {
    const target = argv.slice(server + 1).find((a) => !a.startsWith('-') && /^[\w.]+:[\w.()]+$/.test(a));
    if (target) return moduleFile(target.split(':')[0]!);
  }
  for (const a of argv) {
    if (!a.includes('/')) continue;
    const rel = a.startsWith(workdir + '/') ? a.slice(workdir.length + 1) : a.replace(/^\.\//, '');
    if (fs.existsSync(path.join(root, rel))) return rel;
  }
  return null;
}

function importClosure(entry: string, dir: string, imports: Map<string, string[]>): Set<string> {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) for (const t of imports.get(queue.shift()!) ?? []) {
    if (!seen.has(t) && t.startsWith(dir + '/')) { seen.add(t); queue.push(t); }
  }
  return seen;
}

export function inferLayers(root: string, files: string[], imports: Map<string, string[]>) {
  const roots = new Map<string, { sources: Set<string>; compose: Array<{ name: string; entry: string | null; from: string }> }>();
  const addRoot = (dir: string, source: string) => {
    if (!dir || dir === '.') return;
    if (!roots.has(dir)) roots.set(dir, { sources: new Set(), compose: [] });
    roots.get(dir)!.sources.add(source);
    return roots.get(dir)!;
  };
  const wsMatch = picomatch(workspaceGlobs(root).length ? workspaceGlobs(root) : ['\0none']);
  for (const dir of manifestDirs(root)) addRoot(dir, wsMatch(dir) ? 'workspace package' : 'manifest');

  const composeNotes: Array<{ name: string; argv: string | null; from: string | null; entry: string | null }> = [];
  const composeFile = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].find((f) => fs.existsSync(path.join(root, f)));
  if (composeFile) {
    const doc = parseYaml(fs.readFileSync(path.join(root, composeFile), 'utf8')) as { [k: string]: Yaml };
    for (const [name, svc] of Object.entries((doc.services ?? {}) as { [k: string]: { [k: string]: Yaml } })) {
      const cmd = composeCommand(root, svc);
      const entry = cmd ? commandEntry(root, cmd.argv, String(svc.working_dir ?? '/app')) : null;
      composeNotes.push({ name, argv: cmd ? cmd.argv.join(' ') : null, from: cmd?.from ?? null, entry });
      if (entry) addRoot(path.posix.dirname(entry), 'compose')?.compose.push({ name, entry, from: cmd!.from });
    }
  }

  const services: InferredService[] = [];
  for (const [dir, r] of roots) {
    // Named after the one compose service that runs it, else the folder (several compose services share it → they become L2 modules).
    const runners = r.compose.filter((c) => c.entry && /\.py$/.test(c.entry));
    const id = r.compose.length === 1 ? r.compose[0]!.name : path.posix.basename(dir);
    const closures = runners.length > 1 ? runners.map((c) => ({ id: c.name, entry: c.entry!, files: importClosure(c.entry!, dir, imports) })) : [];
    const modules = closures.map((c) => ({
      id: c.id, entry: c.entry,
      files: [...c.files].filter((f) => !closures.some((o) => o !== c && o.files.has(f))).sort(),
    }));
    services.push({ id, dir, sources: [...r.sources, ...r.compose.map((c) => `compose:${c.name} (${c.from})`)], modules });
  }

  const byFile = new Map<string, Assignment>();
  for (const f of files) {
    const s = services.filter((x) => f.startsWith(x.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (!s) { byFile.set(f, { service: null, module: null }); continue; }
    const mod = s.modules.find((m) => m.files.includes(f));
    byFile.set(f, { service: s.id, module: mod ? mod.id : folderModule(sourceRoot(root, [s.dir + '/**']), f) });
  }
  return { services, byFile, composeNotes };
}

// ---------------------------------------------------------------------------
// Index access + agreement report
// ---------------------------------------------------------------------------
export function openIndex(root: string) {
  return createDatabase(getDatabasePath(root), { readOnly: true }).db as {
    prepare(sql: string): { all(...p: unknown[]): any[]; get(...p: unknown[]): any };
    close(): void;
  };
}

export function fileImports(db: ReturnType<typeof openIndex>): Map<string, string[]> {
  const imports = new Map<string, string[]>();
  for (const r of db.prepare(`SELECT DISTINCT s.file_path AS a, t.file_path AS b FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'imports' AND s.file_path <> t.file_path`).all()) {
    if (!imports.has(r.a)) imports.set(r.a, []);
    imports.get(r.a)!.push(r.b);
  }
  return imports;
}

export function buildLayerMaps(root: string) {
  const db = openIndex(root);
  const files: string[] = db.prepare('SELECT path FROM files ORDER BY path').all().map((r) => r.path);
  const imports = fileImports(db);
  db.close();
  const declaredServices = loadLayers(root);
  const declared = declaredServices ? assignDeclared(root, files, declaredServices) : null;
  const inferred = inferLayers(root, files, imports);
  return { files, declaredServices, declared, inferred };
}

export function agreementReport(maps: ReturnType<typeof buildLayerMaps>) {
  const { files, declared, inferred, declaredServices } = maps;
  if (!declared || !declaredServices) throw new Error('agreement needs a layers.yaml');
  const perService = declaredServices.map((s) => {
    const D = new Set(files.filter((f) => declared.byFile.get(f)!.service === s.id));
    const overlap = new Map<string, number>();
    for (const f of D) {
      const i = inferred.byFile.get(f)!.service;
      if (i) overlap.set(i, (overlap.get(i) ?? 0) + 1);
    }
    const best = [...overlap].sort((a, b) => b[1] - a[1])[0];
    const I = new Set(best ? files.filter((f) => inferred.byFile.get(f)!.service === best[0]) : []);
    const both = [...D].filter((f) => I.has(f)).length;
    return {
      declared: s.id, inferred: best?.[0] ?? null, declaredFiles: D.size, inferredFiles: I.size,
      precision: I.size ? both / I.size : 0, recall: D.size ? both / D.size : 0,
      inferredOnly: [...I].filter((f) => !D.has(f)), declaredOnly: [...D].filter((f) => !I.has(f)),
    };
  });
  const moduleAgreement = declaredServices.flatMap((s) => s.modules.map((m) => {
    const D = files.filter((f) => declared.byFile.get(f)!.module === m.id);
    const I = files.filter((f) => inferred.byFile.get(f)!.module === m.id);
    return { service: s.id, module: m.id, declared: D, inferred: I };
  }));
  const unassigned = {
    declared: files.filter((f) => !declared.byFile.get(f)!.service),
    inferred: files.filter((f) => !inferred.byFile.get(f)!.service),
  };
  const fileAgreement = files.filter((f) => {
    const d = declared.byFile.get(f)!.service; const i = inferred.byFile.get(f)!.service;
    const mapped = perService.find((p) => p.declared === d)?.inferred ?? null;
    return d ? mapped === i : i === null;
  }).length;
  return { files: files.length, fileAgreement, perService, moduleAgreement, unassigned, conflicts: declared.conflicts };
}

if (require.main === module) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const repo = path.resolve(arg('--repo') ?? '.');
  const out = path.resolve(arg('--out') ?? '/tmp/layers-eval-results');
  const maps = buildLayerMaps(repo);
  const report = agreementReport(maps);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'layers.json'), JSON.stringify({
    repo, inferredServices: maps.inferred.services, compose: maps.inferred.composeNotes, report,
    perFile: maps.files.map((f) => ({ file: f, declared: maps.declared!.byFile.get(f), inferred: maps.inferred.byFile.get(f) })),
  }, null, 2));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const md = [
    `# Layers: inferred vs declared (${repo})`, '',
    `${report.fileAgreement}/${report.files} indexed files get the same L1 service both ways (unassigned counts as a service). Config conflicts: ${report.conflicts.length}.`, '',
    '## Inferred services', '',
    ...maps.inferred.services.map((s) => `- \`${s.id}\` at \`${s.dir}/\` — ${s.sources.join(', ')}${s.modules.length ? `; modules: ${s.modules.map((m) => `${m.id} (${m.files.length} files from ${m.entry})`).join(', ')}` : ''}`),
    '', 'Compose services: ' + maps.inferred.composeNotes.map((c) => `${c.name} → ${c.entry ?? 'no repo entry'}${c.from ? ` (${c.from})` : ''}`).join('; '), '',
    '## Per declared service', '',
    '| declared | inferred | declared files | inferred files | precision | recall |', '|---|---|---|---|---|---|',
    ...report.perService.map((p) => `| ${p.declared} | ${p.inferred ?? '—'} | ${p.declaredFiles} | ${p.inferredFiles} | ${pct(p.precision)} | ${pct(p.recall)} |`),
    '', ...report.perService.filter((p) => p.inferredOnly.length || p.declaredOnly.length).map((p) =>
      `- ${p.declared}: inferred-only ${p.inferredOnly.length} (${summarizeDirs(p.inferredOnly)}), declared-only ${p.declaredOnly.length} (${summarizeDirs(p.declaredOnly)})`),
    '', '## Modules (declared vs inferred)', '',
    ...report.moduleAgreement.map((m) => `- ${m.service}/${m.module}: declared ${m.declared.length} (${summarizeDirs(m.declared)}), inferred ${m.inferred.length} (${summarizeDirs(m.inferred)})`),
    '', '## Unassigned', '',
    `- declared: ${report.unassigned.declared.length} (${summarizeDirs(report.unassigned.declared)})`,
    `- inferred: ${report.unassigned.inferred.length} (${summarizeDirs(report.unassigned.inferred)})`,
  ].join('\n');
  fs.writeFileSync(path.join(out, 'layers.md'), md + '\n');
  console.log(md);
}

function summarizeDirs(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) { const d = path.posix.dirname(f).split('/').slice(0, 3).join('/'); counts.set(d, (counts.get(d) ?? 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, n]) => `${d}: ${n}`).join(', ') || 'none';
}
