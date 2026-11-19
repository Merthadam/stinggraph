/**
 * Service-layer spike, part 2: does scoping `codegraph_explore` by a named
 * service make it pick the right code? Deterministic probes only (no agent).
 *
 *   npm run build
 *   npx tsx --tsconfig scripts/layers-eval/tsconfig.json scripts/layers-eval/probe.ts --repo <indexed repo with .stinggraph/layers.yaml> [--out <dir>]
 *
 * Arms, all through the real ToolHandler (the path MCP uses):
 *   A      the agent query as-is (today's behaviour)
 *   B      SIMULATED scoping from layers.yaml: label/alias phrases are removed
 *          from the query, and each remaining token that names >1 definition
 *          repo-wide is rewritten to the qualified form(s) of its in-scope
 *          definition(s). Nothing in src/ changes — see `simulationLimits`.
 *   B-inf  the same with inferred layers only (folder / compose names as aliases)
 * Controls must come out of B / B-inf byte-identical to A (asserted).
 * Part 4 prints what a service-only query's entry-point summary would hold,
 * from a roll-up query over edges grouped by each endpoint file's service.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildLayerMaps, openIndex, type Assignment } from './layers';
import { PROMPTS, type KeySymbol } from './prompts';

/* eslint-disable @typescript-eslint/no-var-requires */
const dist = path.resolve(__dirname, '../../dist');
const { default: CodeGraph } = require(dist);
const { ToolHandler } = require(path.join(dist, 'mcp/tools'));

type Db = ReturnType<typeof openIndex>;

/** Generic words never scope on their own (design doc, confidence gate). */
const GENERIC = new Set(['api', 'core', 'app', 'service', 'services']);
const isTestFile = (f: string) => /(^|\/)tests?\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/.test(f);
const words = (s: string) => s.toLowerCase().split(/[\s\-_]+/).filter(Boolean);

export const simulationLimits = [
  'Only tokens that exactly equal a symbol name are narrowed; a real implementation would narrow every match explore makes (FTS hits, name-segment matches, file admission, blast radius), so B under-states scoping on fuzzy words and cannot drop off-target files that FTS admits.',
  'Narrowing is expressed as a query rewrite to qualified names (`Class.method`, or `stem.fn` for module-level functions). explore resolves `Class.method` reliably; `stem.fn` relies on the file stem also being a token, so module-level duplicates are only approximately disambiguated.',
  'A token with no in-scope definition is left as-is (silent beats wrong); a real implementation could instead fall back to the whole repo the same way.',
  'Test files are excluded from the in-scope rewrite targets (they live inside a service folder but are not what a service-named question is about).',
];

interface ScopeUnit { service: string; module: string | null; phrase: string[]; label: string }

function scopeUnits(services: Array<{ id: string; label: string; aliases: string[]; modules: Array<{ id: string; label: string; aliases: string[] }> }>): ScopeUnit[] {
  const units: ScopeUnit[] = [];
  for (const s of services) {
    for (const p of new Set([s.label, ...s.aliases])) units.push({ service: s.id, module: null, phrase: words(p), label: p });
    for (const m of s.modules) for (const p of new Set([m.label, ...m.aliases])) units.push({ service: s.id, module: m.id, phrase: words(p), label: p });
  }
  return units.filter((u) => u.phrase.length && !u.phrase.every((w) => GENERIC.has(w)));
}

/** Longest exact label/alias match at each position; a match must cover whole whitespace tokens. */
export function matchScopes(query: string, units: ScopeUnit[]) {
  const tokens = query.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const matched: Array<{ text: string; unit: ScopeUnit }> = [];
  for (let i = 0; i < tokens.length;) {
    let best: { unit: ScopeUnit; end: number } | null = null;
    for (const unit of units) {
      const acc: string[] = [];
      for (let j = i; j < tokens.length && acc.length < unit.phrase.length; j++) {
        acc.push(...words(tokens[j]!));
        if (acc.length === unit.phrase.length && acc.every((w, n) => w === unit.phrase[n])
          && (!best || unit.phrase.length > best.unit.phrase.length)) best = { unit, end: j + 1 };
      }
    }
    if (best) { matched.push({ text: tokens.slice(i, best.end).join(' '), unit: best.unit }); i = best.end; }
    else kept.push(tokens[i++]!);
  }
  return { kept, matched };
}

interface Def { qualified: string; name: string; file: string; kind: string }
function definitions(db: Db, name: string): Def[] {
  return db.prepare(`SELECT qualified_name AS qualified, name, file_path AS file, kind FROM nodes
    WHERE name = ? AND kind NOT IN ('import', 'file', 'parameter')`).all(name);
}

