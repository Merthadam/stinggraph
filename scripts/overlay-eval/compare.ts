/**
 * Phase 0 step 4 (docs/stingray-overlay-handoff.md): a base index at commit B
 * plus a worktree overlay for commit H, compared against a full index of H.
 *
 *   npm run build
 *   npx tsx --tsconfig scripts/overlay-eval/tsconfig.json scripts/overlay-eval/compare.ts --repo <git repo> --base <B> --head <H> [--out result.json] [--work <dir>] [--keep] [--synthesis off]
 *
 * Runs against dist/, so build first. Never touches the source repo's working
 * tree: B and H are checked out as detached temp worktrees, removed afterwards
 * unless --keep.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const dist = path.resolve(__dirname, '../../dist');
const { default: CodeGraph, getDatabasePath } = require(dist);
const { createDatabase } = require(path.join(dist, 'db/sqlite-adapter'));
const { isSourceFile } = require(path.join(dist, 'extraction/grammars'));
const { createOverlay, detectOverlayFrameworks, extractFile, setBaseInfo, setGitBlobIds } = require(path.join(dist, 'overlay'));
import type { Overlay, OverlayFile, MergedEdge, OverlayUpdateStats } from '../../src/overlay';

export const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });

const seconds = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e9;

export function lsTree(repo: string, commit: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const line of git(repo, 'ls-tree', '-r', commit).split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m) blobs.set(m[2], m[1]);
  }
  return blobs;
}

export function dbBytes(dbPath: string): number {
  return ['', '-wal'].reduce((sum, s) => sum + (fs.existsSync(dbPath + s) ? fs.statSync(dbPath + s).size : 0), 0);
}

/** Full index of `commit` in a detached worktree (checked out here unless it already is); returns its DB path and timing. */
export async function fullIndex(repo: string, commit: string, dir: string): Promise<{ root: string; dbPath: string; seconds: number }> {
  if (!fs.existsSync(dir)) git(repo, 'worktree', 'add', '--detach', '--quiet', dir, commit);
  const start = process.hrtime.bigint();
  const cg = await CodeGraph.init(dir);
  await cg.indexAll();
  cg.close();
  return { root: dir, dbPath: getDatabasePath(dir), seconds: seconds(start) };
}

/** Full index of B, stamped as a git-backed base (blob ids + base_commit). */
export async function buildBase(repo: string, base: string, dir: string) {
  const index = await fullIndex(repo, base, dir);
  const { db } = createDatabase(index.dbPath);
  setBaseInfo(db, { baseCommit: git(repo, 'rev-parse', base).trim(), baseRef: base });
  setGitBlobIds(db, lsTree(repo, base));
  db.close();
  return index;
}

/**
 * Overlay for `head` over the base DB. File contents come from git; the
 * resolver reads module config (tsconfig, package.json, ...) and some source
 * lines from `projectRoot`, the worktree checked out at `head`.
 */
export async function buildOverlay(repo: string, baseDb: string, baseCommit: string, head: string, overlayPath: string, worktreeId: string, projectRoot: string,
  synthesis: 'auto' | 'off' = 'auto') {
  const start = process.hrtime.bigint();
  const headSha = git(repo, 'rev-parse', head).trim();
  const mergeBase = git(repo, 'merge-base', baseCommit, headSha).trim();
  const baseBlobs = lsTree(repo, mergeBase);
  const headBlobs = lsTree(repo, headSha);
  const overlay: Overlay = createOverlay(overlayPath, baseDb, { worktreeId, branch: head, baseCommit: mergeBase, headCommit: mergeBase });
  const changes: OverlayFile[] = [];
  for (const line of git(repo, 'diff', '--name-status', '-M', `${mergeBase}..${headSha}`).split('\n').filter(Boolean)) {
    const [code, a, b] = line.split('\t');
    if (code[0] === 'D') changes.push({ path: a, status: 'deleted', baseBlobId: baseBlobs.get(a) });
    else if (code[0] === 'R') changes.push({ path: b, status: 'renamed', oldPath: a, blobId: headBlobs.get(b), baseBlobId: baseBlobs.get(a) });
    else if (code[0] === 'C' || code[0] === 'A') changes.push({ path: b ?? a, status: 'added', blobId: headBlobs.get(b ?? a) });
    else changes.push({ path: a, status: 'modified', blobId: headBlobs.get(a), baseBlobId: baseBlobs.get(a) }); // M, T
  }
  let extractSeconds = 0;
  let extracted = 0;
  const td = process.hrtime.bigint();
  // The frameworks a full index of the head checkout would extract each file with.
  const frameworksFor: (file: string) => string[] = detectOverlayFrameworks(projectRoot);
  const detectSeconds = seconds(td);
  const entries = [];
  for (const file of changes) {
    let extraction = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
    if (file.status !== 'deleted' && isSourceFile(file.path)) {
      const t = process.hrtime.bigint();
      extraction = await extractFile(file.path, git(repo, 'show', `${headSha}:${file.path}`), undefined, frameworksFor(file.path));
      extractSeconds += seconds(t);
      extracted++;
    }
    entries.push({ file, extraction });
  }
  const t = process.hrtime.bigint();
  const stats: OverlayUpdateStats = await overlay.upsertFiles(entries, projectRoot, { synthesis });
  const upsertSeconds = seconds(t);
  overlay.setHeadCommit(headSha);
  const total = seconds(start);
  return { overlay, mergeBase, headSha, changes, extracted, seconds: total, extractSeconds, upsertSeconds, detectSeconds, stats };
}

