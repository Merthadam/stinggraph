/**
 * Service layers (docs/design/service-layers.md): every indexed file gets an L1
 * service and an L2 module, and edges roll up between them. A query-time
 * derivation only — nothing here writes nodes or edges, and explore, search and
 * FTS never read it. Read by `codegraph layers`, `CodeGraph.getLayers` /
 * `getLayerRollup`, and over a worktree overlay's merged view.
 *
 * Where names come from, a later source refining an earlier one:
 *  1. Inferred: workspace packages and manifest roots (`package.json`,
 *     `pyproject.toml`, `go.mod`, `Cargo.toml`), and compose services resolved
 *     through the module their `command` runs (else the CMD of the Dockerfile
 *     they build). Compose services sharing one folder become its modules.
 *  2. Declared: `.stinggraph/layers.yaml`. A declared service replaces every
 *     inferred service its `include:` reaches, so its `exclude:` is final.
 * A file two declared services (or two modules) match is a reported config
 * error and is left `(unassigned)` at that level, never resolved silently.
 */

import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import type { EdgeKind, Node } from '../types';
import { isTestFile } from '../search/query-utils';

export const UNASSIGNED = '(unassigned)';
export const LAYERS_CONFIG_PATH = '.stinggraph/layers.yaml';

/** Edge kinds the roll-up counts. Synthesized edges count whatever their kind. */
export const ROLLUP_EDGE_KINDS: readonly EdgeKind[] = ['calls', 'references', 'imports', 'instantiates', 'extends', 'implements'];

// ---------------------------------------------------------------------------
// YAML subset
// ---------------------------------------------------------------------------

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/**
 * A strict reader for the YAML `layers.yaml`, `pnpm-workspace.yaml` and compose
 * run config use: block maps and lists (incl. `- key: v` items and lists at
 * their key's indent), flow `[..]` / `{..}` on one line, quoted scalars, `|` /
 * `>` block scalars and `#` comments. Anything else throws rather than being
 * read wrong. No YAML library is a dependency, and this is all the files need.
 * shortcut: anchors / aliases / merge keys and multi-line plain or flow values throw; a compose file using them is reported and skipped — adopt a real parser if that shows up in practice.
 */
