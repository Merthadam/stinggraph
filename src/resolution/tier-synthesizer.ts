/**
 * Cross-tier channels — the web's equivalent of the React Native bridge.
 *
 * A web app is two programs that talk over a wire the graph cannot see: the
 * page calls `fetch('/api/users', { method: 'POST' })` and the API's
 * `app.post('/api/users', createUser)` answers; a service puts `'welcome'` on
 * the `email` queue and a `@Process('welcome')` method picks it up; a
 * gateway's `this.server.emit('message')` lands in the component that wrote
 * `socket.on('message', …)`. Each hop is a string on both sides, which is the
 * evidence that lets a synthesizer close it — exactly as the RN event channel
 * pairs `sendEvent(withName: "x")` with `addListener('x')`.
 *
 * Three channels, one scan:
 *
 *  1. **`http-client`** — a literal path in a client call (`fetch`, `axios.post`,
 *     `ky`, `got`, `$fetch`, `useFetch`, `useSWR`, or a project instance made by
 *     `axios.create(…)` / `ky.extend(…)`) → the ONE route node `METHOD path` it
 *     denotes. Template holes match a `:param`; a hole in front of the path
 *     (`${API_URL}/users`) matches a route by its tail; a variable url, a path
 *     no route serves, or a path two routes serve alike produce nothing.
 *     Edge: enclosing function → route, `tier: 'client→server'`.
 *  2. **`queue-job`** — `queue.add('job', …)` where the queue is named (`new
 *     Queue('email')`, `@InjectQueue('email')`) → the `@Process('job')` method
 *     of the `@Processor('email')` class, a WorkerHost's `process`, a
 *     `new Worker('email', handler)`, or Bull's `queue.process('job', handler)`.
 *  3. **`event-bus`** — `eventEmitter.emit('user.created')` → `@OnEvent('user.created')`
 *     (globs honoured); and sockets in both directions: a client's
 *     `socket.emit('x')` → the server's `@SubscribeMessage('x')` / `socket.on('x')`
 *     (`tier: 'client→server'`), the server's `server.emit('x')` → the client's
 *     `socket.on('x', …)` (`tier: 'server→client'`). The in-process
 *     `.on('x', fn)` ↔ `.emit('x')` pairing stays the emitter pass's.
 *
 * Every edge is `kind: 'calls'`, `provenance: 'heuristic'`, and carries
 * `synthesizedBy`, `channel` (`http` | `queue` | `event` | `socket`), the
 * `tier` when the direction is known, the `event` / `queue` / `method` /
 * `href` it was paired on, and `registeredAt` — the route registration, the
 * decorator, the `.on` — so a reader can check the pairing. Fan-out is capped
 * per event as the emitter pass caps it; an HTTP pairing needs no cap because
 * it is exact. Test suites and generated files are never sources of these
 * passes: a supertest call is the test's story, and forty of them would make
 * the route a hub. The one exception is section 4, a Spring / Laravel test's
 * request onto its route, whose edges are kept out of fan-in for that reason.
 */

import type { Edge, Language, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { resolveImportPath } from './import-resolver';
import { isGeneratedFile } from '../extraction/generated-detection';
import { isTestPath } from '../search/query-utils';
import { HOLE, readStringAt } from './frameworks/expo-router';
import { enclosingFn, enclosingValue, makeLineAt } from './synth-utils';
import { readComposeTopology, type ComposeTopology } from './compose-topology';

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Events with more handlers or dispatchers than this are too generic to pair without type information. */
const EVENT_FANOUT_CAP = 6;

const HTTP_VERBS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL', 'ANY']);

export const TIER_CLIENT_TO_SERVER = 'client→server';
export const TIER_SERVER_TO_CLIENT = 'server→client';
export const TIER_SERVER_TO_SERVER = 'server→server';

// =============================================================================
// Source reading
// =============================================================================

/** Index just past the `)` that closes the `(` at `open`, skipping strings; -1 if unbalanced. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '`') {
      i = templateEnd(s, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the backtick closing the template opening at `open`. */
function templateEnd(s: string, open: number): number {
  let i = open + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    if (ch === '$' && s[i + 1] === '{') {
      let depth = 0;
      for (i = i + 1; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) break;
        } else if (s[i] === '`') i = templateEnd(s, i);
      }
    }
    i++;
  }
  return s.length;
}