type EdgeInfo = { layer?: string; sourceFile: string; targetFile: string; provenance: string; synthesizedBy?: string; overlayBaseRef?: boolean; overlayRebound?: boolean; flag?: string };

const tally = (items: Iterable<string>) => {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

/** Why a reference edge is absent from the merged view (or a merged edge absent from the reference). */
function cause(key: string, info: EdgeInfo, changed: Set<string>, side: 'missing' | 'extra', other: Set<string>): string {
  const srcChanged = changed.has(info.sourceFile);
  const tgtChanged = changed.has(info.targetFile);
  const [s, t] = key.split('\t');
  if (side === 'extra' && info.flag === 'dangling') return `dangling ${info.layer} edge (target symbol gone from changed file)`;
  if (other.has(`${s}\t${t}`)) return 'same endpoints, other kind present (calls vs instantiates, or a skipped import edge beside a call)';
  if (info.synthesizedBy) return `synthesized (${info.synthesizedBy})${side === 'extra' ? `, drawn by the ${info.layer} layer` : ''}`;
  if (side === 'extra' && info.overlayRebound) return 'base edge re-resolved by the overlay (overlayRebound), not in reference';
  if (s.includes('#route#') || t.includes('#route#')) return 'framework route node (not extracted in overlays)';
  if (srcChanged) return side === 'missing' ? 'changed-file ref the overlay resolver did not bind to this target' : 'changed-file edge not in reference';
  if (tgtChanged) {
    if (side === 'extra' && info.overlayBaseRef) return 'base ref rebound to an overlay symbol, not in reference';
    return side === 'missing' ? 'unchanged base file -> changed file: base never resolved this target' : 'stale base edge into changed file (possibly_stale)';
  }
  return side === 'missing' ? 'unchanged -> unchanged: needs whole-graph/resolution rerun'
    : 'unchanged -> unchanged: base edge the H index no longer draws (no definition-delta rebind selected it)';
}

export async function compare(repo: string, base: string, head: string, work: string, synthesis: 'auto' | 'off' = 'auto') {
  fs.mkdirSync(work, { recursive: true });
  const baseIdx = await buildBase(repo, base, path.join(work, 'base'));
  // The reference worktree doubles as the overlay's checkout at H; it is indexed only after the overlay is built.
  const refDir = path.join(work, 'reference');
  git(repo, 'worktree', 'add', '--detach', '--quiet', refDir, head);
  const ov = await buildOverlay(repo, baseIdx.dbPath, git(repo, 'rev-parse', base).trim(), head, path.join(work, 'overlay', 'overlay.db'), 'eval', refDir, synthesis);
  const ref = await fullIndex(repo, head, refDir);
  const changed = new Set(ov.changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])));

  // ---- merged view
  const db = ov.overlay.db;
  const keyOf = new Map<string, { key: string; file: string }>();
  for (const r of db.prepare('SELECT id, stable_key, file_path FROM base.nodes').all()) keyOf.set(r.id, { key: r.stable_key, file: r.file_path });
  const mergedNodes = ov.overlay.getNodes();
  for (const n of mergedNodes) keyOf.set(n.id, { key: n.stableKey, file: n.filePath });
  const mergedEdges: MergedEdge[] = ov.overlay.getEdges();
  const merged = new Map<string, EdgeInfo>();
  for (const e of mergedEdges) {
    const s = keyOf.get(e.source)!;
    const t = keyOf.get(e.target) ?? { key: `<unknown ${e.target}>`, file: '' };
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    merged.set(`${s.key}\t${e.dangling ? 'DANGLING:' : ''}${t.key}\t${e.kind}`, {
      layer: e.layer, sourceFile: s.file, targetFile: t.file, provenance: e.provenance ?? 'null',
      synthesizedBy: meta.synthesizedBy as string | undefined, overlayBaseRef: meta.overlayBaseRef === true, overlayRebound: meta.overlayRebound === true,
      flag: e.dangling ? 'dangling' : e.possibly_stale ? 'possibly_stale' : undefined,
    });
  }
  const overlayRows = Object.fromEntries(['overlay_files', 'nodes', 'edges', 'unresolved_refs'].map((t) =>
    [t, db.prepare(`SELECT COUNT(*) AS n FROM main.${t}`).get().n]));
  const overlayDbPath = path.join(work, 'overlay', 'overlay.db');
  ov.overlay.close();

  // ---- reference
  const { db: refDb } = createDatabase(ref.dbPath, { readOnly: true });
  const refNodes = refDb.prepare('SELECT stable_key, kind, file_path FROM nodes').all();
  const reference = new Map<string, EdgeInfo>();
  for (const r of refDb.prepare(`SELECT s.stable_key AS s, t.stable_key AS t, s.file_path AS sf, t.file_path AS tf, e.kind, e.provenance, e.metadata
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`).all()) {
    const meta = r.metadata ? JSON.parse(r.metadata) : {};
    reference.set(`${r.s}\t${r.t}\t${r.kind}`, { sourceFile: r.sf, targetFile: r.tf, provenance: r.provenance ?? 'null', synthesizedBy: meta.synthesizedBy });
  }
  const refEdgeRows = refDb.prepare('SELECT COUNT(*) AS n FROM edges').get().n;
  refDb.close();

  // ---- diff
  const mergedKeys = new Map(mergedNodes.map((n) => [n.stableKey, n.kind]));
  const refKeys = new Map(refNodes.map((n: { stable_key: string; kind: string }) => [n.stable_key, n.kind]));
  const missingNodes = [...refKeys].filter(([k]) => !mergedKeys.has(k));
  const extraNodes = [...mergedKeys].filter(([k]) => !refKeys.has(k));
  const missingEdges = [...reference].filter(([k]) => !merged.has(k));
  const extraEdges = [...merged].filter(([k]) => !reference.has(k));
  const edgeSummary = (edges: Array<[string, EdgeInfo]>, side: 'missing' | 'extra') => {
    const causes = new Map<string, string[]>();
    const otherPairs = new Set([...(side === 'missing' ? merged : reference).keys()].map((k) => k.split('\t').slice(0, 2).join('\t')));
    for (const [k, info] of edges) {
      const c = cause(k, info, changed, side, otherPairs);
      causes.set(c, [...(causes.get(c) ?? []), k]);
    }
    return {
      count: edges.length,
      byKind: tally(edges.map(([k]) => k.split('\t')[2])),
      byProvenance: tally(edges.map(([, i]) => i.provenance)),
      byCause: Object.fromEntries([...causes].sort((a, b) => b[1].length - a[1].length)
        .map(([c, ks]) => [c, { count: ks.length, examples: ks.slice(0, 4).map((k) => k.replace(/\t/g, '  ->  ')) }])),
    };
  };

  return {
    repo, base, head, mergeBase: ov.mergeBase, headSha: ov.headSha,
    changes: { total: ov.changes.length, extracted: ov.extracted, byStatus: tally(ov.changes.map((c) => c.status)) },
    seconds: { baseIndex: baseIdx.seconds, overlayUpdate: ov.seconds, overlayExtract: ov.extractSeconds, overlayUpsert: ov.upsertSeconds,
      frameworkDetect: ov.detectSeconds, referenceIndex: ref.seconds },
    updateStats: ov.stats,
    bytes: { baseDb: dbBytes(baseIdx.dbPath), overlayDb: dbBytes(overlayDbPath), referenceDb: dbBytes(ref.dbPath) },
    overlayRows,
    nodes: {
      merged: mergedKeys.size, reference: refKeys.size,
      missing: { count: missingNodes.length, byKind: tally(missingNodes.map(([, k]) => k)), examples: missingNodes.slice(0, 6).map(([k]) => k) },
      extra: { count: extraNodes.length, byKind: tally(extraNodes.map(([, k]) => k)), examples: extraNodes.slice(0, 6).map(([k]) => k) },
    },
    edges: {
      merged: merged.size, mergedRows: mergedEdges.length, reference: reference.size, referenceRows: refEdgeRows,
      mergedFlags: tally(mergedEdges.map((e) => (e.dangling ? 'dangling' : e.possibly_stale ? 'possibly_stale' : `ok:${e.layer}`))),
      // possibly_stale edges the reference also draws were remapped correctly.
      possiblyStaleConfirmed: [...merged].filter(([k, i]) => i.flag === 'possibly_stale' && reference.has(k)).length,
      possiblyStaleTotal: [...merged].filter(([, i]) => i.flag === 'possibly_stale').length,
      missing: edgeSummary(missingEdges, 'missing'),
      extra: edgeSummary(extraEdges, 'extra'),
    },
  };
}

