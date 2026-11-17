/**
 * Upstream resolution and synthesis over an overlay's merged view (Reco 1–3
 * in docs/stingray-overlay-phase0-findings.md).
 *
 * The overlay connection has the overlay as `main` and the base ATTACHed
 * read-only as `base`. SQLite resolves an unqualified table name temp → main →
 * attached, so for the length of one update TEMP VIEWs named `nodes`, `edges`
 * and `files` shadow main's tables: an unmodified QueryBuilder,
 * ReferenceResolver and the synthesis passes read base + overlay with the
 * hiding rule. Their only write to a shadowed table, `INSERT OR IGNORE INTO
 * edges`, is routed by an INSTEAD OF trigger: to `main.edges` while resolving,
 * to a TEMP staging table while synthesizing (as upstream's SynthesisStage
 * does). Any other write to a shadowed table fails loudly ("cannot modify a
 * view"), which is the point: none of the passes run here makes one.
 *
 * `unresolved_refs` is NOT shadowed while resolving: row ids collide between
 * the two files, and the resolver deletes/parks refs by row id. Base refs are
 * handed over in memory without a row id, so their cleanup matches nothing in
 * main. For selecting which base refs to retry, `unresolved_refs` is shadowed
 * by a base-only view, read-only, around upstream's own retry selectors.
 *
 * Everything sourced in a base node, every synthesized edge and every hidden
 * base edge is derived: dropped and rebuilt on each update, so the overlay is
 * a function of its files, whatever order they came in.
 *
 * Disk vs git: node, edge, file and ref rows come from the two databases.
 * The resolver and the synthesis passes read `projectRoot` from disk for
 * module configuration (tsconfig/jsconfig paths, package.json workspaces,
 * go.mod, Cargo, compile databases), framework detection, and source text.
 * Pass the worktree checked out at the overlay's head commit.
 */
import * as fs from 'fs';
import * as path from 'path';
import { QueryBuilder } from '../db/queries';
import { importPathKeys, moduleReferenceKeys } from '../db/reference-tail';
import { SYNTHESIZED_EDGE } from '../db/synthesis-stage';
import { createResolver, ReferenceResolver } from '../resolution';
import { hasSynthesisPattern, isJsxChildCandidate, synthesizeCallbackEdges } from '../resolution/callback-synthesizer';
import { aliasMayName } from '../resolution/const-alias-synthesizer';
import { resurrectRefFromDroppedEdge } from '../resolution/resurrect-ref';
import { rowToNode } from '../db/queries';
import type { Edge, EdgeKind, Language, UnresolvedReference } from '../types';
import type { SqliteDatabase } from '../db/sqlite-adapter';

export interface OverlayResolveScope {
  /** Paths this update wrote or removed (overlay ownership rows). */
  changedPaths: readonly string[];
  /** Of those, paths the merged view did not have before (added, rename targets). */
  addedPaths: readonly string[];
  projectRoot: string;
  /** 'auto' (default): run the synthesis passes when upstream sync's gate says they may move; 'off': never. */
  synthesis?: 'auto' | 'off';
}

/** What one update did, for callers that report or profile it. */
export interface OverlayUpdateStats {
  /** Milliseconds per phase. */
  timings: Record<string, number>;
  /**
   * Base edges re-resolved from their refs: those into hidden files, plus
   * (`byName`) those whose target name the overlay added or removed; how
   * many bound again.
   */
  rebound: { refs: number; byName: number; edges: number };
  /** Base edges into hidden files left to the stable-key remap (no ref stamp, or synthesis off). */
  fallbackEdges: number;
  synthesis: { ran: boolean; edges: number; persisted: number; hiddenBase: number };
  /** Framework postExtract renames of base nodes the overlay cannot apply (see findings §11). */
  skippedBaseRenames: number;
  /**
   * False when the base was indexed at another commit than the overlay's
   * merge-base (main moved): the checkout's unchanged files then differ from
   * the base's rows, which the resolver would read against each other. No
   * base ref is resolved (failed ones, or edges into hidden files) and the
   * synthesis passes do not run; base edges into hidden files keep the
   * stable-key fallback until the overlay is rebuilt on the new base.
   */
  baseInStep: boolean;
}