export function parseYamlSubset(text: string): YamlValue {
  interface Line { indent: number; text: string; no: number; block?: string }
  const raw = text.split(/\r?\n/);
  const lines: Line[] = [];
  for (let i = 0; i < raw.length; i++) {
    const body = stripComment(raw[i]!).replace(/\s+$/, '');
    if (!body.trim()) continue;
    const lead = /^[ \t]*/.exec(body)![0];
    if (lead.includes('\t')) throw yamlError(i + 1, 'tab in indentation');
    if (body.trim() === '---' || body.trim() === '...') { if (lines.length) throw yamlError(i + 1, 'multiple documents'); continue; }
    let indent = lead.length;
    let rest = body.slice(indent);
    // `- key: v` → a bare `-` plus `key: v` one level in, so the item parses as a map.
    while (rest.startsWith('- ') && /^[^\s"'[{][^:]*:(\s|$)/.test(rest.slice(2).trimStart())) {
      lines.push({ indent, text: '-', no: i + 1 });
      const inner = rest.slice(2);
      indent += 2 + (inner.length - inner.trimStart().length);
      rest = inner.trimStart();
    }
    const line: Line = { indent, text: rest, no: i + 1 };
    const blockScalar = /(?:^-|:)\s+([|>])[-+]?$/.exec(rest);
    if (blockScalar) {
      const body: string[] = [];
      while (i + 1 < raw.length && (!raw[i + 1]!.trim() || raw[i + 1]!.length - raw[i + 1]!.trimStart().length > indent)) body.push(raw[++i]!);
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      const strip = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const content = body.map((l) => l.slice(strip));
      line.block = blockScalar[1] === '|' ? content.join('\n') : content.join(' ').replace(/\s+/g, ' ').trim();
      line.text = rest.replace(/\s*[|>][-+]?$/, '');
    }
    lines.push(line);
  }

  let pos = 0;
  const isItem = (l: Line | undefined) => !!l && (l.text === '-' || l.text.startsWith('- '));
  const block = (indent: number): YamlValue => {
    if (isItem(lines[pos])) {
      const list: YamlValue[] = [];
      while (pos < lines.length && lines[pos]!.indent === indent && isItem(lines[pos])) {
        const l = lines[pos++]!;
        if (l.block !== undefined) list.push(l.block);
        else if (l.text === '-') list.push(pos < lines.length && lines[pos]!.indent > indent ? block(lines[pos]!.indent) : null);
        else list.push(parseScalar(l.text.slice(2), l.no));
      }
      return list;
    }
    const map: { [k: string]: YamlValue } = {};
    while (pos < lines.length && lines[pos]!.indent === indent && !isItem(lines[pos])) {
      const l = lines[pos++]!;
      const m = /^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/.exec(l.block !== undefined ? `${l.text} ` : l.text);
      if (!m) throw yamlError(l.no, `expected "key: value", got "${l.text}"`);
      const key = m[1]!.replace(/^(["'])(.*)\1$/, '$2').trim();
      if (Object.prototype.hasOwnProperty.call(map, key)) throw yamlError(l.no, `duplicate key "${key}"`);
      const next = lines[pos];
      if (l.block !== undefined) map[key] = l.block;
      else if (m[2] !== undefined && m[2].trim() !== '') map[key] = parseScalar(m[2], l.no);
      else if (next && next.indent > indent) map[key] = block(next.indent);
      else if (next && next.indent === indent && isItem(next)) map[key] = block(indent);
      else map[key] = null;
    }
    return map;
  };
  if (!lines.length) return null;
  const out = block(lines[0]!.indent);
  if (pos < lines.length) throw yamlError(lines[pos]!.no, 'unexpected indentation');
  return out;
}

function yamlError(line: number, message: string): Error {
  return new Error(`line ${line}: ${message}`);
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string, no: number): YamlValue {
  const s = raw.trim();
  if (s.startsWith('[') || s.startsWith('{')) return parseFlow(s, no);
  if (/^[&*!]/.test(s)) throw yamlError(no, `anchors, aliases and tags are not supported ("${s}")`);
  if (s.startsWith('"') || s.startsWith("'")) {
    const end = quotedEnd(s, 0);
    if (end !== s.length - 1) throw yamlError(no, `bad quoted scalar ${s}`);
    return unquote(s);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === '' || s === 'null' || s === '~') return null;
  return s;
}

/** Index of the quote closing the one at `start`, or -1. */
function quotedEnd(s: string, start: number): number {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") { i++; continue; }
      return i;
    }
  }
  return -1;
}

function unquote(s: string): string {
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
}

function parseFlow(src: string, no: number): YamlValue {
  let i = 0;
  const fail = (why: string): never => { throw yamlError(no, `${why} in flow value ${src}`); };
  const ws = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  const value = (): YamlValue => {
    ws();
    const c = src[i];
    if (c === '[' || c === '{') {
      const close = c === '[' ? ']' : '}';
      i++;
      const list: YamlValue[] = [];
      const map: { [k: string]: YamlValue } = {};
      for (ws(); src[i] !== close; ws()) {
        if (i >= src.length) fail('unterminated collection');
        if (c === '[') list.push(value());
        else {
          const start = i;
          const key = src[i] === '"' || src[i] === "'" ? (i = quotedEnd(src, i) + 1, unquote(src.slice(start, i))) : (() => {
            while (i < src.length && !':,}'.includes(src[i]!)) i++;
            return src.slice(start, i).trim();
          })();
          ws();
          if (src[i] !== ':') fail('expected ":"');
          i++;
          map[key] = value();
        }
        ws();
        if (src[i] === ',') i++;
        else if (i >= src.length) fail('unterminated collection');
        else if (src[i] !== close) fail('expected "," or closing bracket');
      }
      i++;
      return c === '[' ? list : map;
    }
    if (c === '"' || c === "'") {
      const end = quotedEnd(src, i);
      if (end < 0) fail('unterminated string');
      const s = unquote(src.slice(i, end + 1));
      i = end + 1;
      return s;
    }
    const start = i;
    while (i < src.length && !',]}'.includes(src[i]!)) i++;
    return parseScalar(src.slice(start, i), no);
  };
  const out = value();
  if (src.slice(i).trim()) fail('trailing text');
  return out;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type LayerLevel = 'service' | 'module';

export interface LayerAssignment { service: string; module: string }

export interface LayerConfigError {
  /** The file the problem is in: the config, the compose file, or an indexed file two units claim. */
  source: string;
  message: string;
  /** For a conflict: the units that all matched the file. */
  candidates?: string[];
}

export interface LayerEntryPoint {
  kind: 'route' | 'compose' | 'handler';
  name: string;
  file: string;
  line?: number;
}

export interface LayerModule { id: string; label: string; aliases: string[]; files: number }

export interface LayerService {
  id: string;
  label: string;
  aliases: string[];
  origin: 'declared' | 'inferred' | 'unassigned';
  /** Declared: the include globs. Inferred: the service's folder. */
  roots: string[];
  /** Why the service exists: manifests and compose runs found, or the inferred services a declared one refines. */
  evidence: string[];
  files: number;
  modules: LayerModule[];
  entryPoints: LayerEntryPoint[];
}

export interface ComposeRun {
  name: string;
  argv: string[] | null;
  /** `command`, or `<Dockerfile> CMD` when compose falls back to the image's. */
  from: string | null;
  /** The repo file the command enters, if one resolves. */
  entry: string | null;
}

export interface Layers {
  /** `.stinggraph/layers.yaml` when it was read and used, else null (inference only). */
  config: string | null;
  services: LayerService[];
  assignments: Record<string, LayerAssignment>;
  errors: LayerConfigError[];
  compose: ComposeRun[];
}

export interface LayerRollupEdge {
  from: string;
  to: string;
  total: number;
  synthesized: number;
  byKind: Partial<Record<EdgeKind, number>>;
}

export interface LayerRollup {
  level: LayerLevel;
  excludeTests: boolean;
  edges: LayerRollupEdge[];
}

export interface FileEdgeCount { source: string; target: string; kind: EdgeKind; count: number; synthesized: number }

export type LayerNode = Pick<Node, 'kind' | 'name' | 'filePath' | 'startLine' | 'endLine' | 'language' | 'isExported'>;

/** What layers read from an index: the base database or an overlay's merged view. */
export interface LayerGraphSource {
  files(): string[];
  importPairs(): Array<{ source: string; target: string }>;
  fileEdgeCounts(): FileEdgeCount[];
  routes(): LayerNode[];
  nodesInFiles(paths: string[]): LayerNode[];
}

// ---------------------------------------------------------------------------
// Declared config
// ---------------------------------------------------------------------------

interface DeclaredUnit { id: string; label: string; aliases: string[]; include: string[]; exclude: string[]; compose: string | null }
interface DeclaredService extends DeclaredUnit { modules: DeclaredUnit[] }

const SERVICE_KEYS = new Set(['id', 'label', 'aliases', 'include', 'exclude', 'modules']);
const MODULE_KEYS = new Set(['id', 'label', 'aliases', 'include', 'exclude', 'compose']);

/** Reads `.stinggraph/layers.yaml`. Any problem is reported and the whole file is ignored: half a config would misplace files. */
export function readLayersConfig(root: string, errors: LayerConfigError[]): DeclaredService[] | null {
  const file = path.join(root, LAYERS_CONFIG_PATH);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const problems: string[] = [];
  let services: DeclaredService[] = [];
  try {
    const doc = parseYamlSubset(text);
    if (!isMap(doc)) throw new Error('expected a map with `version` and `services`');
    if (doc.version !== 1) problems.push(`unsupported version ${JSON.stringify(doc.version ?? null)} (expected 1)`);
    for (const key of Object.keys(doc)) if (key !== 'version' && key !== 'services') problems.push(`unknown key "${key}"`);
    if (!Array.isArray(doc.services)) problems.push('`services` must be a list');
    else services = doc.services.map((s, i) => readUnit(s, `services[${i}]`, SERVICE_KEYS, problems) as DeclaredService);
    const ids = new Set<string>();
    for (const s of services) {
      if (ids.has(s.id)) problems.push(`duplicate service id "${s.id}"`);
      ids.add(s.id);
      if (!s.include.length) problems.push(`service "${s.id}" needs a non-empty include`);
      const moduleIds = new Set<string>();
      for (const m of s.modules) {
        if (moduleIds.has(m.id)) problems.push(`duplicate module id "${s.id}/${m.id}"`);
        moduleIds.add(m.id);
        if (!m.include.length === !m.compose) problems.push(`module "${s.id}/${m.id}" needs exactly one of include or compose`);
      }
    }
  } catch (err) {
    problems.push(`could not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const message of problems) errors.push({ source: LAYERS_CONFIG_PATH, message });
  return problems.length ? null : services;
}

function readUnit(v: YamlValue, where: string, keys: Set<string>, problems: string[]): DeclaredUnit | DeclaredService {
  if (!isMap(v)) { problems.push(`${where} must be a map`); return { id: where, label: where, aliases: [], include: [], exclude: [], compose: null, modules: [] }; }
  for (const key of Object.keys(v)) if (!keys.has(key)) problems.push(`${where}: unknown key "${key}"`);
  const id = typeof v.id === 'string' || typeof v.id === 'number' ? String(v.id) : '';
  if (!/^[\w.-]+$/.test(id)) problems.push(`${where}: id must be a non-empty word (letters, digits, "_", "-", ".")`);
  const list = (key: string): string[] => {
    const x = v[key];
    if (x == null) return [];
    if (Array.isArray(x) && x.every((e) => typeof e === 'string')) return x as string[];
    if (typeof x === 'string') return [x];
    problems.push(`${where}: ${key} must be a string or a list of strings`);
    return [];
  };
  const modules = Array.isArray(v.modules) ? v.modules.map((m, i) => readUnit(m, `${where}.modules[${i}]`, MODULE_KEYS, problems)) : [];
  if (v.modules != null && !Array.isArray(v.modules)) problems.push(`${where}: modules must be a list`);
  return {
    id, label: v.label == null ? id : String(v.label), aliases: list('aliases'), include: list('include'), exclude: list('exclude'),
    compose: v.compose == null ? null : String(v.compose), modules,
  };
}

function isMap(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

interface InferredService {
  id: string;
  dir: string;
  evidence: string[];
  /** Compose services sharing this folder: each one's entry plus what only it imports. */
  composeModules: Array<{ id: string; files: Set<string> }>;
}

interface Inference { services: InferredService[]; compose: ComposeRun[] }

function inferServices(root: string, files: string[], importPairs: Array<{ source: string; target: string }>, errors: LayerConfigError[]): Inference {
  const roots = new Map<string, { evidence: string[]; runs: ComposeRun[] }>();
  const addRoot = (dir: string, evidence: string) => {
    if (!roots.has(dir)) roots.set(dir, { evidence: [], runs: [] });
    roots.get(dir)!.evidence.push(evidence);
    return roots.get(dir)!;
  };

  // Manifest roots, looked for only in folders that hold indexed files (and their parents) — never a walk of node_modules.
  const workspace = workspaceGlobs(root, errors);
  const isWorkspace = workspace.length ? picomatch(workspace) : () => false;
  const dirs = new Set<string>();
  for (const f of files) for (let d = path.posix.dirname(f); d !== '.' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  for (const dir of [...dirs].sort()) {
    const manifest = MANIFESTS.find((m) => fs.existsSync(path.join(root, dir, m)));
    if (manifest) addRoot(dir, isWorkspace(dir) ? `workspace package (${manifest})` : `manifest (${manifest})`);
  }
  const manifestDirs = [...roots.keys()];

  const compose: ComposeRun[] = [];
  const composeFile = COMPOSE_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (composeFile) {
    let doc: YamlValue = null;
    try { doc = parseYamlSubset(fs.readFileSync(path.join(root, composeFile), 'utf8')); } catch (err) {
      errors.push({ source: composeFile, message: `could not read compose services: ${err instanceof Error ? err.message : String(err)}` });
    }
    const services = isMap(doc) && isMap(doc.services) ? doc.services : {};
    for (const [name, svc] of Object.entries(services)) {
      if (!isMap(svc)) continue;
      const cmd = composeCommand(root, svc);
      const entry = cmd ? commandEntry(root, cmd.argv, typeof svc.working_dir === 'string' ? svc.working_dir : '/app') : null;
      compose.push({ name, argv: cmd?.argv ?? null, from: cmd?.from ?? null, entry });
      if (!entry) continue;
      // The manifest root holding the entry, else the entry's own folder.
      const owner = manifestDirs.filter((d) => entry.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0] ?? path.posix.dirname(entry);
      if (owner !== '.') addRoot(owner, `compose:${name} (${cmd!.from})`).runs.push(compose[compose.length - 1]!);
    }
  }

  const imports = new Map<string, string[]>();
  for (const p of importPairs) {
    if (!imports.has(p.source)) imports.set(p.source, []);
    imports.get(p.source)!.push(p.target);
  }
  const indexed = new Set(files);
  const out: InferredService[] = [];
  for (const [dir, r] of roots) {
    // Named after the one compose service that runs it, else the folder.
    const id = r.runs.length === 1 ? r.runs[0]!.name : path.posix.basename(dir);
    const runners = r.runs.filter((c) => c.entry && indexed.has(c.entry));
    const closures = runners.length > 1 ? runners.map((c) => ({ id: c.name, files: importClosure(c.entry!, dir, imports) })) : [];
    const composeModules = closures.map((c) => ({
      id: c.id,
      files: new Set([...c.files].filter((f) => !closures.some((o) => o !== c && o.files.has(f)))),
    }));
    out.push({ id, dir, evidence: r.evidence, composeModules });
  }
  // Two folders with one name (`packages/a/server`, `packages/b/server`) keep their paths as ids.
  for (const s of out) if (out.filter((o) => o.id === s.id).length > 1) s.id = s.dir;
  return { services: out.sort((a, b) => a.dir.localeCompare(b.dir)), compose };
}

function workspaceGlobs(root: string, errors: LayerConfigError[]): string[] {
  const out: string[] = [];
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces;
    const list = Array.isArray(ws) ? ws : ws?.packages;
    if (Array.isArray(list)) out.push(...list.filter((g): g is string => typeof g === 'string'));
  } catch { /* no root package.json, or not JSON: not a workspace */ }
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    try {
      const doc = parseYamlSubset(fs.readFileSync(pnpm, 'utf8'));
      if (isMap(doc) && Array.isArray(doc.packages)) out.push(...doc.packages.filter((g): g is string => typeof g === 'string'));
    } catch (err) {
      errors.push({ source: 'pnpm-workspace.yaml', message: `could not parse: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out.map((g) => g.replace(/^\.\//, '').replace(/\/$/, '')).filter((g) => !g.startsWith('!'));
}

/** The command a compose service runs: `entrypoint` + `command`, else the CMD of the Dockerfile it builds (compose's own fallback). */
function composeCommand(root: string, svc: { [k: string]: YamlValue }): { argv: string[]; from: string } | null {
  const argv = (v: YamlValue | undefined): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : String(v).split(/\s+/).filter(Boolean));
  if (svc.command != null || svc.entrypoint != null) {
    return { argv: [...argv(svc.entrypoint), ...argv(svc.command)], from: svc.command != null ? 'command' : 'entrypoint' };
  }
  const build = svc.build;
  if (build == null) return null;
  const ctx = isMap(build) ? String(build.context ?? '.') : String(build);
  const dockerfile = path.join(root, ctx, isMap(build) && build.dockerfile != null ? String(build.dockerfile) : 'Dockerfile');
  let text: string;
  try { text = fs.readFileSync(dockerfile, 'utf8'); } catch { return null; }
  const cmd = text.split(/\r?\n/).filter((l) => /^CMD\s/i.test(l)).pop();
  if (!cmd) return null;
  const body = cmd.replace(/^CMD\s+/i, '').trim();
  let parsed: string[] = body.split(/\s+/);
  if (body.startsWith('[')) { try { parsed = JSON.parse(body) as string[]; } catch { /* shell form after all */ } }
  return { argv: parsed, from: `${path.basename(dockerfile)} CMD` };
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
    const rel = a.startsWith(workdir.replace(/\/$/, '') + '/') ? a.slice(workdir.replace(/\/$/, '').length + 1) : a.replace(/^\.\//, '');
    if (!path.isAbsolute(rel) && fs.existsSync(path.join(root, rel))) return rel;
  }
  return null;
}

function importClosure(entry: string, dir: string, imports: Map<string, string[]>): Set<string> {
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    for (const t of imports.get(queue.shift()!) ?? []) {
      if (!seen.has(t) && t.startsWith(dir + '/')) { seen.add(t); queue.push(t); }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** The folder a glob list is rooted at (`services/crud/**` → `services/crud`), stepping into `src/` when present. */
function sourceRoot(root: string, include: string[]): string {
  const bases = include.map((g) => {
    const parts = g.split('/');
    const glob = parts.findIndex((s) => /[*?{[]/.test(s));
    return glob === -1 ? parts.slice(0, -1) : parts.slice(0, glob);
  });
  const common = bases.reduce((a, b) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return a.slice(0, n); });
  const dir = common.join('/');
  return fs.existsSync(path.join(root, dir, 'src')) ? path.posix.join(dir, 'src') : dir;
}

/** Default L2: the first folder under the service's source root, `(root)` for a file directly in it. */
function folderModule(srcRoot: string, file: string): string {
  const rel = srcRoot ? path.posix.relative(srcRoot, file) : file;
  const parts = rel.split('/');
  return parts.length > 1 && !rel.startsWith('..') ? parts[0]! : '(root)';
}

const globMatcher = (globs: string[]) => (globs.length ? picomatch(globs, { dot: true }) : () => false);

/** Every file's service and module, the services with their counts, and what went wrong. Entry points are left empty; see {@link computeLayers}. */
export function assignLayers(root: string, indexedFiles: string[], importPairs: Array<{ source: string; target: string }>): Layers {
  const files = [...indexedFiles].sort();
  const errors: LayerConfigError[] = [];
  const inference = inferServices(root, files, importPairs, errors);
  const declared = readLayersConfig(root, errors);

  const inferredByFile = new Map<string, InferredService>();
  for (const f of files) {
    const i = inference.services.filter((s) => f.startsWith(s.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (i) inferredByFile.set(f, i);
  }
  const composeModuleOf = (f: string) => {
    for (const s of inference.services) for (const m of s.composeModules) if (m.files.has(f)) return m.id;
    return null;
  };

  const compiled = (declared ?? []).map((s) => {
    const include = globMatcher(s.include);
    const exclude = globMatcher(s.exclude);
    return {
      s, include, match: (f: string) => include(f) && !exclude(f), src: sourceRoot(root, s.include),
      modules: s.modules.map((m) => {
        let match: (f: string) => boolean;
        if (m.compose) {
          const composed = inference.services.flatMap((i) => i.composeModules).find((c) => c.id === m.compose);
          const run = inference.compose.find((c) => c.name === m.compose);
          if (!composed && !run?.entry) errors.push({ source: LAYERS_CONFIG_PATH, message: `module "${s.id}/${m.id}": no compose service "${m.compose}" with a resolvable entry` });
          const set = composed?.files ?? new Set(run?.entry ? [run.entry] : []);
          match = (f) => set.has(f);
        } else {
          const inc = globMatcher(m.include);
          const exc = globMatcher(m.exclude);
          match = (f) => inc(f) && !exc(f);
        }
        return { m, match };
      }),
    };
  });

  // A declared service replaces every inferred service it reaches (or shares an id with).
  const refines = new Map<string, string[]>();
  const replaced = new Set<InferredService>();
  for (const i of inference.services) {
    const own = files.filter((f) => inferredByFile.get(f) === i);
    const by = compiled.filter((c) => c.s.id === i.id || own.some((f) => c.include(f)));
    for (const c of by) refines.set(c.s.id, [...(refines.get(c.s.id) ?? []), i.id]);
    if (by.length) replaced.add(i);
  }
  const kept = inference.services.filter((i) => !replaced.has(i));

  const assignments: Record<string, LayerAssignment> = {};
  const unassigned: LayerAssignment = { service: UNASSIGNED, module: UNASSIGNED };
  for (const f of files) {
    const hits = compiled.filter((c) => c.match(f));
    if (hits.length > 1) {
      errors.push({ source: f, message: `matches ${hits.length} services; left ${UNASSIGNED}`, candidates: hits.map((h) => h.s.id) });
      assignments[f] = unassigned;
      continue;
    }
    const c = hits[0];
    if (c) {
      const mods = c.modules.filter((m) => m.match(f));
      if (mods.length > 1) errors.push({ source: f, message: `matches ${mods.length} modules of "${c.s.id}"; module left ${UNASSIGNED}`, candidates: mods.map((m) => `${c.s.id}/${m.m.id}`) });
      const module = mods.length > 1 ? UNASSIGNED : mods[0]?.m.id ?? composeModuleOf(f) ?? folderModule(c.src, f);
      assignments[f] = { service: c.s.id, module };
      continue;
    }
    const i = inferredByFile.get(f);
    assignments[f] = i && !replaced.has(i)
      ? { service: i.id, module: composeModuleOf(f) ?? folderModule(sourceRoot(root, [i.dir + '/**']), f) }
      : unassigned;
  }

  const counts = (service: string) => {
    const modules = new Map<string, number>();
    let n = 0;
    for (const a of Object.values(assignments)) if (a.service === service) { n++; modules.set(a.module, (modules.get(a.module) ?? 0) + 1); }
    return { n, modules };
  };
  const modulesOf = (declaredModules: DeclaredUnit[], modules: Map<string, number>): LayerModule[] => [
    ...declaredModules.map((m) => ({ id: m.id, label: m.label, aliases: m.aliases, files: modules.get(m.id) ?? 0 })),
    ...[...modules].filter(([id]) => !declaredModules.some((m) => m.id === id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, n]) => ({ id, label: id, aliases: [], files: n })),
  ];
  const services: LayerService[] = [];
  for (const { s } of compiled) {
    const { n, modules } = counts(s.id);
    const evidence = (refines.get(s.id) ?? []).map((id) => `refines inferred ${id}`);
    services.push({ id: s.id, label: s.label, aliases: s.aliases, origin: 'declared', roots: s.include, evidence, files: n, modules: modulesOf(s.modules, modules), entryPoints: [] });
  }
  for (const i of kept) {
    const { n, modules } = counts(i.id);
    services.push({ id: i.id, label: i.id, aliases: [], origin: 'inferred', roots: [i.dir + '/'], evidence: i.evidence, files: n, modules: modulesOf([], modules), entryPoints: [] });
  }
  const loose = counts(UNASSIGNED);
  if (loose.n) services.push({ id: UNASSIGNED, label: UNASSIGNED, aliases: [], origin: 'unassigned', roots: [], evidence: [], files: loose.n, modules: [], entryPoints: [] });

  return { config: declared ? LAYERS_CONFIG_PATH : null, services, assignments, errors, compose: inference.compose };
}

// ---------------------------------------------------------------------------
// Entry points and roll-up
// ---------------------------------------------------------------------------

/**
 * A public top-level function of a compose entry file: what the process it runs
 * serves (MCP tools, handlers). Python marks private names with `_` and the
 * index stores no `export` for it, so a Python name counts unless it is `_`-led.
 */
function isEntryHandler(node: LayerNode, siblings: LayerNode[]): boolean {
  if (node.kind !== 'function') return false;
  const isPublic = node.isExported || (node.language === 'python' && !node.name.startsWith('_'));
  const nested = siblings.some((o) => o !== node && o.kind !== 'file' && o.startLine <= node.startLine && o.endLine >= node.endLine && (o.startLine < node.startLine || o.endLine > node.endLine));
  return !!isPublic && !nested;
}

/** {@link assignLayers}, plus each service's entry points: its routes, the compose runs that enter it and their public top-level functions. */
export function computeLayers(root: string, source: LayerGraphSource): Layers {
  const layers = assignLayers(root, source.files(), source.importPairs());
  const serviceOf = (f: string) => layers.assignments[f]?.service;
  const byId = new Map(layers.services.map((s) => [s.id, s]));
  for (const r of source.routes()) {
    byId.get(serviceOf(r.filePath) ?? '')?.entryPoints.push({ kind: 'route', name: r.name, file: r.filePath, line: r.startLine });
  }
  const entries = layers.compose.filter((c) => c.entry && serviceOf(c.entry));
  for (const c of entries) byId.get(serviceOf(c.entry!)!)?.entryPoints.push({ kind: 'compose', name: c.name, file: c.entry! });
  const entryFiles = [...new Set(entries.map((c) => c.entry!))];
  const nodes = entryFiles.length ? source.nodesInFiles(entryFiles) : [];
  for (const file of entryFiles) {
    const inFile = nodes.filter((n) => n.filePath === file && n.kind !== 'parameter' && n.kind !== 'import' && n.kind !== 'variable');
    for (const n of inFile.filter((x) => isEntryHandler(x, inFile)).sort((a, b) => a.startLine - b.startLine)) {
      byId.get(serviceOf(file)!)?.entryPoints.push({ kind: 'handler', name: n.name, file, line: n.startLine });
    }
  }
  return layers;
}

/** Cross-unit edges grouped by the service (or `service/module`) of each endpoint's file, with a per-kind breakdown. */
export function computeLayerRollup(
  layers: Layers,
  counts: FileEdgeCount[],
  options: { level?: LayerLevel; excludeTests?: boolean } = {},
): LayerRollup {
  const level = options.level ?? 'service';
  const excludeTests = options.excludeTests ?? false;
  const unit = (f: string) => {
    const a = layers.assignments[f] ?? { service: UNASSIGNED, module: UNASSIGNED };
    return level === 'service' ? a.service : `${a.service}/${a.module}`;
  };
  const edges = new Map<string, LayerRollupEdge>();
  for (const c of counts) {
    if (excludeTests && (isTestFile(c.source) || isTestFile(c.target))) continue;
    const from = unit(c.source);
    const to = unit(c.target);
    if (from === to) continue;
    const key = `${from}\0${to}`;
    let e = edges.get(key);
    if (!e) edges.set(key, (e = { from, to, total: 0, synthesized: 0, byKind: {} }));
    e.total += c.count;
    e.synthesized += c.synthesized;
    e.byKind[c.kind] = (e.byKind[c.kind] ?? 0) + c.count;
  }
  return {
    level,
    excludeTests,
    edges: [...edges.values()].sort((a, b) => b.total - a.total || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
  };
}

// ---------------------------------------------------------------------------
// Overlay merged view
// ---------------------------------------------------------------------------

/** The overlay surface layers read: its merged edges, and the `merged_nodes` view its connection defines. */
interface OverlayView {
  db: { prepare(sql: string): { all(...params: unknown[]): any[] } };
  getEdges(): Array<{ source: string; target: string; kind: EdgeKind; metadata?: Record<string, unknown>; dangling?: boolean }>;
}

/**
 * A worktree overlay's merged view (base minus hidden files, plus the
 * overlay's), so a branch's layers and roll-up show its own changes. Pass the
 * worktree as `root` to {@link computeLayers}: a branch that edits
 * `layers.yaml` gets its own layers.
 */
export function overlayLayerSource(overlay: OverlayView): LayerGraphSource {
  const toNode = (r: any): LayerNode => ({
    kind: r.kind, name: r.name, filePath: r.file_path, startLine: r.start_line, endLine: r.end_line, language: r.language, isExported: r.is_exported === 1,
  });
  return {
    files: () => overlay.db.prepare(`SELECT path FROM base.files WHERE path NOT IN (SELECT path FROM hidden_files)
      UNION SELECT path FROM main.overlay_files WHERE status <> 'deleted' ORDER BY path`).all().map((r) => r.path as string),
    importPairs: () => fileEdgeCounts(overlay).filter((c) => c.kind === 'imports').map(({ source, target }) => ({ source, target })),
    fileEdgeCounts: () => fileEdgeCounts(overlay),
    routes: () => overlay.db.prepare("SELECT * FROM merged_nodes WHERE kind = 'route'").all().map(toNode),
    nodesInFiles: (paths) => overlay.db.prepare(`SELECT * FROM merged_nodes WHERE file_path IN (${paths.map(() => '?').join(',')})`).all(...paths).map(toNode),
  };
}

function fileEdgeCounts(overlay: OverlayView): FileEdgeCount[] {
  const fileOf = new Map<string, string>();
  for (const r of overlay.db.prepare('SELECT id, file_path FROM merged_nodes').all()) fileOf.set(r.id, r.file_path);
  const out = new Map<string, FileEdgeCount>();
  for (const e of overlay.getEdges()) {
    const synthesized = e.metadata?.synthesizedBy != null;
    if (e.dangling || (!ROLLUP_EDGE_KINDS.includes(e.kind) && !synthesized)) continue;
    const source = fileOf.get(e.source);
    const target = fileOf.get(e.target);
    if (!source || !target || source === target) continue;
    const key = `${source}\0${target}\0${e.kind}`;
    let c = out.get(key);
    if (!c) out.set(key, (c = { source, target, kind: e.kind, count: 0, synthesized: 0 }));
    c.count++;
    if (synthesized) c.synthesized++;
  }
  return [...out.values()];
}
