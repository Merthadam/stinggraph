/**
 * Which source directory a URL in docker compose run config points at.
 *
 * A service that calls another over HTTP usually reads the base URL from an
 * environment variable its compose service sets (`CRUD_BASE_URL:
 * http://crud:8001`). The URL's host is the target compose service, and that
 * service's run command (`uvicorn services.crud.server:app`, `python -m
 * pkg.mod`, else the Dockerfile CMD it builds) or its own build context names
 * the directory its routes live in. The tier synthesizer binds such a call to
 * routes in that directory alone, which settles a path two services both serve.
 *
 * Only unambiguous facts are kept: a variable whose URLs name two services,
 * or a service whose directory is unknown or the repository root, is dropped.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ComposeTopology {
  /** An environment variable → the source dir of the one compose service its URL values name. */
  envDirs: Map<string, string>;
  /** A compose service name, as a URL host → its source dir. */
  hostDirs: Map<string, string>;
}

// shortcut: compose files at the project root only; nested `deploy/compose.yaml` stacks are not read.
const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/;

interface Line {
  indent: number;
  text: string;
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** `["uv", "run", x]` → its items; anything else → one scalar. */
function flowItems(s: string): string[] {
  const t = s.trim();
  if (!t.startsWith('[')) return [unquote(t)];
  return (t.slice(1, t.lastIndexOf(']')).match(/"[^"]*"|'[^']*'|[^,\s]+/g) ?? []).map(unquote);
}

/** The lines nested under line `i`. */
function childrenOf(lines: readonly Line[], i: number): Line[] {
  const out: Line[] = [];
  for (let j = i + 1; j < lines.length && lines[j]!.indent > lines[i]!.indent; j++) out.push(lines[j]!);
  return out;
}

/** The direct `key: value` entries of a block (its least-indented lines), each with what it nests. */
function entries(block: readonly Line[]): Map<string, { inline: string; children: Line[] }> {
  const out = new Map<string, { inline: string; children: Line[] }>();
  if (block.length === 0) return out;
  const indent = Math.min(...block.map((l) => l.indent));
  for (let i = 0; i < block.length; i++) {
    if (block[i]!.indent !== indent) continue;
    const m = /^([\w.-]+)\s*:(?:\s+(.*))?$/.exec(block[i]!.text);
    if (!m) continue;
    out.set(m[1]!, { inline: (m[2] ?? '').trim(), children: childrenOf(block, i) });
  }
  return out;
}

/** A block list (`- a`) or a flow / scalar inline value, as strings. */
function listValue(v: { inline: string; children: Line[] }): string[] {
  if (v.inline) return flowItems(v.inline);
  return v.children.filter((l) => l.text.startsWith('- ')).map((l) => unquote(l.text.slice(2)));
}

/** `environment:` as a map (`KEY: v`) or a list (`- KEY=v`). */
function environment(v: { inline: string; children: Line[] } | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!v) return out;
  for (const item of v.inline ? flowItems(v.inline) : v.children.filter((l) => l.text.startsWith('- ')).map((l) => unquote(l.text.slice(2)))) {
    const eq = item.indexOf('=');
    if (eq > 0) out.set(item.slice(0, eq).trim(), item.slice(eq + 1));
  }
  for (const [key, val] of entries(v.children)) out.set(key, unquote(val.inline));
  return out;
}

/** The repo file a run command enters: `-m pkg.mod`, `uvicorn pkg.mod:app`, or a path argument. */
function commandEntry(root: string, argv: readonly string[], workdir: string): string | null {
  const moduleFile = (mod: string): string | null => {
    const base = mod.replace(/\./g, '/');
    return [`${base}.py`, `${base}/__init__.py`].find((f) => fs.existsSync(path.join(root, f))) ?? null;
  };
  const m = argv.indexOf('-m');
  if (m >= 0 && argv[m + 1]) return moduleFile(argv[m + 1]!);
  const server = argv.findIndex((a) => /^(?:uvicorn|gunicorn|hypercorn|granian)$/.test(a));
  if (server >= 0) {
    const target = argv.slice(server + 1).find((a) => !a.startsWith('-') && /^[\w.]+:[\w.()]+$/.test(a));
    if (target) return moduleFile(target.split(':')[0]!);
  }
  for (const a of argv) {
    if (!a.includes('/') || /^[a-z]+:\/\//i.test(a)) continue;
    const rel = a.startsWith(workdir + '/') ? a.slice(workdir.length + 1) : a.replace(/^\.\//, '');
    if (!rel.startsWith('/') && fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile()) return rel;
  }
  return null;
}

/** A repo-relative directory, or null for the root or a path outside it. */
function repoDir(root: string, abs: string): string | null {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/** The directory a compose service's code lives in: where its command enters, else its own build context. */
function serviceDir(root: string, svc: Map<string, { inline: string; children: Line[] }>): string | null {
  const build = svc.get('build');
  const buildEntries = build ? entries(build.children) : new Map<string, { inline: string; children: Line[] }>();
  const context = build ? unquote(build.inline || buildEntries.get('context')?.inline || '.') : null;
  let argv: string[] | null = null;
  const command = svc.get('command');
  if (command) argv = command.inline && !command.inline.startsWith('[') ? command.inline.split(/\s+/).map(unquote) : listValue(command);
  else if (context !== null) {
    const dockerfile = path.join(root, context, unquote(buildEntries.get('dockerfile')?.inline || 'Dockerfile'));
    const cmd = fs.existsSync(dockerfile) ? fs.readFileSync(dockerfile, 'utf8').split(/\r?\n/).filter((l) => /^CMD\s/.test(l)).pop() : undefined;
    if (cmd) {
      const body = cmd.replace(/^CMD\s+/, '').trim();
      argv = body.startsWith('[') ? flowItems(body) : body.split(/\s+/);
    }
  }
  const entry = argv ? commandEntry(root, argv, unquote(svc.get('working_dir')?.inline || '/app')) : null;
  if (entry) return repoDir(root, path.join(root, path.dirname(entry)));
  return context !== null ? repoDir(root, path.join(root, context)) : null;
}

/** The compose topology of a project; null when it has no compose file with a service. */
export function readComposeTopology(root: string): ComposeTopology | null {
  let names: string[];
  try {
    names = fs.readdirSync(root).filter((f) => COMPOSE_FILE.test(f)).sort();
  } catch {
    return null;
  }
  // null marks a name two facts disagree on.
  const hosts = new Map<string, string | null>();
  const envs = new Map<string, string | null>();
  const put = (map: Map<string, string | null>, key: string, dir: string | null): void => {
    map.set(key, map.has(key) && map.get(key) !== dir ? null : dir);
  };
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    const lines: Line[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const t = stripComment(raw).trimEnd();
      if (t.trim()) lines.push({ indent: t.length - t.trimStart().length, text: t.trim() });
    }
    const top = entries(lines).get('services');
    if (!top) continue;
    const services = new Map<string, { dir: string | null; env: Map<string, string> }>();
    for (const [svcName, block] of entries(top.children)) {
      const svc = entries(block.children);
      services.set(svcName, { dir: serviceDir(root, svc), env: environment(svc.get('environment')) });
    }
    for (const [svcName, svc] of services) put(hosts, svcName, svc.dir);
    for (const svc of services.values()) {
      for (const [key, value] of svc.env) {
        const host = /^[^$]*?(?:\$\{[\w]+:?-)?[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?([A-Za-z0-9_.-]+)/i.exec(value)?.[1];
        // A URL to anything but a sibling service (localhost, a SaaS API) says nothing about this topology.
        if (host && services.has(host)) put(envs, key, services.get(host)!.dir);
      }
    }
  }
  if (hosts.size === 0) return null;
  const known = (map: Map<string, string | null>): Map<string, string> =>
    new Map([...map].filter((e): e is [string, string] => e[1] !== null));
  return { envDirs: known(envs), hostDirs: known(hosts) };
}