const SYNTH = (alias: string) => `COALESCE((${SYNTHESIZED_EDGE.replace(/metadata/g, `${alias}.metadata`)}), 0)`;

const columns = (db: SqliteDatabase, table: string): string[] =>
  db.prepare(`PRAGMA main.table_info(${table})`).all().map((row: { name: string }) => row.name);

function createMergedTables(db: SqliteDatabase): void {
  const nodeCols = columns(db, 'nodes').join(', ');
  const fileCols = columns(db, 'files');
  // Mapped per column so the shape is exactly upstream's whichever order a migrated base has.
  const overlayFile: Record<string, string> = {
    path: 'o.path', content_hash: "COALESCE(o.blob_id, '')", language: 'o.language', size: '0',
    modified_at: 'o.indexed_at', indexed_at: 'o.indexed_at', errors: 'o.errors', generated: '0', git_blob_id: 'o.blob_id',
    node_count: '(SELECT COUNT(*) FROM main.nodes n WHERE n.file_path = o.path)',
  };
  const unmapped = fileCols.filter((c) => !(c in overlayFile));
  if (unmapped.length) throw new Error(`Overlay files view has no mapping for: ${unmapped.join(', ')}`);
  // Snapshots, fixed for one update: `x IN table` probes their primary key
  // instead of re-materializing a subquery per statement execution.
  db.exec(`
    CREATE TEMP TABLE hidden_paths (path TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT INTO hidden_paths SELECT path FROM hidden_files WHERE path IS NOT NULL;
    CREATE TEMP TABLE hidden_base_nodes (id TEXT PRIMARY KEY) WITHOUT ROWID;
    INSERT INTO hidden_base_nodes SELECT n.id FROM base.nodes n JOIN hidden_paths h ON n.file_path = h.path;
    -- The base's synthesized edges, read once (a few hundred rows on this repo).
    CREATE TEMP TABLE base_synth AS
      SELECT id, source, target, kind, CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.registeredAt') END AS registered_at
      FROM base.edges WHERE ${SYNTHESIZED_EDGE};
    CREATE INDEX temp.base_synth_identity ON base_synth (source, target, kind);
    CREATE TEMP VIEW nodes AS
      SELECT ${nodeCols} FROM main.nodes
      UNION ALL
      SELECT ${nodeCols} FROM base.nodes WHERE file_path NOT IN temp.hidden_paths;
    CREATE TEMP VIEW files AS
      SELECT ${fileCols.join(', ')} FROM base.files WHERE path NOT IN temp.hidden_paths
      UNION ALL
      SELECT ${fileCols.map((c) => `${overlayFile[c]} AS ${c}`).join(', ')}
        FROM main.overlay_files o WHERE o.status != 'deleted' AND o.language IS NOT NULL;
  `);
  createEdgesView(db, 'resolve');
}

/** Visible base edges: source outside hidden files, and not replaced by this overlay. */
const VISIBLE_BASE_EDGE = 'source NOT IN temp.hidden_base_nodes AND id NOT IN main.overlay_hidden_base_edges';

/**
 * `resolve`: every visible edge, inserts go to main.edges. `synthesize`:
 * upstream SynthesisStage's shape over the merged graph — no synthesized edge
 * of either layer is visible, and inserts are staged in temp.synthesis_edges
 * unless a non-synthesized edge already says the same.
 */
