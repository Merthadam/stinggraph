/**
 * MCP tool calls — a client's `session.call_tool("search_places", …)` onto the
 * server function registered as that tool (`@mcp.tool()` on
 * `async def search_places(…)`), Python MCP SDK / FastMCP.
 *
 * The client and the server are different processes joined by a transport the
 * graph cannot see; the tool's NAME is the string both sides write, the same
 * evidence the cross-tier passes pair on. Clients usually wrap `call_tool` in
 * a method of their own (`MapsClient.call(name, args)`, then
 * `self._call("resolve_destination_area", …)` around that), so a function
 * whose first parameter reaches `call_tool`'s name — directly, through a
 * plain alias, or through another such function — is a forwarder, and the
 * literal written at a forwarder's call site is the tool.
 *
 * Only a literal name pairs, and only with a tool exactly one server defines:
 * a name two servers register, or a name held in a variable, produces
 * nothing. The edge runs from the function that writes the literal (where
 * the request is decided, as the HTTP pass does for a `fetch`) to the tool
 * function: `calls`, `provenance: 'heuristic'`, `synthesizedBy: 'mcp-tool'`,
 * `channel: 'mcp'`, `tier: 'client→server'`, `tool`, `callee`, and
 * `registeredAt` — the tool's registration.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { isTestPath } from '../search/query-utils';
import { isGeneratedFile } from '../extraction/generated-detection';
import { enclosingFn, makeLineAt } from './synth-utils';
import { TIER_CLIENT_TO_SERVER } from './tier-synthesizer';

const MCP_IMPORT = /^\s*(?:from|import)\s+(?:fastmcp|mcp)\b/m;
const TOOL_DECORATOR = /@[A-Za-z_][\w.]*\.tool\b\s*(\(([^)]*)\))?/g;
const ADD_TOOL = /\.add_tool\s*\(\s*([A-Za-z_]\w*)([^)]*)\)/g;
const NAME_KWARG = /\bname\s*=\s*(['"])([^'"\n]+)\1/;
const LEADING_LITERAL = /^\s*(['"])([^'"\n]+)\1/;
const MAX_FORWARDER_DEPTH = 4;

/** Every MCP-touching pattern this pass reads; the incremental sync's gate. */
export function hasMcpToolPattern(content: string): boolean {
  return /\bcall_tool\s*\(|\.tool\b|\.add_tool\s*\(/.test(content);
}

interface Tool {
  node: Node;
  registeredAt: string;
}

const isPython = (f: string): boolean => f.endsWith('.py') && !isTestPath(f) && !isGeneratedFile(f);

function lineAt(safe: string, index: number): number {
  return safe.slice(0, index).split('\n').length;
}

/** The function a decorator at `line` sits on. */
function defAfter(nodes: readonly Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodes) {
    if (n.kind !== 'function' && n.kind !== 'method') continue;
    if (n.startLine > line && n.startLine - line <= 20 && (!best || n.startLine < best.startLine)) best = n;
  }
  return best;
}

function collectTools(ctx: ResolutionContext, file: string, safe: string, tools: Map<string, Tool[]>): void {
  const nodes = ctx.getNodesInFile(file);
  const add = (name: string, node: Node | null | undefined, line: number): void => {
    if (!node) return;
    const list = tools.get(name) ?? [];
    if (!list.some((t) => t.node.id === node.id)) list.push({ node, registeredAt: `${file}:${line}` });
    tools.set(name, list);
  };
  TOOL_DECORATOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_DECORATOR.exec(safe)) !== null) {
    const line = lineAt(safe, m.index);
    const fn = defAfter(nodes, line);
    if (!fn) continue;
    const args = m[2] ?? '';
    add(NAME_KWARG.exec(args)?.[2] ?? LEADING_LITERAL.exec(args)?.[2] ?? fn.name, fn, line);
  }
  ADD_TOOL.lastIndex = 0;
  while ((m = ADD_TOOL.exec(safe)) !== null) {
    const fnName = m[1]!;
    const fn = nodes.find((n) => (n.kind === 'function' || n.kind === 'method') && n.name === fnName);
    add(NAME_KWARG.exec(m[2]!)?.[2] ?? fnName, fn, lineAt(safe, m.index));
  }
}