export function summarize(r: Awaited<ReturnType<typeof compare>>): string {
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(2)}%` : '-');
  const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
  const lines = [
    `${r.repo}  ${r.base}..${r.head}  (merge-base ${r.mergeBase.slice(0, 8)})`,
    `changes: ${r.changes.total} (${JSON.stringify(r.changes.byStatus)}), extracted ${r.changes.extracted}`,
    `time: base ${r.seconds.baseIndex.toFixed(2)}s | overlay ${r.seconds.overlayUpdate.toFixed(2)}s (framework detect ${r.seconds.frameworkDetect.toFixed(2)}s, extract ${r.seconds.overlayExtract.toFixed(2)}s, upsert ${r.seconds.overlayUpsert.toFixed(2)}s) | reference full ${r.seconds.referenceIndex.toFixed(2)}s`,
    `update phases (ms): ${JSON.stringify(r.updateStats.timings)}`,
    `update: rebound ${JSON.stringify(r.updateStats.rebound)}, fallback ${r.updateStats.fallbackEdges}, synthesis ${JSON.stringify(r.updateStats.synthesis)}, skipped base renames ${r.updateStats.skippedBaseRenames}`,
    `size: base ${mb(r.bytes.baseDb)} | overlay ${mb(r.bytes.overlayDb)} | reference ${mb(r.bytes.referenceDb)}; overlay rows ${JSON.stringify(r.overlayRows)}`,
    `nodes: merged ${r.nodes.merged} vs reference ${r.nodes.reference}; missing ${r.nodes.missing.count} (${pct(r.nodes.missing.count, r.nodes.reference)}), extra ${r.nodes.extra.count}`,
    `edges: merged ${r.edges.merged} vs reference ${r.edges.reference}; missing ${r.edges.missing.count} (${pct(r.edges.missing.count, r.edges.reference)}), extra ${r.edges.extra.count} (${pct(r.edges.extra.count, r.edges.merged)})`,
    `merged edge flags: ${JSON.stringify(r.edges.mergedFlags)}; possibly_stale confirmed by reference ${r.edges.possiblyStaleConfirmed}/${r.edges.possiblyStaleTotal}`,
    `missing by kind ${JSON.stringify(r.edges.missing.byKind)} / provenance ${JSON.stringify(r.edges.missing.byProvenance)}`,
    `extra by kind ${JSON.stringify(r.edges.extra.byKind)} / provenance ${JSON.stringify(r.edges.extra.byProvenance)}`,
  ];
  for (const side of ['missing', 'extra'] as const) {
    lines.push(`${side} edge causes:`);
    for (const [c, v] of Object.entries(r.edges[side].byCause)) {
      lines.push(`  ${v.count}  ${c}`);
      for (const e of v.examples.slice(0, 2)) lines.push(`        e.g. ${e}`);
    }
  }
  return lines.join('\n');
}

export function cleanup(repo: string, work: string): void {
  for (const dir of ['base', 'reference', 'base-b', 'head-b']) {
    if (fs.existsSync(path.join(work, dir))) git(repo, 'worktree', 'remove', '--force', path.join(work, dir));
  }
  fs.rmSync(work, { recursive: true, force: true });
}

if (require.main === module) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const repo = arg('repo'), base = arg('base'), head = arg('head');
  if (!repo || !base || !head) {
    console.error('usage: compare.ts --repo <git repo> --base <B> --head <H> [--out file.json] [--work dir] [--keep] [--synthesis off]');
    process.exit(2);
  }
  const work = arg('work') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-eval-'));
  compare(path.resolve(repo), base, head, work, arg('synthesis') === 'off' ? 'off' : 'auto').then((result) => {
    if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(result, null, 2));
    console.log(summarize(result));
  }).finally(() => { if (!process.argv.includes('--keep')) cleanup(path.resolve(repo), work); })
    .catch((error) => { console.error(error); process.exit(1); });
}