function createEdgesView(db: SqliteDatabase, mode: 'resolve' | 'synthesize'): void {
  const cols = columns(db, 'edges').join(', ');
  db.exec('DROP VIEW IF EXISTS temp.edges');
  if (mode === 'resolve') {
    db.exec(`
      CREATE TEMP VIEW edges AS
        SELECT ${cols} FROM main.edges
        UNION ALL
        SELECT ${cols} FROM base.edges WHERE ${VISIBLE_BASE_EDGE};
      CREATE TEMP TRIGGER edges_insert INSTEAD OF INSERT ON temp.edges BEGIN
        INSERT OR IGNORE INTO main.edges (source, target, kind, metadata, line, col, provenance)
          VALUES (NEW.source, NEW.target, NEW.kind, NEW.metadata, NEW.line, NEW.col, NEW.provenance);
      END;`);
    return;
  }
  const same = (table: string) => `SELECT 1 FROM ${table} e WHERE e.source = NEW.source AND e.target = NEW.target AND e.kind = NEW.kind
    AND IFNULL(e.line, -1) = IFNULL(NEW.line, -1) AND IFNULL(e.col, -1) = IFNULL(NEW.col, -1) AND NOT ${SYNTH('e')}`;
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS synthesis_edges (
      id INTEGER PRIMARY KEY, source TEXT, target TEXT, kind TEXT, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS temp.synthesis_identity ON synthesis_edges (source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
    CREATE INDEX IF NOT EXISTS temp.synthesis_target ON synthesis_edges (target, kind);
    CREATE TEMP TABLE IF NOT EXISTS synthesis_inputs (file_path TEXT PRIMARY KEY);
    CREATE TEMP VIEW edges AS
      SELECT ${cols} FROM main.edges WHERE NOT ${SYNTH('main.edges')}
      UNION ALL
      SELECT ${cols} FROM base.edges WHERE ${VISIBLE_BASE_EDGE} AND NOT ${SYNTH('base.edges')}
      UNION ALL
      SELECT ${cols} FROM temp.synthesis_edges;
    CREATE TEMP TRIGGER edges_insert INSTEAD OF INSERT ON temp.edges BEGIN
      INSERT OR IGNORE INTO temp.synthesis_edges (source, target, kind, metadata, line, col, provenance)
        SELECT NEW.source, NEW.target, NEW.kind, NEW.metadata, NEW.line, NEW.col, NEW.provenance
        WHERE NOT EXISTS (${same('main.edges')})
          AND NOT EXISTS (${same('base.edges')} AND e.source NOT IN temp.hidden_base_nodes AND e.id NOT IN main.overlay_hidden_base_edges);
    END;`);
}

function dropMergedTables(db: SqliteDatabase): void {
  db.exec(`DROP VIEW IF EXISTS temp.nodes; DROP VIEW IF EXISTS temp.edges; DROP VIEW IF EXISTS temp.files;
    DROP VIEW IF EXISTS temp.unresolved_refs;
    DROP TABLE IF EXISTS temp.hidden_paths; DROP TABLE IF EXISTS temp.hidden_base_nodes; DROP TABLE IF EXISTS temp.base_synth;
    DROP TABLE IF EXISTS temp.synthesis_edges; DROP TABLE IF EXISTS temp.synthesis_inputs;`);
}

/**
 * Failed refs that the files in `keyPaths` could now satisfy: upstream sync's
 * #1240 retry selection (symbol names, module keys, imports of added files),
 * read from whatever `unresolved_refs` currently names.
 */
function selectRetryable(queries: QueryBuilder, resolver: ReferenceResolver, keyPaths: readonly string[], addedPaths: readonly string[],
  deltaNames: readonly string[]): UnresolvedReference[] {
  if (keyPaths.length === 0) return [];
  const paths = [...keyPaths];
  const retry = queries.getRetryableFailedReferences([...new Set([...queries.getNodeNamesByFiles(paths), ...paths.flatMap(moduleReferenceKeys), ...deltaNames])]);
  const added = new Set(addedPaths);
  const resolvesToAdded = (specifier: string, fromFile: string, language: Language) => {
    const file = resolver.resolveModuleFile(specifier, fromFile, language);
    return file !== null && added.has(file);
  };
  const resolvedModules = added.size === 0 ? [] : queries.getFailedScopedImports()
    .filter((s) => resolvesToAdded(s.name, s.filePath, s.language)).map((s) => s.name);
  const folderImports = added.size === 0 ? [] : queries.getFailedFolderImports()
    .filter((ref) => ref.filePath !== undefined && ref.language !== undefined && resolvesToAdded(ref.referenceName, ref.filePath, ref.language));
  const imports = queries.getRetryableFailedImports([...added].flatMap(importPathKeys),
    queries.getNodeNamesByFiles(paths, ['namespace', 'module']), undefined, resolvedModules, undefined, resolver.couldNameAnyOf([...added]));
  const seen = new Set(retry.map((ref) => ref.rowId));
  for (const ref of [...imports, ...folderImports]) if (!seen.has(ref.rowId)) { seen.add(ref.rowId); retry.push(ref); }
  // Row order, as a full index resolves them (first writer names a shared edge).
  return retry.sort((a, b) => (a.rowId ?? 0) - (b.rowId ?? 0));
}

type EdgeRow = { id: number; source: string; target: string; kind: string; metadata: string | null; line: number | null; col: number | null;
  source_file: string; source_language: Language };

const toRef = (row: EdgeRow): UnresolvedReference | null => resurrectRefFromDroppedEdge({
  source: row.source, target: row.target, kind: row.kind as EdgeKind, metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  line: row.line ?? undefined, column: row.col ?? undefined, sourceFilePath: row.source_file, sourceLanguage: row.source_language,
} as Edge & { sourceFilePath: string; sourceLanguage: Language });

/**
 * Upstream sync's definition delta (CG-33), for the whole overlay against the
 * base: names whose `file\0name` pair one side has and the other has not.
 */
function definitionDelta(db: SqliteDatabase): string[] {
  const pairs = (sql: string) => new Set((db.prepare(sql).all() as Array<{ file_path: string; name: string }>).map((r) => `${r.file_path}\0${r.name}`));
  const before = pairs('SELECT DISTINCT file_path, name FROM base.nodes WHERE file_path IN temp.hidden_paths');
  const after = pairs('SELECT DISTINCT file_path, name FROM main.nodes');
  const names = new Set<string>();
  for (const pair of before) if (!after.has(pair)) names.add(pair.slice(pair.indexOf('\0') + 1));
  for (const pair of after) if (!before.has(pair)) names.add(pair.slice(pair.indexOf('\0') + 1));
  return [...names];
}

/**
 * Framework postExtract (route prefixes composed across files) over the merged
 * graph, as a full index runs it before resolution. Only overlay rows can be
 * renamed here; a rename of a base row is counted and skipped. Frameworks keep
 * `id` and `qualifiedName` on these renames (that is their idempotency), so
 * stable keys do not move.
 */
function runPostExtract(db: SqliteDatabase, resolver: ReferenceResolver): number {
  const update = db.prepare('UPDATE main.nodes SET name = ?, signature = ?, updated_at = ? WHERE id = ? AND (name IS NOT ? OR signature IS NOT ?)');
  const isBase = db.prepare('SELECT name FROM base.nodes WHERE id = ? AND file_path NOT IN temp.hidden_paths');
  let skipped = 0;
  let renamed = 0;
  for (const fw of resolver['frameworks']) {
    if (!fw.postExtract) continue;
    let nodes;
    try { nodes = fw.postExtract(resolver['context']); } catch { continue; } // as upstream: a failing pass is skipped
    for (const node of nodes) {
      const sig = node.signature ?? null;
      if (update.run(node.name, sig, node.updatedAt ?? Date.now(), node.id, node.name, sig).changes > 0) { renamed++; continue; }
      const base = isBase.get(node.id) as { name: string } | undefined;
      if (base && base.name !== node.name) skipped++;
    }
  }
  if (renamed > 0) resolver.clearCaches();
  return skipped;
}

/**
 * Upstream sync's gate for the whole-graph synthesis, over everything this
 * overlay changes (not just this update's files, so the answer is a function
 * of the overlay): a synthesized base edge touches a hidden file or was wired
 * there, a hidden file was a synthesis input, an overlay file's text matches a
 * pass's input pattern, or an overlay defines a component or a name a const
 * alias may point at.
 */
function synthesisMayMove(db: SqliteDatabase, queries: QueryBuilder, projectRoot: string, overlayPaths: readonly string[]): boolean {
  if (db.prepare(`SELECT 1 FROM temp.base_synth WHERE source IN temp.hidden_base_nodes OR target IN temp.hidden_base_nodes
    OR EXISTS (SELECT 1 FROM temp.hidden_paths h WHERE registered_at >= h.path || ':' AND registered_at < h.path || ';') LIMIT 1`).get()) return true;
  if (db.prepare('SELECT 1 FROM base.synthesis_inputs WHERE file_path IN temp.hidden_paths LIMIT 1').get()) return true;
  for (const file of overlayPaths) {
    let content: string;
    try { content = fs.readFileSync(path.join(projectRoot, file), 'utf8'); } catch { return true; } // unreadable: assume it may
    if (hasSynthesisPattern(file, content)) return true;
  }
  const defined = (db.prepare('SELECT * FROM main.nodes').all() as Parameters<typeof rowToNode>[0][]).map(rowToNode);
  return defined.some(isJsxChildCandidate) || aliasMayName(queries, defined);
}

/**
 * The synthesis passes over the merged graph, staged in temp.synthesis_edges;
 * then the overlay keeps what differs from the base: staged edges the base
 * does not draw between visible nodes are persisted, and visible base
 * synthesized edges the merged graph no longer draws, or that point into a
 * hidden file, are hidden.
 */
async function synthesize(db: SqliteDatabase, projectRoot: string, stats: OverlayUpdateStats): Promise<void> {
  createEdgesView(db, 'synthesize');
  const queries = new QueryBuilder(db);
  // Like upstream refreshSynthesis: a fresh, uninitialized resolver for its context.
  const fresh = new ReferenceResolver(projectRoot, queries);
  stats.synthesis.edges = await synthesizeCallbackEdges(queries, fresh['context']);
  const staged = (e: string) => `SELECT 1 FROM temp.synthesis_edges s WHERE s.source = ${e}.source AND s.target = ${e}.target AND s.kind = ${e}.kind`;
  stats.synthesis.persisted = db.prepare(`INSERT OR IGNORE INTO main.edges (source, target, kind, metadata, line, col, provenance)
    SELECT s.source, s.target, s.kind, s.metadata, s.line, s.col, s.provenance FROM temp.synthesis_edges s
    WHERE NOT EXISTS (SELECT 1 FROM temp.base_synth b WHERE b.source = s.source AND b.target = s.target AND b.kind = s.kind
      AND b.source NOT IN temp.hidden_base_nodes AND b.target NOT IN temp.hidden_base_nodes)`).run().changes;
  stats.synthesis.hiddenBase = db.prepare(`INSERT OR IGNORE INTO main.overlay_hidden_base_edges (edge_id)
    SELECT b.id FROM temp.base_synth b WHERE b.source NOT IN temp.hidden_base_nodes
      AND (b.target IN temp.hidden_base_nodes OR NOT EXISTS (${staged('b')}))`).run().changes;
}

/**
 * Resolve the overlay after an update, inside the caller's transaction:
 *  1. derived rows go: edges sourced in base nodes, synthesized edges, hidden
 *     base edges; overlay edges whose target left the merged view are turned
 *     back into their refs (upstream's resurrect), so results do not depend on
 *     upsert order;
 *  2. base edges from visible files into hidden ones, and base edges whose
 *     target name the overlay added or removed (upstream sync's CG-33
 *     rebind), are turned back into their refs (Reco 3) and hidden; those
 *     without a ref stamp stay as the stable-key fallback. Skipped, with the
 *     base-ref retry of step 4 and synthesis, when the base is not at the
 *     overlay's merge-base (`baseInStep`);
 *  3. framework postExtract renames overlay rows;
 *  4. pending overlay refs, failed overlay refs the changed files could
 *     satisfy, the base edges of step 2, then failed base refs any overlay
 *     file could satisfy, go through upstream resolveAndPersist, and the
 *     deferred chain / `this.member` passes drain;
 *  5. the synthesis passes run over the merged graph when they may move.
 * A fresh resolver per call: its per-context memos (name-matcher, import
 * resolver, module config) never outlive one overlay state or cross overlays.
 */
export async function resolveOverlayMerged(db: SqliteDatabase, scope: OverlayResolveScope): Promise<OverlayUpdateStats> {
  const stats: OverlayUpdateStats = { timings: {}, rebound: { refs: 0, byName: 0, edges: 0 }, fallbackEdges: 0,
    synthesis: { ran: false, edges: 0, persisted: 0, hiddenBase: 0 }, skippedBaseRenames: 0, baseInStep: true };
  let t = Date.now();
  const lap = (name: string) => { const now = Date.now(); stats.timings[name] = (stats.timings[name] ?? 0) + now - t; t = now; };

  db.exec('DELETE FROM main.overlay_hidden_base_edges');
  db.prepare('DELETE FROM main.edges WHERE source NOT IN (SELECT id FROM main.nodes)').run();
  db.prepare(`DELETE FROM main.edges WHERE ${SYNTH('main.edges')}`).run();
  const dropped = db.prepare(`SELECT e.*, s.file_path AS source_file, s.language AS source_language
    FROM main.edges e JOIN main.nodes s ON s.id = e.source
    WHERE e.target NOT IN (SELECT id FROM main.nodes)
      AND NOT EXISTS (SELECT 1 FROM base.nodes t WHERE t.id = e.target
        AND t.file_path NOT IN (SELECT path FROM hidden_files WHERE path IS NOT NULL))`).all() as EdgeRow[];
  const reopened = dropped.map(toRef).filter((ref): ref is UnresolvedReference => ref !== null);
  const deleteEdge = db.prepare('DELETE FROM main.edges WHERE id = ?');
  for (const row of dropped) deleteEdge.run(row.id);

  const overlayPaths = (db.prepare("SELECT path FROM main.overlay_files WHERE status != 'deleted'").all() as Array<{ path: string }>).map((r) => r.path);
  // A base with no git stamp (built without setBaseInfo) is taken as in step.
  const baseCommit = (db.prepare("SELECT value FROM base.project_metadata WHERE key = 'base_commit'").get() as { value: string } | undefined)?.value;
  stats.baseInStep = baseCommit === undefined ||
    baseCommit === (db.prepare("SELECT value FROM main.layer_meta WHERE key = 'base_commit'").get() as { value: string }).value;
  createMergedTables(db);
  try {
    // Base edges into hidden files. Synthesized ones are the synthesis pass's
    // to keep or hide; the rest come back as their refs when they carry one.
    const into = db.prepare(`SELECT e.id, e.source, e.target, e.kind, e.metadata, e.line, e.col,
        s.file_path AS source_file, s.language AS source_language
      FROM temp.hidden_base_nodes h CROSS JOIN base.edges e ON e.target = h.id CROSS JOIN base.nodes s ON s.id = e.source
      WHERE e.source NOT IN temp.hidden_base_nodes AND NOT ${SYNTH('e')}`).all() as EdgeRow[];
    // CROSS JOIN fixes the order: the temp table has no statistics, and the
    // planner otherwise scans every base edge (EXPLAIN QUERY PLAN: 23 ms vs 276 ms
    // for 685 hidden nodes on this repo).
    const rebound: UnresolvedReference[] = [];
    const hide = db.prepare("INSERT OR IGNORE INTO main.overlay_hidden_base_edges (edge_id) VALUES (?)");
    for (const row of into) {
      const ref = stats.baseInStep ? toRef(row) : null;
      if (!ref) { stats.fallbackEdges++; continue; }
      rebound.push(ref);
      hide.run(row.id);
    }
    const queries = new QueryBuilder(db);
    // And base edges between visible files whose answer a name the overlay
    // added or removed may move: upstream sync's rebind (CG-33), with its
    // selection and per-name ceiling. Read through the merged view, which
    // already leaves out the edges hidden above; an edge whose source is an
    // overlay node is the overlay's own and resolved anew anyway.
    const delta = definitionDelta(db);
    const isOverlayNode = db.prepare('SELECT 1 FROM main.nodes WHERE id = ?');
    for (const e of stats.baseInStep ? queries.getResolutionEdgesByTargetName(delta) : []) {
      if (isOverlayNode.get(e.source)) continue;
      const ref = resurrectRefFromDroppedEdge(e);
      if (!ref) continue; // no stamp: never hide what cannot be restored
      rebound.push(ref);
      hide.run(e.edgeId);
      stats.rebound.byName++;
    }
    stats.rebound.refs = rebound.length;
    lap('collectRebound');

    queries.insertUnresolvedRefsBatch(reopened);
    const resolver = createResolver(scope.projectRoot, queries);
    stats.skippedBaseRenames = runPostExtract(db, resolver);
    lap('postExtract');
    resolver.resolveAndPersist(queries.getUnresolvedReferencesByFiles(overlayPaths));
    lap('resolvePending');
    const overlayRetry = selectRetryable(queries, resolver, scope.changedPaths, scope.addedPaths, delta);
    if (overlayRetry.length) resolver.resolveAndPersist(overlayRetry);
    lap('retryOverlay');
    if (rebound.length) {
      resolver.resolveAndPersist(rebound);
      // Every base-sourced edge in main so far came from these refs (step 1 dropped the rest).
      stats.rebound.edges = db.prepare(`UPDATE main.edges SET metadata = json_set(COALESCE(metadata, '{}'), '$.overlayRebound', json('true'))
        WHERE source NOT IN (SELECT id FROM main.nodes)`).run().changes;
    }
    lap('rebound');

    // Base refs: read-only selection through a base-only `unresolved_refs`.
    // Hidden files are filtered afterwards: in the view, the filter costs a
    // table read per counted row, and the per-name ceilings counted them anyway
    // (upstream's table holds the changed files' refs too).
    db.exec(`CREATE TEMP VIEW unresolved_refs AS SELECT ${columns(db, 'unresolved_refs').join(', ')} FROM base.unresolved_refs`);
    const added = db.prepare("SELECT path FROM main.overlay_files WHERE status IN ('added', 'renamed')").all().map((r: { path: string }) => r.path);
    const hidden = new Set(db.prepare('SELECT path FROM temp.hidden_paths').all().map((r: { path: string }) => r.path));
    const baseRetry = selectRetryable(new QueryBuilder(db), resolver, overlayPaths, added, delta)
      .filter((ref) => !hidden.has(ref.filePath!)).map(({ rowId: _rowId, ...ref }) => ref);
    db.exec('DROP VIEW temp.unresolved_refs');
    if (baseRetry.length && stats.baseInStep) resolver.resolveAndPersist(baseRetry);
    lap('retryBase');
    // The full index's post-resolution passes: refs deferred above until
    // implements/extends edges existed.
    await resolver.resolveChainedCallsViaConformance();
    await resolver.resolveDeferredThisMemberRefs();
    lap('deferredPasses');

    if (scope.synthesis !== 'off' && stats.baseInStep && synthesisMayMove(db, queries, scope.projectRoot, overlayPaths)) {
      lap('synthesisGate');
      stats.synthesis.ran = true;
      await synthesize(db, scope.projectRoot, stats);
      lap('synthesis');
    } else {
      lap('synthesisGate');
      // Not run: synthesized base edges into hidden files fall back to the remap.
      stats.fallbackEdges += (db.prepare(`SELECT COUNT(*) AS n FROM temp.base_synth
        WHERE source NOT IN temp.hidden_base_nodes AND target IN temp.hidden_base_nodes`).get() as { n: number }).n;
    }
  } finally {
    dropMergedTables(db);
  }
  // The marker readers see; rebuild keys off the base-owned source, not this.
  db.prepare(`UPDATE main.edges SET metadata = json_set(COALESCE(metadata, '{}'), '$.overlayBaseRef', json('true'))
    WHERE source NOT IN (SELECT id FROM main.nodes) AND NOT ${SYNTH('main.edges')}`).run();
  lap('finish');
  return stats;
}