/** A function's first parameter after `self` / `cls`, from its signature. */
function firstParam(fn: Node): string | null {
  const params = (fn.signature ?? '').replace(/^\s*\(/, '').split(',').map((p) => p.trim());
  const first = params.find((p) => p !== 'self' && p !== 'cls');
  const m = first ? /^([A-Za-z_]\w*)/.exec(first) : null;
  return m && m[1] !== '*' ? m[1]! : null;
}

/** Names of functions whose first parameter becomes the tool name of a `call_tool`. */
function forwarders(ctx: ResolutionContext, files: ReadonlyMap<string, string>): Set<string> {
  const names = new Set<string>(['call_tool']);
  for (let round = 0; round < MAX_FORWARDER_DEPTH; round++) {
    const callees = new RegExp(String.raw`(?<![\w])(?:[A-Za-z_][\w.]*\.)?(${[...names].join('|')})\s*\(\s*([A-Za-z_]\w*)\s*[,)]`, 'g');
    const found: string[] = [];
    for (const [file, safe] of files) {
      callees.lastIndex = 0;
      if (!callees.test(safe)) continue;
      const lines = safe.split('\n');
      for (const fn of ctx.getNodesInFile(file)) {
        if ((fn.kind !== 'function' && fn.kind !== 'method') || names.has(fn.name)) continue;
        const param = firstParam(fn);
        if (!param) continue;
        const body = lines.slice(fn.startLine - 1, fn.endLine ?? fn.startLine).join('\n');
        // The parameter, or a plain alias of it (`tool_name = name`).
        const held = new Set([param]);
        for (const a of body.matchAll(new RegExp(String.raw`\b([A-Za-z_]\w*)\s*=\s*${param}\s*$`, 'gm'))) held.add(a[1]!);
        callees.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = callees.exec(body)) !== null) {
          if (held.has(m[2]!)) {
            found.push(fn.name);
            break;
          }
        }
      }
    }
    const before = names.size;
    for (const f of found) names.add(f);
    if (names.size === before) break;
  }
  return names;
}

export async function mcpToolEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const tools = new Map<string, Tool[]>();
  const clients = new Map<string, string>(); // file → comment-stripped source
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!isPython(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content) continue;
    const safe = stripCommentsForRegex(content, 'python');
    if (MCP_IMPORT.test(content) && /\.(?:tool|add_tool)\b/.test(safe)) collectTools(ctx, file, safe, tools);
    clients.set(file, safe);
  }
  if (tools.size === 0) return [];
  await onYield();
  const names = forwarders(ctx, clients);
  const site = new RegExp(String.raw`(?<![\w])((?:[A-Za-z_][\w.]*\.)?(?:${[...names].join('|')}))\s*\(\s*(?:name\s*=\s*)?(['"])([^'"\n]+)\2`, 'g');

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [file, safe] of clients) {
    // Only a file that passes a string to something can name a tool.
    if (!/\(\s*(?:name\s*=\s*)?['"]/.test(safe)) continue;
    site.lastIndex = 0;
    if (!site.test(safe)) continue;
    const nodes = ctx.getNodesInFile(file);
    const lineOf = makeLineAt(safe, 1);
    site.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = site.exec(safe)) !== null) {
      const tool = m[3]!;
      const defs = tools.get(tool);
      if (!defs || defs.length !== 1) continue; // unknown, or two servers register it
      const line = lineOf(m.index);
      const fn = enclosingFn(nodes, line);
      const target = defs[0]!;
      if (!fn || fn.id === target.node.id) continue;
      const key = `${fn.id}>${target.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: fn.id,
        target: target.node.id,
        kind: 'calls',
        line,
        column: m.index - (safe.lastIndexOf('\n', m.index - 1) + 1),
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'mcp-tool',
          channel: 'mcp',
          tier: TIER_CLIENT_TO_SERVER,
          tool,
          callee: m[1]!.replace(/\s+/g, ''),
          registeredAt: target.registeredAt,
        },
      });
    }
  }
  return edges;
}