function scopedQuery(db: Db, query: string, units: ScopeUnit[], byFile: Map<string, Assignment>) {
  const { kept, matched } = matchScopes(query, units);
  if (!matched.length) return { query, matched: [], rewrites: [], scope: [] as string[] };
  const inScope = (f: string) => {
    const a = byFile.get(f);
    return !!a?.service && matched.some(({ unit }) => unit.service === a.service && (!unit.module || unit.module === a.module));
  };
  const rewrites: Array<{ token: string; repoDefs: number; inScopeDefs: number; replacement: string; how: string }> = [];
  const out = kept.flatMap((token) => {
    if (/[./:]/.test(token) || rewrites.some((r) => r.token === token)) return (rewrites.find((r) => r.token === token)?.replacement ?? token).split(' ');
    const defs = definitions(db, token);
    const scoped = defs.filter((d) => inScope(d.file) && !isTestFile(d.file));
    if (defs.length < 2 || !scoped.length || scoped.length === defs.length) {
      if (defs.length >= 2) rewrites.push({ token, repoDefs: defs.length, inScopeDefs: scoped.length, replacement: token, how: scoped.length ? 'all defs in scope' : 'no in-scope def: kept' });
      return [token];
    }
    const forms = [...new Set(scoped.map((d) => d.qualified.includes('::')
      ? d.qualified.replace(/::/g, '.')
      : `${path.basename(d.file).replace(/\.[^.]+$/, '')}.${d.name}`))];
    rewrites.push({ token, repoDefs: defs.length, inScopeDefs: scoped.length, replacement: forms.join(' '), how: scoped.some((d) => !d.qualified.includes('::')) ? 'file-stem qualified' : 'class/function qualified' });
    return forms;
  });
  // A repeated token is rewritten once; the same qualified forms twice add nothing.
  return { query: [...new Set(out)].join(' '), matched: matched.map((m) => ({ text: m.text, service: m.unit.service, module: m.unit.module })), rewrites, scope: [...new Set(matched.map((m) => m.unit.service))] };
}