/** The arguments of the call whose `(` is at `open`, split at depth-0 commas. */
function argumentsAt(s: string, open: number): string[] | null {
  const close = closeParen(s, open);
  if (close < 0) return null;
  const inner = s.slice(open + 1, close);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < inner.length && inner[i] !== q) {
        if (inner[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '`') {
      i = templateEnd(inner, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((a) => a.trim()).filter((a, i) => a.length > 0 || i === 0);
}

/** The first string literal in `text`, holes kept; null when it opens with anything else. */
function leadingString(text: string): string | null {
  const t = text.trim().replace(/^\(\s*/, '');
  // `new URL('/x', base)` — the path is the first argument of the URL.
  const url = /^new\s+URL\s*\(/.exec(t);
  if (url) {
    const args = argumentsAt(t, url[0].length - 1);
    return args && args[0] ? leadingString(args[0]) : null;
  }
  if (t[0] === '"' || t[0] === "'" || t[0] === '`') return readStringAt(t, 0);
  return null;
}

/** `method: 'POST'` inside an options object / config, upper-cased; null when absent or computed. */
function methodIn(text: string): string | null {
  const m = /\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/.exec(text);
  return m ? m[2]!.toUpperCase() : null;
}

/**
 * A wrapper's method chosen by whether a parameter was passed:
 * `method: options.method || (body === undefined ? 'GET' : 'POST')`.
 */
interface MethodBy {
  /** The parameter's position in the wrapper's signature. */
  param: number;
  /** What counts as not passing it: `=== undefined`, `=== null`, `== null`, or `!x` / `x ?`. */
  test: 'undefined' | 'null' | 'nullish' | 'falsy';
  absent: string;
  present: string;
}

/** The `x === undefined ? 'GET' : 'POST'` a computed `method:` value picks by, against the wrapper's parameters. */
function methodByIn(options: string, params: string[]): MethodBy | null {
  const at = /\bmethod\s*:([^,]*)/.exec(options);
  if (!at) return null;
  const value = at[1]!;
  const verb = String.raw`\s*\?\s*['"]([A-Za-z]+)['"]\s*:\s*['"]([A-Za-z]+)['"]`;
  const compare = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*(===?|!==?)\s*(undefined|null)` + verb).exec(value);
  const truthy = compare ? null : new RegExp(String.raw`(!?)\s*(?<![\w$.])([A-Za-z_$][\w$]*)` + verb).exec(value);
  const name = compare ? compare[1]! : truthy?.[2];
  const param = name === undefined ? -1 : params.indexOf(name);
  if (param < 1) return null;
  if (compare) {
    const strict = compare[2]!.length === 3;
    const test = !strict ? 'nullish' : compare[3] === 'null' ? 'null' : 'undefined';
    const [whenTrue, whenFalse] = [compare[4]!.toUpperCase(), compare[5]!.toUpperCase()];
    const negated = compare[2]!.startsWith('!');
    return { param, test, absent: negated ? whenFalse : whenTrue, present: negated ? whenTrue : whenFalse };
  }
  const [whenTrue, whenFalse] = [truthy![3]!.toUpperCase(), truthy![4]!.toUpperCase()];
  const negated = truthy![1] === '!';
  return { param, test: 'falsy', absent: negated ? whenTrue : whenFalse, present: negated ? whenFalse : whenTrue };
}

/** The method a wrapper call makes by the argument at `by.param`; null when a spread hides it. */
function methodByArgs(by: MethodBy, args: string[]): string | null {
  if (args.slice(0, by.param + 1).some((a) => a.trim().startsWith('...'))) return null;
  const arg = args[by.param]?.trim();
  if (arg === undefined || arg === '') return by.test === 'null' ? by.present : by.absent;
  const absent =
    by.test === 'null' ? ['null']
    : by.test === 'undefined' ? ['undefined', 'void 0']
    : by.test === 'nullish' ? ['undefined', 'void 0', 'null']
    : ['undefined', 'void 0', 'null', 'false', '0', "''", '""', '``'];
  return absent.includes(arg) ? by.absent : by.present;
}

/** A function's parameter names, in order, from its signature; `''` for a destructured one. */
function paramNames(fn: Node): string[] {
  const sig = fn.signature ?? '';
  const open = sig.indexOf('(');
  if (open < 0) return firstParam(fn) ? [firstParam(fn)!] : [];
  return (argumentsAt(sig, open) ?? []).map((p) => /^\s*([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? '');
}

/** The first string literal anywhere in a decorator's arguments (`'x'`, `{ name: 'x' }`). */
function firstLiteral(args: string): string | null {
  const m = /(['"`])([^'"`]+)\1/.exec(args);
  return m ? m[2]! : null;
}

/** Every string literal in a decorator's arguments, for `@OnEvent(['a', 'b'])`. */
function allLiterals(args: string): string[] {
  const out: string[] = [];
  const re = /(['"`])([^'"`]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) out.push(m[2]!);
  return out;
}

/**
 * The name of the method a decorator sits on: skip further stacked decorators
 * and modifiers after the decorator's `)`, then take the identifier before `(`.
 */
function methodNameAfter(safe: string, from: number): { name: string; index: number } | null {
  let i = from;
  const ws = /\s*/y;
  const deco = /@[\w.]+/y;
  const modifier = /(?:public|private|protected|async|static|readonly|override)\b/y;
  const ident = /([A-Za-z_$][\w$]*)\s*[<(]/y;
  const eat = (): void => {
    ws.lastIndex = i;
    if (ws.exec(safe)) i = ws.lastIndex;
  };
  for (;;) {
    eat();
    if (safe[i] !== '@') break;
    deco.lastIndex = i;
    if (!deco.exec(safe)) break;
    i = deco.lastIndex;
    eat();
    if (safe[i] === '(') {
      const close = closeParen(safe, i);
      if (close < 0) return null;
      i = close + 1;
    }
  }
  for (;;) {
    eat();
    modifier.lastIndex = i;
    if (modifier.exec(safe) && modifier.lastIndex > i) {
      i = modifier.lastIndex;
      continue;
    }
    break;
  }
  eat();
  ident.lastIndex = i;
  const m = ident.exec(safe);
  return m ? { name: m[1]!, index: i } : null;
}

/** Every `@Name(` decorator in `safe` with its arguments and where it ends. */
function decorators(safe: string, name: string): Array<{ args: string; index: number; end: number }> {
  const out: Array<{ args: string; index: number; end: number }> = [];
  const re = new RegExp(`@${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(safe, open);
    if (close < 0) continue;
    out.push({ args: safe.slice(open + 1, close), index: m.index, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}

// =============================================================================
// Per-file facts, read once
// =============================================================================

interface FileFacts {
  file: string;
  safe: string;
  /** Read on first use: most files that pass a gate hold no site, and never need them. */
  readonly nodes: Node[];
  lineOf: (idx: number) => number;
  /** The 0-based column of an index on its line — where the site reader looks for the call. */
  columnOf: (idx: number) => number;
  /** Lines a framework resolver made a route node on — registrations, never client calls. */
  readonly routeLines: Set<number>;
  /** Local names bound to an HTTP client instance, with their literal base URL when written. */
  clients: Map<string, { baseURL: string | null }>;
  /**
   * This file's functions that hand their first parameter to a client call as
   * the URL — `function request(path) { return fetch(path, …) }` — with the
   * method that call makes (null when computed), and the parameter a computed
   * method is chosen by when there is one. Filled by the HTTP scan.
   */
  wrappers: Map<string, { method: string | null; methodBy: MethodBy | null; baseURL: string | null }>;
  /** The module's default export is a client instance. */
  defaultClient: { baseURL: string | null } | null;
  /** Local names bound to a named queue (`new Queue('email')`, `@InjectQueue('email') x`). */
  queues: Map<string, string>;
  /** The file holds a socket server (a gateway, `io.on('connection')`, `new Server(…)`). */
  socketServer: boolean;
}

const CLIENT_FACTORY =
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*?)?=\s*(?:await\s+)?(?:(?:axios|ky|got|ofetch|\$fetch|wretch|redaxios)\s*\.\s*(?:create|extend)|new\s+Axios|wretch)\s*\(/g;
const DEFAULT_CLIENT_FACTORY = /\bexport\s+default\s+(?:(?:axios|ky|got|ofetch|\$fetch|wretch|redaxios)\s*\.\s*(?:create|extend)|new\s+Axios|wretch)\s*\(/;
const QUEUE_BINDING =
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*?)?=\s*(?:new\s+)?(?:Queue|Bull|BullQueue)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\2/g;
const INJECT_QUEUE = /@InjectQueue\s*\(\s*(['"`])([^'"`]+)\1\s*\)\s*(?:(?:private|public|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/g;
const SOCKET_SERVER_FILE = /@WebSocketGateway\s*\(|@SubscribeMessage\s*\(|@WebSocketServer\s*\(|\bnew\s+(?:Server|SocketIOServer|WebSocketServer|WebSocket\.Server|WSServer)\b|\.on\s*\(\s*['"]connection['"]/;

function baseUrlIn(safe: string, open: number): string | null {
  const args = argumentsAt(safe, open);
  const config = args?.[0] ?? '';
  const m = /\b(?:baseURL|baseUrl|prefixUrl|baseURI)\s*:\s*/.exec(config);
  if (!m) return null;
  return readStringAt(config, m.index + m[0].length);
}

function readFacts(ctx: ResolutionContext, file: string): FileFacts | null {
  const content = ctx.readFile(file);
  if (!content) return null;
  const safe = stripCommentsForRegex(content, 'typescript');
  let nodes: Node[] | null = null;
  let routeLines: Set<number> | null = null;
  const clients = new Map<string, { baseURL: string | null }>();
  CLIENT_FACTORY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLIENT_FACTORY.exec(safe)) !== null) {
    clients.set(m[1]!, { baseURL: baseUrlIn(safe, m.index + m[0].length - 1) });
  }
  const dm = DEFAULT_CLIENT_FACTORY.exec(safe);
  const defaultClient = dm ? { baseURL: baseUrlIn(safe, dm.index + dm[0].length - 1) } : null;
  const queues = new Map<string, string>();
  QUEUE_BINDING.lastIndex = 0;
  while ((m = QUEUE_BINDING.exec(safe)) !== null) queues.set(m[1]!, m[3]!);
  INJECT_QUEUE.lastIndex = 0;
  while ((m = INJECT_QUEUE.exec(safe)) !== null) queues.set(m[3]!, m[2]!);
  return {
    file,
    safe,
    get nodes() {
      return (nodes ??= ctx.getNodesInFile(file));
    },
    lineOf: makeLineAt(safe, 1),
    columnOf: (idx: number) => idx - (safe.lastIndexOf('\n', idx - 1) + 1),
    get routeLines() {
      if (!routeLines) {
        routeLines = new Set<number>();
        for (const n of this.nodes) if (n.kind === 'route') routeLines.add(n.startLine);
      }
      return routeLines;
    },
    clients,
    wrappers: new Map(),
    defaultClient,
    queues,
    socketServer: SOCKET_SERVER_FILE.test(safe),
  };
}

/** Facts for the file a local name is imported from, when the import resolves to a project file. */
function importedFacts(
  ctx: ResolutionContext,
  facts: FileFacts,
  localName: string,
  cache: Map<string, FileFacts | null>
): { facts: FileFacts; exportedName: string; isDefault: boolean } | null {
  const lang: Language = facts.file.endsWith('x') ? 'tsx' : 'typescript';
  const im = ctx.getImportMappings(facts.file, lang).find((i) => i.localName === localName);
  if (!im) return null;
  // The mappings name the module as written; the file it is comes from the
  // same resolution the import resolver uses (aliases, extensions, index files).
  const resolved = im.resolvedPath ?? resolveImportPath(im.source, facts.file, lang, ctx);
  if (!resolved) return null;
  let target = cache.get(resolved);
  if (target === undefined) {
    target = JS_FILE.test(resolved) ? readFacts(ctx, resolved) : null;
    cache.set(resolved, target);
  }
  return target ? { facts: target, exportedName: im.exportedName, isDefault: im.isDefault } : null;
}

// =============================================================================
// 1. HTTP client → route
// =============================================================================

/** A receiver that is an HTTP client by name alone. */
const CLIENT_NAMES =
  /^(?:axios|ky|got|superagent|http|https|httpClient|httpService|api|apiClient|client|restClient|request|agent|fetcher|instance|\$api|\$http|\$axios|axiosInstance|Axios|HttpClient|backend|server)$/;
/** A receiver that registers routes, never a client — unless it was made by a client factory. */
const SERVER_NAMES = /^(?:app|router|route|routes|express|fastify|koa|hono|elysia|apiRouter|v1|v2|r)$/;
/** A type argument between the callee and its `(` — `useSWR<TeamData>('/api/team')`, `ky.get<User>('/x')`. */
const GENERIC = String.raw`(?:<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>)?`;
/**
 * Where a receiver chain (`this.api.client`) may begin: not after an earlier
 * identifier-start character of the same word (the second lookbehind is the
 * whole rule; the first is its one-character fast path). A match from the
 * middle of a word implies one from its first letter — the chain regexes read
 * the rest of the word either way — and each of their matches ends on a
 * non-word character, so a scan never resumes mid-word: this only skips starts
 * bound to fail. Without it every letter of every identifier re-read the
 * dotted chain behind it, which on vscode made this the slowest pass.
 */
const CHAIN_START = String.raw`(?<![A-Za-z_$])(?<![A-Za-z_$][\w$]+)`;
const BARE_CLIENT_CALL = new RegExp(String.raw`(?:(?:window|globalThis|global)\s*\.\s*)?\b(fetch|\$fetch|ofetch|axios|ky|got|useFetch|useSWR)\s*${GENERIC}\s*\(`, 'g');
const MEMBER_CLIENT_CALL = new RegExp(
  String.raw`${CHAIN_START}((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(get|post|put|patch|delete|head|options|request|\$get|\$post|\$put|\$patch|\$delete)\s*${GENERIC}\s*\(`,
  'g'
);

interface HttpRoute {
  node: Node;
  method: string;
  segs: string[];
}

interface HttpSite {
  fn: Node;
  file: string;
  line: number;
  column: number;
  /** The call as written, `fetch` / `api.get` — what the Steps walk must not also draw as an effect. */
  callee: string;
  /** Null when a wrapper computes it (`method: options.method || …`): any method one registration serves. */
  method: string | null;
  /**
   * A page's same-origin call (`fetch('/api/x')`, no host, no base URL): it
   * reaches the origin that served the page, so a path both a gateway's proxy
   * and the backend behind it serve is the gateway's.
   */
  browser: boolean;
  segs: string[];
  /** The path began with a hole — a base URL — and matches a route by its tail. */
  suffix: boolean;
  display: string;
  /** A Python call's base URL as written (`self.base_url`, `os.environ["X"]`, an absolute literal), with the line it is read at. */
  base?: { expr: string; line: number };
  /** The one compose service's directory the base URL points at: the call reaches routes there only. */
  scope?: TopologyBinding;
}

function httpRoutes(ctx: ResolutionContext): HttpRoute[] {
  const out: HttpRoute[] = [];
  for (const node of ctx.getNodesByKind('route')) {
    const space = node.name.indexOf(' ');
    if (space <= 0) continue;
    const method = node.name.slice(0, space).toUpperCase();
    if (!HTTP_VERBS.has(method)) continue;
    const path = node.name.slice(space + 1).trim();
    if (!path.startsWith('/')) continue;
    out.push({ node, method, segs: path.split('/').filter((s) => s.length > 0) });
  }
  return out;
}

const PARAM_SEG = /^(?::|\{|\[|<|\*)|\?$/;
const CATCH_ALL = /^(?:\*|\[\.\.\.|\{\*|:[\w$]+\*$|\{[\w$]+:(?:\*|path)\}|\*[\w$]*$)/;

/** How well the client's segments match a route's; null when they do not. A literal match beats a parameter's. */
function scorePath(client: readonly string[], route: readonly string[]): number | null {
  let score = 0;
  let i = 0;
  for (let r = 0; r < route.length; r++) {
    const seg = route[r]!;
    if (CATCH_ALL.test(seg)) {
      if (i >= client.length) return null;
      score += client.length - i;
      i = client.length;
      continue;
    }
    if (i >= client.length) return null;
    const c = client[i]!;
    // A hole (`${id}`) fills a route's parameter; it never stands in for a
    // literal segment — `/api/products/${id}` is not `/api/products/top`.
    if (PARAM_SEG.test(seg)) score += 2;
    else if (c === seg) score += 3;
    else return null;
    i++;
  }
  return i === client.length ? score : null;
}

/**
 * The routes a client call reaches: one route, or every method of the ONE
 * registration a method-less call can mean; empty when the path is ambiguous.
 */
function matchHttp(site: HttpSite, routes: readonly HttpRoute[], proxies: ReadonlySet<string>): HttpRoute[] {
  let best: HttpRoute[] = [];
  let bestScore = -1;
  for (const r of routes) {
    if (site.scope && !r.node.filePath.startsWith(site.scope.dir + '/')) continue;
    if (site.method !== null && r.method !== 'ALL' && r.method !== 'ANY' && r.method !== site.method) continue;
    let score: number | null;
    if (site.suffix) {
      // A base URL hides a prefix the route may spell out (`${API}/users` for
      // `GET /api/users`) — but a one-segment tail names half the routes in
      // an index, and a long hidden prefix is a different API. Two segments
      // of tail at least, two of prefix at most.
      if (site.segs.length < 2 || r.segs.length < site.segs.length || r.segs.length - site.segs.length > 2) continue;
      score = scorePath(site.segs, r.segs.slice(r.segs.length - site.segs.length));
    } else score = scorePath(site.segs, r.segs);
    if (score === null) continue;
    if (score > bestScore) {
      best = [r];
      bestScore = score;
    } else if (score === bestScore) best.push(r);
  }
  if (best.length > 1 && site.browser) {
    const viaGateway = best.filter((r) => proxies.has(r.node.id));
    if (viaGateway.length > 0) best = viaGateway;
  }
  if (best.length <= 1) return best;
  const first = best[0]!.node;
  const oneRegistration = best.every((r) => r.node.filePath === first.filePath && r.node.startLine === first.startLine);
  return site.method === null && oneRegistration ? best : [];
}

/**
 * The path a client call names, as segments, with `${…}` as `*`; `suffix`
 * when a base URL came first. Null when the path is not literal enough: a
 * relative path with no base, or nothing but holes.
 */
function clientPath(raw: string, baseURL: string | null): { segs: string[]; suffix: boolean; display: string } | null {
  let p = raw;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  let suffix = false;
  const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i.exec(p);
  if (absolute) p = absolute[1] ?? '/';
  else if (!p.startsWith('/')) {
    if (p.startsWith(HOLE)) {
      const rest = p.slice(1);
      if (!rest.startsWith('/')) return null;
      p = rest;
      suffix = true;
    } else if (baseURL !== null) {
      const base = clientPath(baseURL, null);
      if (!base) {
        // A base that is itself a hole: match by the tail.
        if (!baseURL.includes(HOLE)) return null;
        suffix = true;
        p = '/' + p;
      } else {
        suffix = base.suffix;
        p = '/' + [...base.segs, ...p.split('/')].filter(Boolean).join('/');
      }
    } else return null;
  } else if (baseURL !== null) {
    // An instance with a literal path base: axios joins `baseURL + url`.
    const base = clientPath(baseURL, null);
    if (base && base.segs.length > 0) {
      suffix = base.suffix;
      p = '/' + [...base.segs, ...p.split('/')].filter(Boolean).join('/');
    } else if (!base && baseURL.includes(HOLE)) suffix = true;
  }
  const segs = p
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.includes(HOLE) ? '*' : s));
  if (segs.length > 0 && segs.every((s) => s === '*')) return null;
  return { segs, suffix, display: '/' + segs.map((s) => (s === '*' ? '${…}' : s)).join('/') };
}

/** What a member-call receiver is: a client (with its base URL), or nothing. */
function clientFor(
  ctx: ResolutionContext,
  facts: FileFacts,
  receiver: string,
  cache: Map<string, FileFacts | null>
): { baseURL: string | null } | null {
  const chain = receiver.replace(/\s+/g, '').replace(/^this\./, '').split('.');
  const head = chain[0]!;
  const last = chain[chain.length - 1]!;
  const local = facts.clients.get(head);
  if (local) return local;
  const imported = importedFacts(ctx, facts, head, cache);
  if (imported) {
    const bound = imported.isDefault ? imported.facts.defaultClient : imported.facts.clients.get(imported.exportedName) ?? null;
    if (bound) return bound;
  }
  if (SERVER_NAMES.test(last) || SERVER_NAMES.test(head)) return null;
  if (CLIENT_NAMES.test(last)) return { baseURL: null };
  return null;
}

/** The name of a function's first parameter, from its signature: `(path, body)`, `path =>`. */
function firstParam(fn: Node): string | null {
  const m = /^\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)/.exec(fn.signature ?? '');
  return m ? m[1]! : null;
}

/** An absolute URL (`https://host/x`, `//host/x`): not a same-origin call. */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function collectHttpSites(ctx: ResolutionContext, facts: FileFacts, sites: HttpSite[], cache: Map<string, FileFacts | null>): void {
  const { safe, lineOf } = facts;
  const add = (index: number, open: number, verb: string | null, baseURL: string | null): void => {
    const line = lineOf(index);
    const callee = safe.slice(index, open).replace(/\s+/g, '').replace(/<.*>$/, '');
    if (facts.routeLines.has(line)) return; // a registration the resolver already read
    const fn = enclosingFn(facts.nodes, line);
    if (!fn) return;
    const args = argumentsAt(safe, open);
    if (!args || !args[0]) return;
    let first = args[0];
    let method = verb;
    let computedMethod = false;
    let options = '';
    // `axios({ url, method })`, `.request({ url, method })`, `ky(url, { method })`.
    if (first.trimStart().startsWith('{')) {
      const url = /\burl\s*:\s*/.exec(first);
      if (!url) return;
      method = method ?? methodIn(first) ?? 'GET';
      first = first.slice(url.index + url[0].length);
    } else if (method === null) {
      options = args.slice(1).join(',');
      method = methodIn(options);
      computedMethod = method === null && /\bmethod\s*:/.test(options);
      method = method ?? 'GET';
    }
    const literal = leadingString(first);
    if (literal === null) {
      // `function request(path) { … fetch(path, …) }`: its callers write the path.
      if (fn.kind === 'function' && first.trim() === firstParam(fn)) {
        const methodBy = computedMethod ? methodByIn(options, paramNames(fn)) : null;
        facts.wrappers.set(fn.name, { method: computedMethod ? null : method, methodBy, baseURL });
      }
      return;
    }
    const path = clientPath(literal, baseURL);
    if (!path) return;
    const browser = baseURL === null && !path.suffix && !ABSOLUTE_URL.test(literal);
    sites.push({ fn, file: facts.file, line, column: facts.columnOf(index), callee, method, browser, segs: path.segs, suffix: path.suffix, display: path.display });
  };

  BARE_CLIENT_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_CLIENT_CALL.exec(safe)) !== null) {
    // `this.fetch(…)` / `repo.fetch(…)` is a project method, not the platform's.
    const before = safe[m.index - 1];
    if (before === '.' && !/^(?:window|globalThis|global)\s*\./.test(m[0])) continue;
    add(m.index, m.index + m[0].length - 1, null, null);
  }
  MEMBER_CLIENT_CALL.lastIndex = 0;
  while ((m = MEMBER_CLIENT_CALL.exec(safe)) !== null) {
    const client = clientFor(ctx, facts, m[1]!, cache);
    if (!client) continue;
    const verb = m[2]!.replace(/^\$/, '').toUpperCase();
    add(m.index, m.index + m[0].length - 1, verb === 'REQUEST' ? null : verb, client.baseURL);
  }
}

/**
 * Calls of a project's own fetch wrapper with a literal path —
 * `request('/v1/plans', body)` where `request` (defined in this file or
 * imported from one) passes its first parameter to `fetch`. One level only: a
 * wrapper of a wrapper is not followed. Runs after every file's HTTP scan, so
 * each wrapper is known wherever it is defined.
 */
function collectWrapperSites(ctx: ResolutionContext, facts: FileFacts, names: RegExp, sites: HttpSite[], cache: Map<string, FileFacts | null>): void {
  const { safe, lineOf } = facts;
  names.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = names.exec(safe)) !== null) {
    const name = m[1]!;
    const imported = importedFacts(ctx, facts, name, cache);
    const wrapper = imported
      ? imported.isDefault ? undefined : imported.facts.wrappers.get(imported.exportedName)
      : facts.wrappers.get(name);
    if (!wrapper) continue;
    const line = lineOf(m.index);
    const fn = enclosingFn(facts.nodes, line);
    if (!fn) continue;
    const args = argumentsAt(safe, m.index + m[0].length - 1);
    if (!args || !args[0]) continue;
    const literal = leadingString(args[0]);
    if (literal === null) continue;
    const path = clientPath(literal, wrapper.baseURL);
    if (!path) continue;
    const browser = wrapper.baseURL === null && !path.suffix && !ABSOLUTE_URL.test(literal);
    // A literal `method:` in the call wins; a computed one leaves the wrapper's own pick.
    const rest = args.slice(1).join(',');
    const method = methodIn(rest) ?? (wrapper.methodBy && !/\bmethod\s*:/.test(rest) ? methodByArgs(wrapper.methodBy, args) : wrapper.method);
    sites.push({ fn, file: facts.file, line, column: facts.columnOf(m.index), callee: name, method, browser, segs: path.segs, suffix: path.suffix, display: path.display });
  }
}

// -----------------------------------------------------------------------------
// Python clients: httpx / requests / aiohttp
// -----------------------------------------------------------------------------

/**
 * The Python string literal at the start of `text` (`'x'`, `"x"`, `f"{base}/x"`),
 * f-string fields as HOLE; null for anything else.
 */
function pyStringAt(text: string): string | null {
  const m = /^([rRbBfFuU]{0,2})(['"])/.exec(text.trim());
  if (!m) return null;
  const t = text.trim();
  const isF = /f/i.test(m[1]!);
  const q = m[2]!;
  let out = '';
  for (let i = m[0].length; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '\\') {
      out += t[i + 1] ?? '';
      i++;
      continue;
    }
    if (ch === q) return out;
    if (isF && ch === '{') {
      if (t[i + 1] === '{') {
        out += '{';
        i++;
        continue;
      }
      let depth = 0;
      for (; i < t.length; i++) {
        if (t[i] === '{') depth++;
        else if (t[i] === '}' && --depth === 0) break;
      }
      out += HOLE;
      continue;
    }
    if (isF && ch === '}' && t[i + 1] === '}') i++;
    out += ch;
  }
  return null;
}

const PY_CLIENT_CTOR = /\b(?:httpx\s*\.\s*(?:Async)?Client|requests\s*\.\s*Session|aiohttp\s*\.\s*ClientSession)\s*\(/g;
const PY_MODULE_CALL = /(?<![\w.])(httpx|requests)\s*\.\s*(get|post|put|patch|delete|head|options|request)\s*\(/g;
const PY_MEMBER_CALL = /(?<![\w.])((?:self\s*\.\s*)?[A-Za-z_]\w*)\s*\.\s*(get|post|put|patch|delete|head|options|request|stream)\s*\(/g;
const PY_HTTP_GATE = /\b(?:httpx|requests|aiohttp)\b/;

interface PyClient {
  baseURL: string | null;
  /** The `base_url=` argument as written, and the index it is written at. */
  base: { expr: string; index: number } | null;
}

/** Names a Python file binds to an HTTP client (`with httpx.AsyncClient(…) as client`, `self.http = requests.Session()`), with the base URL. */
function pyClients(safe: string): Map<string, PyClient> {
  const out = new Map<string, PyClient>();
  PY_CLIENT_CTOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_CLIENT_CTOR.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(safe, open);
    if (close < 0) continue;
    const args = safe.slice(open + 1, close);
    const base = /\bbase_url\s*=\s*/.exec(args);
    // A base URL read from config is still a prefix the path sits under: match by the tail.
    const baseURL = base ? pyStringAt(args.slice(base.index + base[0].length)) ?? HOLE : null;
    const assigned = /(?:^|[^\w.])(?:self\s*\.\s*)?([A-Za-z_]\w*)\s*=\s*(?:await\s+)?$/.exec(safe.slice(Math.max(0, m.index - 80), m.index));
    const as = /^\s*as\s+([A-Za-z_]\w*)/.exec(safe.slice(close + 1, close + 80));
    const name = as?.[1] ?? assigned?.[1];
    const baseArg = base ? argumentsAt(safe, open)?.find((a) => /^base_url\s*=/.test(a)) : undefined;
    if (name) out.set(name, { baseURL, base: baseArg ? { expr: baseArg.replace(/^base_url\s*=\s*/, ''), index: m.index } : null });
  }
  return out;
}

function collectPythonHttpSites(ctx: ResolutionContext, file: string, content: string, sites: HttpSite[]): void {
  const safe = stripCommentsForRegex(content, 'python');
  const clients = pyClients(safe);
  const lineOf = makeLineAt(safe, 1);
  let nodes: Node[] | null = null;
  const add = (index: number, open: number, verb: string, client: PyClient | null): void => {
    const baseURL = client?.baseURL ?? null;
    const args = argumentsAt(safe, open);
    if (!args || !args[0]) return;
    let method: string | null = verb.toUpperCase();
    let url = args[0];
    if (verb === 'request' || verb === 'stream') {
      method = pyStringAt(args[0])?.toUpperCase() ?? null;
      if (!method || !HTTP_VERBS.has(method) || !args[1]) return;
      url = args[1];
    }
    const literal = pyStringAt(url);
    if (literal === null) return;
    const path = clientPath(literal, baseURL);
    if (!path) return;
    const line = lineOf(index);
    const fn = enclosingFn((nodes ??= ctx.getNodesInFile(file)), line);
    if (!fn) return;
    const callee = safe.slice(index, open).replace(/\s+/g, '');
    // What the host comes from: the f-string's leading field, an absolute literal, or the client's `base_url=`.
    const field = literal.startsWith(HOLE) ? pyLeadingField(url) : null;
    const base = field !== null ? { expr: field, line }
      : ABSOLUTE_URL.test(literal) ? { expr: url, line }
      : client?.base ? { expr: client.base.expr, line: lineOf(client.base.index) } : undefined;
    sites.push({ fn, file, line, column: index - (safe.lastIndexOf('\n', index - 1) + 1), callee, method, browser: false, segs: path.segs, suffix: path.suffix, display: path.display, base });
  };
  PY_MODULE_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_MODULE_CALL.exec(safe)) !== null) add(m.index, m.index + m[0].length - 1, m[2]!, null);
  if (clients.size === 0) return;
  PY_MEMBER_CALL.lastIndex = 0;
  while ((m = PY_MEMBER_CALL.exec(safe)) !== null) {
    const client = clients.get(m[1]!.replace(/^self\s*\.\s*/, ''));
    if (client) add(m.index, m.index + m[0].length - 1, m[2]!, client);
  }
}

/** The expression of an f-string's leading `{…}` field (`f"{self.base_url}/v1"` → `self.base_url`); null otherwise. */
function pyLeadingField(text: string): string | null {
  const m = /^\s*[rRbBuU]?[fF][rRbBuU]?(?:'''|"""|'|")\{(?!\{)/.exec(text);
  if (!m) return null;
  let depth = 0;
  for (let i = m[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}') {
      if (depth === 0) return text.slice(m[0].length, i).replace(/![rsa]$/, '').trim();
      depth--;
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Topology binding: a Python base URL read from config, onto one compose service
// -----------------------------------------------------------------------------

export interface TopologyBinding {
  /** The target compose service's source directory. */
  dir: string;
  /** What named it: the environment variable, or the URL host. */
  via: string;
}

interface TopologyScan {
  ctx: ResolutionContext;
  topo: ComposeTopology;
  pyFiles: string[] | null;
  lines: Map<string, string[]>;
  memo: Map<string, TopologyBinding | null>;
}

const PY_ENV_READ = /(?<![\w.])(?:os\s*\.\s*)?(?:environ\s*\[\s*(['"])([\w.-]+)\1\s*\]|environ\s*\.\s*get\s*\(\s*(['"])([\w.-]+)\3|getenv\s*\(\s*(['"])([\w.-]+)\5)/;
const URL_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([A-Za-z0-9_.-]+)/i;
const MAX_TRACE_DEPTH = 6;

function pyLines(t: TopologyScan, file: string): string[] {
  let lines = t.lines.get(file);
  if (!lines) {
    lines = stripCommentsForRegex(t.ctx.readFile(file) ?? '', 'python').split(/\r?\n/);
    t.lines.set(file, lines);
  }
  return lines;
}

/** One binding when every reading agrees on the directory; null when any is unknown or two disagree. */
function agreed(bindings: ReadonlyArray<TopologyBinding | null>): TopologyBinding | null {
  if (bindings.length === 0 || bindings.some((b) => b === null)) return null;
  const all = bindings as TopologyBinding[];
  if (all.some((b) => b.dir !== all[0]!.dir)) return null;
  return { dir: all[0]!.dir, via: [...new Set(all.map((b) => b.via))].join('|') };
}

/** `base_url.rstrip("/")`, `(x)`, `str(x)`, `x or "…"`, `x if … else …` → `x`. */
function pyCore(expr: string): string {
  let e = expr.trim();
  for (;;) {
    const before = e;
    e = e
      .replace(/\s*\.\s*(?:r?strip|removesuffix)\s*\([^()]*\)\s*$/, '')
      .replace(/^str\s*\(\s*([^()]*)\s*\)$/, '$1')
      .replace(/^\(\s*([^()]*)\s*\)$/, '$1')
      .replace(/^(.+?)\s+(?:or|if)\s[\s\S]*$/, '$1')
      .trim();
    if (e === before) return e;
  }
}

/** A def's parameters (`self` / `cls` dropped), each with its positional index, -1 once keyword-only. */
function pyParams(t: TopologyScan, file: string, fn: Node): Map<string, number> | null {
  const lines = pyLines(t, file);
  const text = lines.slice(fn.startLine - 1, fn.startLine + 15).join('\n');
  const def = new RegExp(String.raw`\bdef\s+${escapeRe(fn.name)}\s*\(`).exec(text);
  if (!def) return null;
  const args = argumentsAt(text, def.index + def[0].length - 1);
  if (!args) return null;
  const out = new Map<string, number>();
  let pos = 0;
  for (const [i, a] of args.entries()) {
    if (a.startsWith('*')) {
      pos = -1;
      continue;
    }
    const name = /^[A-Za-z_]\w*/.exec(a)?.[0];
    if (!name || (i === 0 && (name === 'self' || name === 'cls'))) continue;
    out.set(name, pos);
    if (pos >= 0) pos++;
  }
  return out;
}

function classAt(nodes: readonly Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodes) {
    if (n.kind === 'class' && n.startLine <= line && (n.endLine ?? n.startLine) >= line && (!best || n.startLine >= best.startLine)) best = n;
  }
  return best;
}

/** Every right-hand side assigned to `target` in lines [from, to) — `target = x`, `target: T = x`. */
function assignments(lines: readonly string[], from: number, to: number, target: string, indent?: number): Array<{ rhs: string; line: number }> {
  const re = new RegExp(String.raw`^(\s*)${target}\s*(?::[^=]+)?=(?!=)\s*(.+)$`);
  const out: Array<{ rhs: string; line: number }> = [];
  for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    const m = re.exec(lines[i]!);
    if (m && (indent === undefined || m[1]!.length === indent)) out.push({ rhs: m[2]!, line: i + 1 });
  }
  return out;
}

/**
 * The compose service a Python base-URL expression points at, read at `line`
 * of `file`: an environment read (`os.environ["X"]`, `os.getenv("X")`), a
 * literal URL whose host is a compose service, a local or module variable
 * assigned one, `self.attr` assigned one in its class (a constructor parameter
 * followed to every construction of the class), or a settings field (a
 * pydantic `BaseSettings` field's environment name, else its default). Null
 * as soon as anything is unknown or two readings disagree.
 */
function pyBaseBinding(t: TopologyScan, file: string, line: number, expr: string, depth = 0): TopologyBinding | null {
  if (depth > MAX_TRACE_DEPTH) return null;
  const e = pyCore(expr);
  const literal = pyStringAt(e);
  if (literal !== null) {
    const host = URL_HOST.exec(literal)?.[1];
    const dir = host ? t.topo.hostDirs.get(host) : undefined;
    return host && dir ? { dir, via: host } : null;
  }
  const env = PY_ENV_READ.exec(e);
  if (env && env.index === 0) {
    const name = env[2] ?? env[4] ?? env[6]!;
    const dir = t.topo.envDirs.get(name);
    return dir ? { dir, via: name } : null;
  }
  const nodes = t.ctx.getNodesInFile(file);
  const lines = pyLines(t, file);
  const self = /^self\s*\.\s*([A-Za-z_]\w*)$/.exec(e);
  if (self) {
    const cls = classAt(nodes, line);
    if (!cls) return null;
    const found = assignments(lines, cls.startLine - 1, cls.endLine ?? cls.startLine, String.raw`self\s*\.\s*${self[1]}`);
    return agreed(found.map((a) => pyBaseBinding(t, file, a.line, a.rhs, depth + 1)));
  }
  if (/^[A-Za-z_]\w*$/.test(e)) {
    const fn = enclosingFn(nodes, line);
    if (fn) {
      const params = pyParams(t, file, fn);
      if (params?.has(e)) {
        const cls = fn.name === '__init__' ? classAt(nodes, line) : null;
        return cls ? constructionBinding(t, cls, e, params.get(e)!, depth) : null;
      }
      const local = assignments(lines, fn.startLine, fn.endLine ?? fn.startLine, e);
      if (local.length > 0) return agreed(local.map((a) => pyBaseBinding(t, file, a.line, a.rhs, depth + 1)));
    }
    const top = assignments(lines, 0, lines.length, e, 0);
    return agreed(top.map((a) => pyBaseBinding(t, file, a.line, a.rhs, depth + 1)));
  }
  const field = /^(?:[A-Za-z_]\w*(?:\(\))?\s*\.\s*)+([A-Za-z_]\w*)$/.exec(e);
  return field ? settingsBinding(t, field[1]!, depth) : null;
}

function projectPyFiles(t: TopologyScan): string[] {
  return (t.pyFiles ??= t.ctx.getAllFiles().filter((f) => f.endsWith('.py') && !isTestPath(f) && !isGeneratedFile(f)));
}

/** A constructor parameter's value at every construction of its class outside tests — all must agree. */
function constructionBinding(t: TopologyScan, cls: Node, param: string, position: number, depth: number): TopologyBinding | null {
  const key = `new:${cls.id}:${param}`;
  if (t.memo.has(key)) return t.memo.get(key)!;
  t.memo.set(key, null); // a construction that reaches back here is unknown
  const classes = t.ctx.getNodesByName(cls.name).filter((n) => n.kind === 'class' && n.language === 'python');
  let result: TopologyBinding | null = null;
  if (classes.length === 1) {
    const readings: Array<TopologyBinding | null> = [];
    const call = new RegExp(String.raw`(?<![\w])${escapeRe(cls.name)}\s*\(`, 'g');
    const keyword = new RegExp(String.raw`^${param}\s*=(?!=)\s*`);
    for (const file of projectPyFiles(t)) {
      const content = t.ctx.readFile(file);
      if (!content || !content.includes(cls.name)) continue;
      const safe = pyLines(t, file).join('\n');
      const lineOf = makeLineAt(safe, 1);
      call.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = call.exec(safe)) !== null) {
        if (/\bclass\s+$/.test(safe.slice(Math.max(0, m.index - 12), m.index))) continue;
        const args = argumentsAt(safe, m.index + m[0].length - 1) ?? [];
        const firstNamed = args.findIndex((a) => /^\*|^[A-Za-z_]\w*\s*=(?!=)/.test(a));
        const byPosition = firstNamed < 0 ? args : args.slice(0, firstNamed);
        const named = args.find((a) => keyword.test(a));
        const arg = named !== undefined ? named.replace(keyword, '') : position >= 0 ? byPosition[position] : undefined;
        readings.push(arg === undefined ? null : pyBaseBinding(t, file, lineOf(m.index), arg, depth + 1));
      }
    }
    result = agreed(readings);
  }
  t.memo.set(key, result);
  return result;
}

/**
 * A settings field read off an object (`settings.crud_base_url`): the one
 * class in the project that declares it. A pydantic `BaseSettings` field reads
 * its environment name (`alias=` / `validation_alias=`, else `env_prefix` +
 * the field, upper-cased), any field its default.
 */
function settingsBinding(t: TopologyScan, field: string, depth: number): TopologyBinding | null {
  const key = `field:${field}`;
  if (t.memo.has(key)) return t.memo.get(key)!;
  t.memo.set(key, null);
  const defs: Array<{ file: string; line: number; settings: boolean; body: string; value: string | null }> = [];
  const decl = new RegExp(String.raw`^(\s+)${field}\s*(?::\s*[^=]+?)?\s*(?:=(?!=)\s*(.+))?$`);
  for (const file of projectPyFiles(t)) {
    if (!t.ctx.readFile(file)?.includes(field)) continue;
    const lines = pyLines(t, file);
    for (let i = 0; i < lines.length; i++) {
      const head = /^(\s*)class\s+\w+\s*(?:\(([^)]*)\))?\s*:/.exec(lines[i]!);
      if (!head) continue;
      const indent = head[1]!.length;
      let end = i + 1;
      while (end < lines.length && (!lines[end]!.trim() || lines[end]!.length - lines[end]!.trimStart().length > indent)) end++;
      const bodyIndent = lines.slice(i + 1, end).find((l) => l.trim())?.search(/\S/) ?? -1;
      for (let j = i + 1; j < end; j++) {
        const m = decl.exec(lines[j]!);
        if (!m || m[1]!.length !== bodyIndent || (!m[2] && !lines[j]!.includes(':'))) continue;
        defs.push({ file, line: j + 1, settings: /BaseSettings/.test(head[2] ?? ''), body: lines.slice(i, end).join('\n'), value: m[2] ?? null });
      }
    }
  }
  let result: TopologyBinding | null = null;
  if (defs.length === 1) {
    const def = defs[0]!;
    if (def.settings) {
      const alias = /\b(?:validation_alias|alias|env)\s*=\s*['"]([\w.-]+)['"]/.exec(def.value ?? '')?.[1];
      const prefix = /\benv_prefix\s*=\s*['"]([^'"]*)['"]/.exec(def.body)?.[1] ?? '';
      const name = alias ?? (prefix + field).toUpperCase();
      const dir = t.topo.envDirs.get(name);
      if (dir) result = { dir, via: name };
    }
    if (!result && def.value) {
      // `Field("http://crud:8001", …)` / `Field(default=…)` / `field(default_factory=lambda: os.getenv("X"))`.
      const env = PY_ENV_READ.exec(def.value);
      const fieldCall = /^Field\s*\(|^field\s*\(/.exec(def.value);
      const args = fieldCall ? argumentsAt(def.value, fieldCall[0].length - 1) ?? [] : null;
      const value = env ? env[0] : args ? (args.find((a) => /^default\s*=/.test(a))?.replace(/^default\s*=\s*/, '') ?? (args[0] && !/^\w+\s*=/.test(args[0]) ? args[0] : null)) : def.value;
      if (value) result = pyBaseBinding(t, def.file, def.line, value, depth + 1);
    }
  }
  t.memo.set(key, result);
  return result;
}

/** Narrow each Python call whose base URL traces to one compose service onto that service's routes. */
function bindTopology(ctx: ResolutionContext, sites: readonly HttpSite[]): void {
  const traced = sites.filter((s) => s.base !== undefined);
  if (traced.length === 0) return;
  const topo = readComposeTopology(ctx.getProjectRoot());
  if (!topo) return;
  const t: TopologyScan = { ctx, topo, pyFiles: null, lines: new Map(), memo: new Map() };
  for (const site of traced) {
    const scope = pyBaseBinding(t, site.file, site.base!.line, site.base!.expr);
    if (scope) site.scope = scope;
  }
}

// -----------------------------------------------------------------------------
// Gateway proxies
// -----------------------------------------------------------------------------

/** The request's own path, passed on: Starlette / FastAPI `request.url.path`, Flask `request.path`. */
const INCOMING_PATH_GATE = /\.url\.path\b|\brequest\.(?:full_)?path\b/;
const INCOMING_PATH = /^(?:[A-Za-z_]\w*\.url\.path|request\.(?:full_)?path)$/;
const FORWARD_CALL = /(?<![\w.])((?:[A-Za-z_]\w*\s*\.\s*)*[A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
const FORWARD_METHODS = /^(?:request|send|stream|build_request|forward|proxy)$/;
const HTTP_CLIENT_RECEIVER = /(?:client|http|session|upstream|backend|proxy)$/i;

interface Proxy {
  route: HttpRoute;
  handler: Node;
  line: number;
  callee: string;
}

/**
 * Python route handlers that forward the request they got: a call on an HTTP
 * client (`crud_client.request(request.method, request.url.path, …)`) that
 * passes the incoming path on. Nested functions count — a gateway often does
 * the forwarding in a closure it runs off-thread.
 */
function gatewayProxies(ctx: ResolutionContext, routes: readonly HttpRoute[]): Proxy[] {
  const byFile = new Map<string, HttpRoute[]>();
  for (const r of routes) {
    if (!r.node.filePath.endsWith('.py') || isTestPath(r.node.filePath)) continue;
    const list = byFile.get(r.node.filePath) ?? [];
    list.push(r);
    byFile.set(r.node.filePath, list);
  }
  const out: Proxy[] = [];
  for (const [file, list] of byFile) {
    const content = ctx.readFile(file);
    if (!content || !INCOMING_PATH_GATE.test(content)) continue;
    const lines = stripCommentsForRegex(content, 'python').split('\n');
    const fns = ctx.getNodesInFile(file).filter((n) => n.kind === 'function' || n.kind === 'method');
    const forwards = new Map<string, { line: number; callee: string } | null>();
    for (const route of list) {
      // The handler is the def the route's decorators sit on.
      let handler: Node | null = null;
      for (const fn of fns) {
        if (fn.startLine > route.node.startLine && fn.startLine - route.node.startLine <= 20 && (!handler || fn.startLine < handler.startLine)) handler = fn;
      }
      if (!handler) continue;
      let forward = forwards.get(handler.id);
      if (forward === undefined) {
        forward = null;
        const body = lines.slice(handler.startLine - 1, handler.endLine ?? handler.startLine).join('\n');
        const lineOf = makeLineAt(body, handler.startLine);
        FORWARD_CALL.lastIndex = 0;
        let m: RegExpExecArray | null;
        while (!forward && (m = FORWARD_CALL.exec(body)) !== null) {
          const receiver = m[1]!.replace(/\s+/g, '');
          if (!FORWARD_METHODS.test(m[2]!) && !(HTTP_CLIENT_RECEIVER.test(receiver) && HTTP_VERBS.has(m[2]!.toUpperCase()))) continue;
          const args = argumentsAt(body, m.index + m[0].length - 1);
          if (args?.some((a) => INCOMING_PATH.test(a))) forward = { line: lineOf(m.index), callee: `${receiver}.${m[2]}` };
        }
        forwards.set(handler.id, forward);
      }
      if (forward) out.push({ route, handler, ...forward });
    }
  }
  return out;
}

const sameSegs = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, i) => (PARAM_SEG.test(s) && PARAM_SEG.test(b[i]!)) || s === b[i]);

/** A proxy route's handler → the one route in another file with its method and exact path. */
function proxyEdges(proxies: readonly Proxy[], routes: readonly HttpRoute[], edges: Edge[], seen: Set<string>): void {
  for (const p of proxies) {
    if (p.route.segs.some((s) => CATCH_ALL.test(s))) continue; // `{suffix:path}` forwards anything
    const backends = routes.filter((r) =>
      r.node.filePath !== p.route.node.filePath && r.method === p.route.method &&
      !r.segs.some((s) => CATCH_ALL.test(s)) && sameSegs(r.segs, p.route.segs));
    if (backends.length !== 1) continue;
    const target = backends[0]!.node;
    const key = `${p.handler.id}>${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: p.handler.id,
      target: target.id,
      kind: 'calls',
      line: p.line,
      column: 0,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'http-proxy',
        channel: 'http-proxy',
        callee: p.callee,
        tier: TIER_SERVER_TO_SERVER,
        method: p.route.method,
        href: '/' + p.route.segs.join('/'),
        registeredAt: `${target.filePath}:${target.startLine}`,
      },
    });
  }
}

// =============================================================================
// 2. Queue job → consumer
// =============================================================================

const QUEUE_ADD = new RegExp(CHAIN_START + /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*add\s*\(\s*(['"`])([^'"`]+)\2/.source, 'g');
const QUEUE_SHAPED = /queue|jobs?$|worker|bull|flow|producer/i;
const NEW_WORKER = /\bnew\s+Worker\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*/g;
const QUEUE_PROCESS = new RegExp(CHAIN_START + /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*process\s*\(\s*(?:(['"`])([^'"`]+)\2\s*,\s*)?(?:\d+\s*,\s*)?/.source, 'g');
/** A handler argument: a named function (group 1), or an inline function. */
const HANDLER_ARG = /^(?:(?:async\s+)?([A-Za-z_$][\w$.]*)\s*(?:[,)]|$)|(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>))/;

interface QueueProducer {
  fn: Node;
  file: string;
  line: number;
  column: number;
  callee: string;
  queue: string | null;
  job: string;
}

interface QueueConsumer {
  node: Node;
  file: string;
  line: number;
  queue: string | null;
  /** Null: every job on the queue (`@Process()` with no name, a WorkerHost's `process`, `new Worker`). */
  job: string | null;
}

/** The queue a receiver is bound to, by its binding in this file or the file it is imported from. */
function queueFor(ctx: ResolutionContext, facts: FileFacts, receiver: string, cache: Map<string, FileFacts | null>): string | null {
  const chain = receiver.replace(/\s+/g, '').replace(/^this\./, '').split('.');
  const head = chain[0]!;
  const own = facts.queues.get(head);
  if (own) return own;
  const imported = importedFacts(ctx, facts, head, cache);
  if (imported) {
    const bound = imported.facts.queues.get(imported.exportedName);
    if (bound) return bound;
  }
  return null;
}

/** The function a handler argument names or encloses; null when it is neither. */
function handlerNode(ctx: ResolutionContext, facts: FileFacts, text: string, line: number, cache: Map<string, FileFacts | null>): Node | null {
  const m = HANDLER_ARG.exec(text.trimStart());
  if (!m) return null;
  if (m[1]) {
    const name = m[1].split('.').pop()!;
    const candidates = ctx.getNodesByName(name).filter((n) => n.kind === 'function' || n.kind === 'method');
    const local = candidates.filter((n) => n.filePath === facts.file);
    if (local.length === 1) return local[0]!;
    if (local.length > 1) return null;
    const imported = importedFacts(ctx, facts, m[1].split('.')[0]!, cache);
    if (imported) {
      const viaImport = candidates.filter((n) => n.filePath === imported.facts.file);
      if (viaImport.length === 1) return viaImport[0]!;
    }
    return candidates.length === 1 ? candidates[0]! : null;
  }
  return enclosingFn(facts.nodes, line) ?? enclosingValue(facts.nodes, line);
}

/** The nearest class declared at or after `index`, as its node. */
function classAfter(facts: FileFacts, index: number): Node | null {
  const m = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  m.lastIndex = index;
  const hit = m.exec(facts.safe);
  if (!hit) return null;
  const line = facts.lineOf(hit.index);
  return facts.nodes.find((n) => n.kind === 'class' && n.name === hit[1] && n.startLine >= line - 2) ?? null;
}

/** The method node a decorator at `end` sits on, inside `cls` when given. */
function decoratedMethod(facts: FileFacts, end: number, cls: Node | null): Node | null {
  const named = methodNameAfter(facts.safe, end);
  if (!named) return null;
  const line = facts.lineOf(named.index);
  return (
    facts.nodes.find(
      (n) =>
        (n.kind === 'method' || n.kind === 'function') &&
        n.name === named.name &&
        n.startLine >= line - 1 &&
        n.startLine <= line + 1 &&
        (!cls || (n.startLine >= cls.startLine && n.endLine <= cls.endLine))
    ) ?? null
  );
}

function collectQueue(ctx: ResolutionContext, facts: FileFacts, producers: QueueProducer[], consumers: QueueConsumer[], cache: Map<string, FileFacts | null>): void {
  const { safe, lineOf } = facts;
  let m: RegExpExecArray | null;
  QUEUE_ADD.lastIndex = 0;
  while ((m = QUEUE_ADD.exec(safe)) !== null) {
    const receiver = m[1]!;
    const queue = queueFor(ctx, facts, receiver, cache);
    const last = receiver.replace(/\s+/g, '').split('.').pop()!;
    if (queue === null && !QUEUE_SHAPED.test(last)) continue;
    const line = lineOf(m.index);
    const fn = enclosingFn(facts.nodes, line);
    if (!fn) continue;
    producers.push({ fn, file: facts.file, line, column: facts.columnOf(m.index), callee: `${receiver.replace(/\s+/g, '')}.add`, queue, job: m[3]! });
  }

  // Nest: `@Processor('email')` on a class; `@Process('welcome')` on its methods,
  // or a WorkerHost's `process(job)`.
  for (const proc of decorators(safe, 'Processor')) {
    const queue = firstLiteral(proc.args);
    const cls = classAfter(facts, proc.end);
    if (!cls) continue;
    let any = false;
    for (const job of decorators(safe, 'Process')) {
      const line = lineOf(job.index);
      if (line < cls.startLine || line > cls.endLine) continue;
      const method = decoratedMethod(facts, job.end, cls);
      if (!method) continue;
      any = true;
      consumers.push({ node: method, file: facts.file, line, queue, job: firstLiteral(job.args) });
    }
    if (!any) {
      const process = facts.nodes.find((n) => n.kind === 'method' && n.name === 'process' && n.startLine >= cls.startLine && n.endLine <= cls.endLine);
      if (process) consumers.push({ node: process, file: facts.file, line: process.startLine, queue, job: null });
    }
  }

  // BullMQ: `new Worker('email', handler)`.
  NEW_WORKER.lastIndex = 0;
  while ((m = NEW_WORKER.exec(safe)) !== null) {
    const line = lineOf(m.index);
    const node = handlerNode(ctx, facts, safe.slice(m.index + m[0].length, m.index + m[0].length + 200), line, cache);
    if (!node) continue;
    consumers.push({ node, file: facts.file, line, queue: m[2]!, job: null });
  }

  // Bull: `queue.process('welcome', handler)` / `queue.process(handler)`.
  QUEUE_PROCESS.lastIndex = 0;
  while ((m = QUEUE_PROCESS.exec(safe)) !== null) {
    const receiver = m[1]!;
    const queue = queueFor(ctx, facts, receiver, cache);
    const last = receiver.replace(/\s+/g, '').split('.').pop()!;
    if (queue === null && !QUEUE_SHAPED.test(last)) continue;
    const line = lineOf(m.index);
    const node = handlerNode(ctx, facts, safe.slice(m.index + m[0].length, m.index + m[0].length + 200), line, cache);
    if (!node) continue;
    consumers.push({ node, file: facts.file, line, queue, job: m[3] ?? null });
  }
}

function pairQueue(producers: readonly QueueProducer[], consumers: readonly QueueConsumer[], edges: Edge[], seen: Set<string>): void {
  for (const p of producers) {
    let candidates = consumers.filter((c) => (p.queue === null || c.queue === null || c.queue === p.queue) && (c.job === null || c.job === p.job));
    // The most specific pairing wins: the job by name on the named queue,
    // then the job by name, then the queue's default consumer.
    const exact = candidates.filter((c) => c.job === p.job && c.queue === p.queue && p.queue !== null);
    if (exact.length > 0) candidates = exact;
    else {
      const byJob = candidates.filter((c) => c.job === p.job);
      if (byJob.length > 0) candidates = byJob;
      else if (p.queue === null) continue; // an unnamed queue and no consumer naming the job: a guess
      else candidates = candidates.filter((c) => c.queue === p.queue);
    }
    if (candidates.length === 0 || candidates.length > EVENT_FANOUT_CAP) continue;
    for (const c of candidates) {
      if (c.node.id === p.fn.id) continue;
      const key = `${p.fn.id}>${c.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: p.fn.id,
        target: c.node.id,
        kind: 'calls',
        line: p.line,
        column: p.column,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'queue-job',
          channel: 'queue',
          callee: p.callee,
          event: p.job,
          ...(p.queue ?? c.queue ? { queue: p.queue ?? c.queue } : {}),
          registeredAt: `${c.file}:${c.line}`,
        },
      });
    }
  }
}

// =============================================================================
// 3. Events: a bus, and sockets both ways
// =============================================================================

// A word character opens these chains, so a word's first character is the
// only start that can match (same argument as CHAIN_START).
const EMIT = /(?<![\w$])((?:[\w$]+(?:\([^()]*\))?\s*\.\s*)*[\w$]+)\s*\.\s*(emit|emitAsync)\s*\(\s*(['"`])([^'"`\n]+)\3/g;
const SOCKET_ON = /(?<![\w$])((?:[\w$]+(?:\([^()]*\))?\s*\.\s*)*[\w$]+)\s*\.\s*(?:on|once)\s*\(\s*(['"`])([^'"`\n]+)\2\s*,\s*/g;
const SOCKET_WORDS = /^(?:socket|io|ws|wss|client|server|namespace|nsp|conn|connection|gateway|broadcast|to|in|of|except|volatile|local|sockets|socketServer|wsServer|room|channel|pusher|ably|ioClient|socketClient|sock)$/;
const BUS_WORDS = /^(?:eventEmitter|emitter|events|eventBus|bus|dispatcher|pubsub|publisher|eventPublisher|ee|hub|mediator|broker|messageBus|appEvents|domainEvents|eventsService|eventService)$/;
/** The transport's own events — every socket emits and handles them; pairing them says nothing. */
const GENERIC_EVENT =
  /^(?:error|connect|connect_error|connect_failed|connection|disconnect|disconnecting|reconnect|reconnect_attempt|reconnecting|reconnect_error|reconnect_failed|close|open|end|data|ready|drain|finish|pipe|unpipe|listening|timeout|ping|pong|upgrade|newListener|removeListener)$/;

interface Dispatch {
  fn: Node;
  file: string;
  line: number;
  column: number;
  callee: string;
  event: string;
  shape: 'bus' | 'socket';
  side: 'server' | 'client';
}

interface Handler {
  node: Node;
  file: string;
  line: number;
  /** An event name, or an `@OnEvent` glob. */
  pattern: string;
  kind: 'bus' | 'socket';
  side: 'server' | 'client';
}

function shapeOf(receiver: string): 'bus' | 'socket' | null {
  const segs = receiver.replace(/\([^()]*\)/g, '').replace(/\s+/g, '').split('.').filter((s) => s !== 'this');
  if (segs.some((s) => SOCKET_WORDS.test(s))) return 'socket';
  if (segs.some((s) => BUS_WORDS.test(s))) return 'bus';
  return null;
}

function collectEvents(ctx: ResolutionContext, facts: FileFacts, dispatches: Dispatch[], handlers: Handler[], cache: Map<string, FileFacts | null>): void {
  const { safe, lineOf } = facts;
  const side: 'server' | 'client' = facts.socketServer ? 'server' : 'client';
  let m: RegExpExecArray | null;
  EMIT.lastIndex = 0;
  while ((m = EMIT.exec(safe)) !== null) {
    const shape = shapeOf(m[1]!);
    if (!shape || GENERIC_EVENT.test(m[4]!)) continue;
    const line = lineOf(m.index);
    const fn = enclosingFn(facts.nodes, line);
    if (!fn) continue;
    dispatches.push({ fn, file: facts.file, line, column: facts.columnOf(m.index), callee: `${m[1]!.replace(/\s+/g, '')}.${m[2]!}`, event: m[4]!, shape, side });
  }
  for (const d of decorators(safe, 'OnEvent')) {
    const method = decoratedMethod(facts, d.end, null);
    if (!method) continue;
    const patterns = d.args.trimStart().startsWith('[') ? allLiterals(d.args) : [firstLiteral(d.args)].filter((x): x is string => x !== null);
    for (const pattern of patterns) handlers.push({ node: method, file: facts.file, line: lineOf(d.index), pattern, kind: 'bus', side });
  }
  for (const d of decorators(safe, 'SubscribeMessage')) {
    const method = decoratedMethod(facts, d.end, null);
    const event = firstLiteral(d.args);
    if (!method || event === null) continue;
    handlers.push({ node: method, file: facts.file, line: lineOf(d.index), pattern: event, kind: 'socket', side: 'server' });
  }
  SOCKET_ON.lastIndex = 0;
  while ((m = SOCKET_ON.exec(safe)) !== null) {
    if (shapeOf(m[1]!) !== 'socket' || GENERIC_EVENT.test(m[3]!)) continue;
    const line = lineOf(m.index);
    const node = handlerNode(ctx, facts, safe.slice(m.index + m[0].length, m.index + m[0].length + 200), line, cache);
    if (!node) continue;
    handlers.push({ node, file: facts.file, line, pattern: m[3]!, kind: 'socket', side });
  }
}

/** `user.*` matches one segment, `**` any; anything else is exact. */
function eventMatches(pattern: string, event: string): boolean {
  if (pattern === event) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.split('**').map((part) => part.split('*').map(escapeRe).join('[^.]+')).join('.*') + '$');
  return re.test(event);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pairEvents(dispatches: readonly Dispatch[], handlers: readonly Handler[], edges: Edge[], seen: Set<string>): void {
  // Fan-out is judged per event name on each side, as the emitter pass does.
  const dispatchesByEvent = new Map<string, Dispatch[]>();
  for (const d of dispatches) dispatchesByEvent.set(`${d.shape}:${d.event}`, [...(dispatchesByEvent.get(`${d.shape}:${d.event}`) ?? []), d]);
  for (const [, group] of dispatchesByEvent) {
    if (group.length > EVENT_FANOUT_CAP) continue;
    for (const d of group) {
      let matched: Handler[];
      let tier: string | null = null;
      if (d.shape === 'bus') matched = handlers.filter((h) => h.kind === 'bus' && eventMatches(h.pattern, d.event));
      else if (d.side === 'client') {
        matched = handlers.filter((h) => h.kind === 'socket' && h.side === 'server' && h.pattern === d.event);
        tier = TIER_CLIENT_TO_SERVER;
      } else {
        matched = handlers.filter((h) => h.kind === 'socket' && h.side === 'client' && h.pattern === d.event);
        tier = TIER_SERVER_TO_CLIENT;
      }
      if (matched.length === 0 || matched.length > EVENT_FANOUT_CAP) continue;
      for (const h of matched) {
        if (h.node.id === d.fn.id) continue;
        const key = `${d.fn.id}>${h.node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: d.fn.id,
          target: h.node.id,
          kind: 'calls',
          line: d.line,
          column: d.column,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'event-bus',
            channel: d.shape === 'bus' ? 'event' : 'socket',
            callee: d.callee,
            event: d.event,
            ...(tier ? { tier } : {}),
            registeredAt: `${h.file}:${h.line}`,
          },
        });
      }
    }
  }
}

// =============================================================================
// The pass
// =============================================================================

// =============================================================================
// 4. Test request → route
// =============================================================================

/*
 * Spring and Laravel tests reach a controller by URL, never by a call:
 * MockMvc's `perform(post("/owners/new"))`, WebTestClient's `.get().uri(…)`,
 * TestRestTemplate, RestAssured, and Laravel's `$this->postJson('api/me')`.
 * Without an edge every controller those suites exercise reads as untested —
 * the viewer's "No test reaches this" and explore's `tests:` line both walk
 * callers. One edge per (test, route), from the test method (the file, for a
 * Pest closure) to the route; the route's own edge reaches the handler.
 *
 * These are the one kind of edge whose source is a test. They don't count
 * toward a route's fan-in (countIncomingEdges), so a well-tested endpoint
 * never becomes a hub the Steps walk refuses to enter.
 */

const TEST_REQUEST_FILE = /\.(?:java|kt|kts|php)$/;
const TEST_VERBS = 'get|post|put|patch|delete|head|options';
/** A bare `get("/x")` is MockMvc's only where the file imports its builders. */
const MOCKMVC_BUILDERS = /\bMockMvcRequestBuilders\b/;
const MOCKMVC_BUILDER = new RegExp(String.raw`(?<![\w$.])(?:MockMvcRequestBuilders\s*\.\s*)?(${TEST_VERBS}|multipart)\s*\(`, 'g');
const MOCKMVC_REQUEST = /(?<![\w$.])(?:MockMvcRequestBuilders\s*\.\s*)?request\s*\(\s*HttpMethod\s*\.\s*([A-Z]+)\s*,/g;
const KOTLIN_MOCKMVC = new RegExp(String.raw`\b\w*[mM]ockMvc\s*\.\s*(${TEST_VERBS})\s*\(`, 'g');
const WEB_TEST_CLIENT = new RegExp(String.raw`\.\s*(${TEST_VERBS})\s*\(\s*\)\s*\.\s*uri\s*\(`, 'g');
const REST_TEMPLATE = /\b\w*[Rr]estTemplate\s*\.\s*(getForEntity|getForObject|postForEntity|postForObject|postForLocation|put|delete|patchForObject|exchange)\s*\(/g;
const REST_ASSURED = new RegExp(String.raw`(?:\.\s*when\s*\(\s*\)\s*|\bRestAssured\s*)\.\s*(${TEST_VERBS})\s*\(`, 'g');
const LARAVEL_REQUEST = new RegExp(String.raw`->\s*(${TEST_VERBS})(Json)?\s*\(`, 'g');
const LARAVEL_JSON_CALL = /->\s*(?:json|call)\s*\(\s*(['"])([A-Za-z]+)\1\s*,/g;
/** A project's own request helper, named for its verb: koel's `getAs($url, $user)`, `postAsAdmin(…)`. */
const LARAVEL_HELPER = new RegExp(String.raw`->\s*((${TEST_VERBS})[A-Z]\w*)\s*\(`, 'g');
const LARAVEL_BUILTIN_JSON = new RegExp(String.raw`^(?:${TEST_VERBS})Json$`);
/** A Laravel request made in a method body: the call a request helper must end in. */
const LARAVEL_REQUEST_IN_BODY = new RegExp(String.raw`->\s*(?:(?:${TEST_VERBS})(?:Json)?|json|call)\s*\(`);
/** Pest's `get('/x')` / `postJson(…)` helpers, where the file imports them. */
const PEST_HELPERS = /Pest\\Laravel/;
const PEST_REQUEST = new RegExp(String.raw`(?<![\w$>:\\])(${TEST_VERBS})(Json)?\s*\(`, 'g');
const TEST_REQUEST_GATE = /[mM]ockMvc|[wW]ebTestClient\b|[rR]estTemplate\b|\bRestAssured\b|\.\s*when\s*\(\s*\)|\$this\s*->|Pest\\Laravel/;

export function hasTestRequestPattern(filePath: string, content: string): boolean {
  return TEST_REQUEST_FILE.test(filePath) && isTestPath(filePath) && TEST_REQUEST_GATE.test(content);
}

interface TestSite {
  from: Node;
  line: number;
  column: number;
  callee: string;
  method: string;
  segs: string[];
  display: string;
}

/**
 * The string a request's path argument builds, starting at `i`: literals
 * verbatim, each computed piece (a concatenated operand, an interpolation, a
 * Spring `{var}` template) as one HOLE. Null unless it starts with a literal —
 * `route('songs.index')` or `$url` names no path this pass can read.
 */
function readRequestPath(s: string, i: number, lang: 'java' | 'kotlin' | 'php'): string | null {
  const concat = lang === 'php' ? '.' : '+';
  let out = '';
  let literal = false;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      const interpolates = q === '"' && lang !== 'java';
      for (i++; i < s.length && s[i] !== q; i++) {
        const c = s[i]!;
        if (c === '\\') { out += s[++i] ?? ''; continue; }
        if (interpolates && c === '$' && /[{\w]/.test(s[i + 1] ?? '')) {
          // `${expr}`, `$name`, PHP's `$user->id` / `$row['k']`
          if (s[i + 1] === '{') i = closeBrace(s, i + 1);
          else {
            while (/\w/.test(s[i + 1] ?? '')) i++;
            if (lang === 'php') {
              while (s.startsWith('->', i + 1) && /\w/.test(s[i + 3] ?? '')) for (i += 2; /\w/.test(s[i + 1] ?? ''); i++);
            }
          }
          out += HOLE;
          continue;
        }
        if (interpolates && lang === 'php' && c === '{' && s[i + 1] === '$') {
          i = closeBrace(s, i);
          out += HOLE;
          continue;
        }
        out += c;
      }
      if (i >= s.length) return null;
      i++;
      literal = true;
    } else {
      if (!literal) return null;
      const end = operandEnd(s, i, concat);
      if (end === i) break;
      out += HOLE;
      i = end;
    }
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === concat && !(concat === '.' && /\d/.test(s[i + 1] ?? ''))) { i++; continue; }
    break;
  }
  if (!literal) return null;
  // Spring's URI templates: `get("/owners/{ownerId}", id)`.
  return lang === 'php' ? out : out.replace(/\{[^{}/]*\}/g, HOLE);
}

/** Index of the `}` closing the `{` at `open` (or the end of `s`). */
function closeBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length - 1;
}

/** End of a concatenated operand starting at `i`: the next top-level operator, `,` or `)`. */
function operandEnd(s: string, i: number, concat: string): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';' || (c === concat && !(concat === '.' && /\d/.test(s[i + 1] ?? ''))))) return i;
    // `$user->id`: an arrow is part of the operand, not a concatenation.
    if (c === '-' && s[i + 1] === '>') i++;
  }
  return i;
}

/** A test URL as route segments: app-relative, holes as `*`; null when nothing literal is left. */
function testRequestPath(raw: string): { segs: string[]; display: string } | null {
  let p = raw;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i.exec(p);
  if (absolute) p = absolute[1] ?? '/';
  const segs = p
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.includes(HOLE) ? '*' : s));
  if (segs.some((s) => s !== '*') === false && segs.length > 0) return null;
  return { segs, display: '/' + segs.map((s) => (s === '*' ? '${…}' : s)).join('/') };
}

/**
 * Whether `name` is a request helper in the project's tests: a PHP method
 * defined in a test file whose body makes a Laravel request, directly or
 * through one more `$this->helper(…)` (koel's `getAs` → `jsonAs` →
 * `$this->json($method, $uri)`). The name alone never decides it.
 */
function isRequestHelper(ctx: ResolutionContext, name: string, memo: Map<string, boolean>, depth = 0): boolean {
  const known = memo.get(name);
  if (known !== undefined) return known;
  memo.set(name, false); // cycle guard
  let ok = false;
  for (const n of ctx.getNodesByName(name)) {
    if (n.kind !== 'method' || n.language !== 'php' || !isTestPath(n.filePath)) continue;
    const lines = ctx.getFileLines?.(n.filePath) ?? ctx.readFile(n.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) continue;
    const body = lines.slice(n.startLine - 1, n.endLine).join('\n');
    if (LARAVEL_REQUEST_IN_BODY.test(body)) ok = true;
    else if (depth === 0) {
      for (const call of body.matchAll(/\$this\s*->\s*(\w+)\s*\(/g)) {
        if (call[1] !== name && isRequestHelper(ctx, call[1]!, memo, depth + 1)) { ok = true; break; }
      }
    }
    if (ok) break;
  }
  // A depth-limited "no" is not final; only remember it at the top level.
  if (ok || depth === 0) memo.set(name, ok);
  else memo.delete(name);
  return ok;
}

/**
 * Whether the `->` at `arrow` ends a chain rooted at `$this` that only CALLS
 * methods — `$this->actingAs($u)->withHeaders([…])->` — so `$this->app->get(
 * 'config')` (a container lookup through a property) is never a request.
 */
function thisRootedCalls(s: string, arrow: number): boolean {
  let from = arrow;
  for (let tries = 0; tries < 4; tries++) {
    const root = s.lastIndexOf('$this', from - 1);
    if (root < 0) return false;
    let i = root + '$this'.length;
    for (;;) {
      while (/\s/.test(s[i] ?? '')) i++;
      if (i === arrow) return true;
      if (!s.startsWith('->', i)) break;
      i += 2;
      while (/\s/.test(s[i] ?? '')) i++;
      const ident = /^\w+/.exec(s.slice(i, i + 64));
      if (!ident) break;
      i += ident[0].length;
      while (/\s/.test(s[i] ?? '')) i++;
      if (s[i] !== '(') break;
      const close = closeParen(s, i);
      if (close < 0) break;
      i = close + 1;
    }
    from = root;
  }
  return false;
}

function collectTestRequests(ctx: ResolutionContext, file: string, sites: TestSite[], helpers: Map<string, boolean>): void {
  const content = ctx.readFile(file);
  if (!content || !TEST_REQUEST_GATE.test(content)) return;
  const lang: 'java' | 'kotlin' | 'php' = file.endsWith('.php') ? 'php' : /\.kts?$/.test(file) ? 'kotlin' : 'java';
  const safe = stripCommentsForRegex(content, lang === 'php' ? 'php' : 'java');
  const lineOf = makeLineAt(safe, 1);
  let nodes: Node[] | null = null;
  const add = (index: number, argAt: number, method: string, callee: string): void => {
    const raw = readRequestPath(safe, argAt, lang);
    if (raw === null) return;
    const path = testRequestPath(raw);
    if (!path) return;
    const line = lineOf(index);
    nodes ??= ctx.getNodesInFile(file);
    const from = enclosingFn(nodes, line) ?? nodes.find((n) => n.kind === 'file');
    if (!from) return;
    const column = index - (safe.lastIndexOf('\n', index - 1) + 1);
    sites.push({ from, line, column, callee, method: method.toUpperCase(), segs: path.segs, display: path.display });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(safe)) !== null) fn(m);
  };
  const openOf = (m: RegExpExecArray) => m.index + m[0].length;

  if (lang === 'php') {
    each(LARAVEL_REQUEST, (m) => {
      if (thisRootedCalls(safe, m.index)) add(m.index, openOf(m), m[1]!, `$this->${m[1]}${m[2] ?? ''}`);
    });
    each(LARAVEL_JSON_CALL, (m) => {
      if (thisRootedCalls(safe, m.index)) add(m.index, openOf(m), m[2]!, '$this->json');
    });
    each(LARAVEL_HELPER, (m) => {
      const name = m[1]!;
      if (LARAVEL_BUILTIN_JSON.test(name)) return; // getJson / postJson, read above
      if (thisRootedCalls(safe, m.index) && isRequestHelper(ctx, name, helpers)) add(m.index, openOf(m), m[2]!, `$this->${name}`);
    });
    if (PEST_HELPERS.test(safe)) each(PEST_REQUEST, (m) => add(m.index, openOf(m), m[1]!, `${m[1]}${m[2] ?? ''}`));
    return;
  }
  if (MOCKMVC_BUILDERS.test(safe)) {
    each(MOCKMVC_BUILDER, (m) => add(m.index, openOf(m), m[1] === 'multipart' ? 'post' : m[1]!, m[1]!));
    each(MOCKMVC_REQUEST, (m) => add(m.index, openOf(m), m[1]!, 'request'));
  }
  each(KOTLIN_MOCKMVC, (m) => add(m.index, openOf(m), m[1]!, `mockMvc.${m[1]}`));
  each(WEB_TEST_CLIENT, (m) => add(m.index, openOf(m), m[1]!, `${m[1]}().uri`));
  each(REST_ASSURED, (m) => add(m.index, openOf(m), m[1]!, m[1]!));
  each(REST_TEMPLATE, (m) => {
    const name = m[1]!;
    let method: string | null = name.startsWith('get') ? 'GET' : name.startsWith('post') ? 'POST'
      : name === 'put' ? 'PUT' : name === 'delete' ? 'DELETE' : name.startsWith('patch') ? 'PATCH' : null;
    if (name === 'exchange') {
      const args = argumentsAt(safe, openOf(m) - 1);
      method = /HttpMethod\s*\.\s*([A-Z]+)/.exec(args?.[1] ?? '')?.[1] ?? null;
    }
    if (method) add(m.index, openOf(m), method, `restTemplate.${name}`);
  });
}

/** Edges from a test's request to the route it reaches. */
export async function testRequestEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const routes = httpRoutes(ctx);
  if (routes.length === 0) return [];
  const sites: TestSite[] = [];
  const helpers = new Map<string, boolean>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!TEST_REQUEST_FILE.test(file) || !isTestPath(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    collectTestRequests(ctx, file, sites, helpers);
  }
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const route = matchHttp({ fn: site.from, file: site.from.filePath, line: site.line, column: site.column, callee: site.callee,
      method: site.method, browser: false, segs: site.segs, suffix: false, display: site.display }, routes, new Set())[0];
    if (!route) continue;
    const key = `${site.from.id}>${route.node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: site.from.id,
      target: route.node.id,
      kind: 'calls',
      line: site.line,
      column: site.column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'test-request',
        channel: 'http',
        callee: site.callee,
        method: site.method,
        href: site.display,
        registeredAt: `${route.node.filePath}:${route.node.startLine}`,
      },
    });
  }
  return edges;
}

const HTTP_GATE = /\b(?:fetch|\$fetch|ofetch|axios|ky|got|useFetch|useSWR)\b|\.\s*(?:get|post|put|patch|delete|head|options|request|\$get|\$post)\s*[<(]/;
const QUEUE_GATE = /\.\s*add\s*\(|@Processor\s*\(|\bnew\s+Worker\s*[<(]|\.\s*process\s*\(/;
const EVENT_GATE = /\.\s*(?:emit|emitAsync|on|once)\s*\(|@OnEvent\s*\(|@SubscribeMessage\s*\(/;

export function hasCrossTierPattern(content: string): boolean {
  return HTTP_GATE.test(content) || PY_HTTP_GATE.test(content) || INCOMING_PATH_GATE.test(content) || QUEUE_GATE.test(content) || EVENT_GATE.test(content);
}

export async function crossTierEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const routes = httpRoutes(ctx);
  const httpSites: HttpSite[] = [];
  const producers: QueueProducer[] = [];
  const consumers: QueueConsumer[] = [];
  const dispatches: Dispatch[] = [];
  const handlers: Handler[] = [];
  const cache = new Map<string, FileFacts | null>();

  const jsFiles: string[] = [];
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    const python = file.endsWith('.py');
    if ((!JS_FILE.test(file) && !python) || isTestPath(file) || isGeneratedFile(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content) continue;
    if (python) {
      if (routes.length > 0 && PY_HTTP_GATE.test(content)) collectPythonHttpSites(ctx, file, content, httpSites);
      continue;
    }
    if (routes.length > 0) jsFiles.push(file);
    const wantsHttp = routes.length > 0 && HTTP_GATE.test(content);
    const wantsQueue = QUEUE_GATE.test(content);
    const wantsEvents = EVENT_GATE.test(content);
    if (!wantsHttp && !wantsQueue && !wantsEvents) continue;
    let facts = cache.get(file);
    if (facts === undefined) {
      facts = readFacts(ctx, file);
      cache.set(file, facts);
    }
    if (!facts) continue;
    if (wantsHttp) collectHttpSites(ctx, facts, httpSites, cache);
    if (wantsQueue) collectQueue(ctx, facts, producers, consumers, cache);
    if (wantsEvents) collectEvents(ctx, facts, dispatches, handlers, cache);
  }

  // Calls of a fetch wrapper, once every file has said which functions are one.
  const wrapperNames = new Set<string>();
  for (const facts of cache.values()) for (const name of facts?.wrappers.keys() ?? []) wrapperNames.add(name);
  if (wrapperNames.size > 0) {
    const names = new RegExp(String.raw`(?<![\w$.])(${[...wrapperNames].map(escapeRe).join('|')})\s*\(`, 'g');
    for (const file of jsFiles) {
      const content = ctx.readFile(file);
      names.lastIndex = 0;
      if (!content || !names.test(content)) continue;
      let facts = cache.get(file);
      if (facts === undefined) {
        facts = readFacts(ctx, file);
        cache.set(file, facts);
      }
      if (facts) collectWrapperSites(ctx, facts, names, httpSites, cache);
    }
  }
  bindTopology(ctx, httpSites);
  const proxies = gatewayProxies(ctx, routes);
  const proxyRouteIds = new Set(proxies.map((p) => p.route.node.id));

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const site of httpSites) {
    // A method-less call onto a registration serving several methods is one
    // hop to one handler: the first route stands for it, labelled with them all.
    const matched = matchHttp(site, routes, proxyRouteIds);
    const route = matched[0];
    if (!route || route.node.id === site.fn.id) continue;
    const key = `${site.fn.id}>${route.node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: site.fn.id,
      target: route.node.id,
      kind: 'calls',
      line: site.line,
      column: site.column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'http-client',
        channel: 'http',
        callee: site.callee,
        tier: site.file.endsWith('.py') ? TIER_SERVER_TO_SERVER : TIER_CLIENT_TO_SERVER,
        method: site.method ?? matched.map((r) => r.method).join('|'),
        href: site.display,
        registeredAt: `${route.node.filePath}:${route.node.startLine}`,
        ...(proxyRouteIds.has(route.node.id) ? { gateway: true } : {}),
        ...(site.scope ? { topology: `${site.scope.via} → ${site.scope.dir}` } : {}),
      },
    });
  }
  proxyEdges(proxies, routes, edges, seen);
  await onYield();
  pairQueue(producers, consumers, edges, seen);
  pairEvents(dispatches, handlers, edges, seen);
  return edges;
}