// ---------------------------------------------------------------------------
// Reading explore's output
// ---------------------------------------------------------------------------
interface Parsed { flow: Array<{ name: string; file: string; line: number }>; sections: Map<string, { lines: Set<number>; chars: number }> }
function parseExplore(text: string): Parsed {
  const flow: Parsed['flow'] = [];
  const sections: Parsed['sections'] = new Map();
  let inFlow = false;
  let cur: { lines: Set<number>; chars: number } | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('**Flow (')) { inFlow = true; continue; }
    if (inFlow) {
      const m = /^\d+\. (.+) \((.+):(\d+)\)$/.exec(line);
      if (m) flow.push({ name: m[1]!, file: m[2]!, line: Number(m[3]) });
      else if (!line.startsWith('   ↓') && line.trim()) inFlow = false;
      continue;
    }
    const h = /^\*\*`([^`]+)`\*\*/.exec(line);
    if (h) { cur = { lines: new Set(), chars: 0 }; sections.set(h[1]!, cur); continue; }
    if (cur) {
      cur.chars += line.length + 1;
      const n = /^(\d+)\t/.exec(line);
      if (n) cur.lines.add(Number(n[1]));
    }
  }
  return { flow, sections };
}

function scoreKey(db: Db, key: KeySymbol[], parsed: Parsed) {
  return key.map((ks) => {
    const node = db.prepare('SELECT name, start_line AS start, end_line AS end FROM nodes WHERE qualified_name = ? AND file_path = ? AND kind NOT IN (\'import\', \'file\')').get(ks.qualifiedName, ks.file);
    assert.ok(node, `answer key symbol missing from index: ${ks.qualifiedName} in ${ks.file}`);
    const sec = parsed.sections.get(ks.file);
    const inSource = !!sec && [...Array(Math.min(node.end, node.start + 3) - node.start + 1).keys()].some((d) => sec.lines.has(node.start + d));
    const inFlow = parsed.flow.some((s) => s.file === ks.file && s.line === node.start);
    return { ...ks, inSource, inFlow };
  });
}

function offTarget(parsed: Parsed, expected: Set<string>, byFile: Map<string, Assignment>) {
  const files = [...parsed.sections].filter(([f]) => { const s = byFile.get(f)?.service; return s && !expected.has(s); });
  return { files: files.map(([f]) => f), chars: files.reduce((n, [, s]) => n + s.chars, 0) };
}

// ---------------------------------------------------------------------------
async function main() {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const repo = path.resolve(arg('--repo') ?? '.');
  const out = path.resolve(arg('--out') ?? '/tmp/layers-eval-results');
  fs.mkdirSync(out, { recursive: true });

  const maps = buildLayerMaps(repo);
  assert.ok(maps.declared && maps.declaredServices, 'probe needs .stinggraph/layers.yaml in the repo');
  const declaredBy = maps.declared.byFile;
  const inferredBy = maps.inferred.byFile;
  const declaredUnits = scopeUnits(maps.declaredServices);
  // Inferred names are folder / compose names; "<name> service" is the phrase people add.
  const inferredUnits = scopeUnits(maps.inferred.services.map((s) => ({ id: s.id, label: s.id, aliases: [`${s.id} service`], modules: s.modules.map((m) => ({ id: m.id, label: m.id, aliases: [] })) })));
  // Inferred ids map onto declared ids for scoring (agreement report: mcps → connector, frontend → portal).
  const toDeclared = new Map<string, string>([['mcps', 'connector'], ['frontend', 'portal']]);
  const inferredAsDeclared = new Map([...inferredBy].map(([f, a]) => [f, { ...a, service: a.service ? toDeclared.get(a.service) ?? a.service : null }]));

  const db = openIndex(repo);
  const cg = CodeGraph.openSync(repo);
  const explore = async (query: string): Promise<string> => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
    return res.content?.[0]?.text ?? '';
  };

  const determinism = (await explore(PROMPTS[0]!.query)) === (await explore(PROMPTS[0]!.query));

  const results = [];
  for (const p of PROMPTS) {
    const expected = new Set([...p.names, ...p.key.map((ks) => declaredBy.get(ks.file)?.service).filter((s): s is string => !!s)]);
    const B = scopedQuery(db, p.query, declaredUnits, declaredBy);
    const Binf = scopedQuery(db, p.query, inferredUnits, inferredBy);
    const arms: Record<string, { query: string; text: string }> = { A: { query: p.query, text: await explore(p.query) } };
    arms.B = { query: B.query, text: B.query === p.query ? arms.A!.text : await explore(B.query) };
    arms['B-inf'] = { query: Binf.query, text: Binf.query === p.query ? arms.A!.text : await explore(Binf.query) };
    if (!p.names.length) {
      assert.strictEqual(B.query, p.query, `${p.id}: control query changed by declared scoping`);
      assert.strictEqual(Binf.query, p.query, `${p.id}: control query changed by inferred scoping`);
      assert.strictEqual(await explore(B.query), arms.A!.text, `${p.id}: control output differs`);
    }
    const scored = Object.fromEntries(Object.entries(arms).map(([arm, { query, text }]) => {
      const parsed = parseExplore(text);
      const key = scoreKey(db, p.key, parsed);
      return [arm, {
        query, chars: text.length, files: parsed.sections.size, flowSteps: parsed.flow.length,
        keyInOutput: key.filter((x) => x.inSource || x.inFlow).length, keyInFlow: key.filter((x) => x.inFlow).length,
        keyMissing: key.filter((x) => !x.inSource && !x.inFlow).map((x) => x.qualifiedName),
        offTarget: offTarget(parsed, expected, arm === 'B-inf' ? inferredAsDeclared : declaredBy),
      }];
    }));
    results.push({ id: p.id, prompt: p.prompt, names: p.names, keySize: p.key.length, expectedServices: [...expected], matched: { B: B.matched, 'B-inf': Binf.matched }, rewrites: { B: B.rewrites, 'B-inf': Binf.rewrites }, arms: scored });
    fs.writeFileSync(path.join(out, `explore-${p.id}.txt`), Object.entries(arms).map(([a, { query, text }]) => `===== ${a}: ${query}\n${text}`).join('\n\n'));
  }

  // Per-token ambiguity over every named prompt's symbol-like tokens.
  const ambiguity = PROMPTS.filter((p) => p.names.length).flatMap((p) => [...new Set(matchScopes(p.query, declaredUnits).kept)].map((t) => {
    const defs = definitions(db, t);
    const scoped = defs.filter((d) => p.names.includes(declaredBy.get(d.file)?.service ?? ''));
    return { prompt: p.id, token: t, repoDefs: defs.length, repoDefsNonTest: defs.filter((d) => !isTestFile(d.file)).length, inScopeDefs: scoped.length, inScopeNonTest: scoped.filter((d) => !isTestFile(d.file)).length };
  }).filter((r) => r.repoDefs > 0));

  // Alias phrases that are also symbol names would be eaten from symbol queries.
  const aliasCollisions = [...declaredUnits, ...inferredUnits].filter((u) => u.phrase.length === 1)
    .map((u) => ({ alias: u.label, defs: definitions(db, u.label).length + definitions(db, u.phrase[0]!).length }))
    .filter((c) => c.defs > 0);

  // Part 4: service-only query — entry points + roll-up edge counts by endpoint service.
  const svcMap = JSON.stringify(Object.fromEntries([...declaredBy].filter(([, a]) => a.service).map(([f, a]) => [f, a.service])));
  const t0 = process.hrtime.bigint();
  const rollup: Array<{ src: string; dst: string; kind: string; n: number; synth: number }> = db.prepare(`
    WITH m(path, svc) AS (SELECT key, value FROM json_each(?))
    SELECT COALESCE(ms.svc, '(unassigned)') AS src, COALESCE(mt.svc, '(unassigned)') AS dst, e.kind AS kind,
           COUNT(*) AS n, SUM(CASE WHEN e.metadata LIKE '%synthesizedBy%' THEN 1 ELSE 0 END) AS synth
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    LEFT JOIN m ms ON ms.path = s.file_path LEFT JOIN m mt ON mt.path = t.file_path
    WHERE e.kind IN ('calls', 'references', 'imports', 'instantiates', 'extends', 'implements')
      AND COALESCE(ms.svc, '(unassigned)') <> COALESCE(mt.svc, '(unassigned)')
    GROUP BY 1, 2, 3 ORDER BY n DESC`).all(svcMap);
  const rollupMs = Number(process.hrtime.bigint() - t0) / 1e6;
  // Side check: name-based `instance-method` call edges that cross a declared service boundary.
  const crossInstance: Array<{ from: string; ref: string; to: string; toFile: string; n: number }> = db.prepare(`
    SELECT s.file_path AS "from", json_extract(e.metadata, '$.refName') AS ref, t.qualified_name AS "to", t.file_path AS toFile, COUNT(*) AS n
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND json_extract(e.metadata, '$.resolvedBy') = 'instance-method'
    GROUP BY 1, 2, 3, 4 ORDER BY n DESC`).all().filter((r) => {
    const a = declaredBy.get(r.from)?.service; const b = declaredBy.get(r.toFile)?.service;
    return a && b && a !== b && !isTestFile(r.from);
  });
  const serviceOnly = [];
  for (const [phrase, id] of [['agent service', 'agent'], ['connector service', 'connector']] as const) {
    const files = [...declaredBy].filter(([, a]) => a.service === id).map(([f]) => f);
    const inSvc = (f: string) => declaredBy.get(f)?.service === id;
    const routes = db.prepare(`SELECT name, file_path AS file FROM nodes WHERE kind = 'route'`).all().filter((r) => inSvc(r.file));
    const compose = maps.inferred.composeNotes.filter((c) => c.entry && inSvc(c.entry)).map((c) => `${c.name} → ${c.entry}`);
    // MCP tool handlers: functions whose decorator line is `@<server>.tool(...)`.
    const tools: string[] = [];
    for (const f of files.filter((x) => x.endsWith('.py') && !isTestFile(x))) {
      const src = fs.readFileSync(path.join(repo, f), 'utf8').split('\n');
      src.forEach((l, i) => { if (/^@\w+\.tool\(/.test(l)) { const fn = /def (\w+)/.exec(src.slice(i + 1, i + 4).join('\n')); if (fn) tools.push(`${fn[1]} (${f})`); } });
    }
    const sum = (rows: typeof rollup) => Object.entries(rows.reduce<Record<string, Record<string, number>>>((acc, r) => {
      const other = r.src === id ? r.dst : r.src;
      (acc[other] ??= {})[r.kind] = ((acc[other] ??= {})[r.kind] ?? 0) + r.n;
      return acc;
    }, {})).map(([svc, kinds]) => ({ service: svc, total: Object.values(kinds).reduce((a, b) => a + b, 0), kinds }));
    const baseline = await explore(phrase);
    serviceOnly.push({
      phrase, service: id, files: files.length, routes: routes.map((r) => r.name), compose, mcpTools: tools,
      outbound: sum(rollup.filter((r) => r.src === id)), inbound: sum(rollup.filter((r) => r.dst === id)),
      synthesizedCrossService: rollup.filter((r) => r.src === id || r.dst === id).reduce((n, r) => n + r.synth, 0),
      baselineExplore: { chars: baseline.length, files: parseExplore(baseline).sections.size, filesInService: [...parseExplore(baseline).sections.keys()].filter(inSvc).length },
    });
  }

  db.close();
  cg.close?.();
  const report = { repo, determinism, simulationLimits, results, ambiguity, aliasCollisions, rollupMs, serviceOnly, crossInstance };
  fs.writeFileSync(path.join(out, 'probe.json'), JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(out, 'probe.md'), md);
  console.log(md);
}

function renderMarkdown(r: any): string {
  const lines = [`# Service-scoping probe (${r.repo})`, '', `explore deterministic across two runs: ${r.determinism}`, '',
    '| prompt | arm | key in output | key in Flow | flow steps | files | off-target files (chars) | chars | query |',
    '|---|---|---|---|---|---|---|---|---|'];
  for (const p of r.results) for (const [arm, a] of Object.entries<any>(p.arms)) {
    lines.push(`| ${p.id} | ${arm} | ${a.keyInOutput}/${p.keySize} | ${a.keyInFlow}/${p.keySize} | ${a.flowSteps} | ${a.files} | ${a.offTarget.files.length} (${a.offTarget.chars}) | ${a.chars} | \`${a.query}\` |`);
  }
  lines.push('', '## Missing key symbols', '');
  for (const p of r.results) lines.push(`- ${p.id}: ${Object.entries<any>(p.arms).map(([arm, a]) => `${arm} [${a.keyMissing.join(', ')}]`).join(' · ')}`);
  lines.push('', '## Scope matches and rewrites (B = layers.yaml, B-inf = inferred)', '');
  for (const p of r.results.filter((x: any) => x.names.length)) {
    for (const arm of ['B', 'B-inf']) lines.push(`- ${p.id} ${arm}: matched ${JSON.stringify(p.matched[arm].map((m: any) => `${m.text}→${m.service}${m.module ? '/' + m.module : ''}`))}; rewrites ${p.rewrites[arm].map((w: any) => `${w.token} (${w.inScopeDefs}/${w.repoDefs} → ${w.replacement}; ${w.how})`).join(', ') || 'none'}`);
  }
  lines.push('', '## Token ambiguity (definitions repo-wide vs in the named services)', '', '| prompt | token | repo | repo non-test | in scope | in scope non-test |', '|---|---|---|---|---|---|',
    ...r.ambiguity.map((a: any) => `| ${a.prompt} | ${a.token} | ${a.repoDefs} | ${a.repoDefsNonTest} | ${a.inScopeDefs} | ${a.inScopeNonTest} |`));
  lines.push('', `Single-word aliases that are also symbol names: ${r.aliasCollisions.length ? JSON.stringify(r.aliasCollisions) : 'none'}`);
  lines.push('', `## Service-only queries (roll-up query ${r.rollupMs.toFixed(1)} ms)`, '');
  for (const s of r.serviceOnly) {
    lines.push(`### "${s.phrase}" → ${s.service} (${s.files} files)`, '',
      `- routes (${s.routes.length}): ${s.routes.join(', ') || 'none'}`,
      `- compose command target: ${s.compose.join('; ') || 'none'}`,
      `- MCP tools (${s.mcpTools.length}): ${s.mcpTools.join(', ') || 'none'}`,
      `- outbound: ${s.outbound.map((o: any) => `${o.service} ${o.total} ${JSON.stringify(o.kinds)}`).join('; ') || 'none'}`,
      `- inbound: ${s.inbound.map((o: any) => `${o.service} ${o.total} ${JSON.stringify(o.kinds)}`).join('; ') || 'none'}`,
      `- synthesized cross-service edges: ${s.synthesizedCrossService}`,
      `- today's explore("${s.phrase}"): ${s.baselineExplore.chars} chars, ${s.baselineExplore.files} files, ${s.baselineExplore.filesInService} in the service`, '');
  }
  lines.push(`## Cross-service \`instance-method\` call edges (non-test source): ${r.crossInstance.reduce((n: number, x: any) => n + x.n, 0)}`, '',
    ...r.crossInstance.map((x: any) => `- ${x.from}: \`${x.ref}\` → ${x.to} (${x.toFile}) ×${x.n}`), '');
  lines.push('## Simulation limits', '', ...r.simulationLimits.map((l: string) => `- ${l}`));
  return lines.join('\n') + '\n';
}

main().catch((e) => { console.error(e); process.exit(1); });

