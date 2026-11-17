import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';
import { QueryBuilder, rowToNode } from '../db/queries';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion } from '../db/migrations';
import { engine } from '../lazy-engine';
import type { Edge, EdgeKind, ExtractionResult, Language, Node, NodeKind } from '../types';
import type { OverlayUpdateStats } from './merged-resolver';

export interface OverlayMeta {
  worktreeId: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
}
export interface OverlayFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  blobId?: string;
  baseBlobId?: string;
  language?: Language;
}
export interface MergedNode extends Node { stableKey: string; layer: 'base' | 'overlay' }
/**
 * `possibly_stale` / `dangling` are the fallback for a base edge into a hidden
 * file that could not be re-resolved: it carries no ref stamp, or synthesis
 * was off for the update. `possibly_stale` = remapped to the overlay node with
 * the same stable key; `dangling` = no such node. Re-resolved base edges are
 * overlay edges with `metadata.overlayRebound` and carry neither flag.
 */
export interface MergedEdge extends Edge { layer: 'base' | 'overlay'; possibly_stale?: boolean; dangling?: boolean }
/** Options for one overlay update. */
export interface OverlayUpdateOptions {
  /** 'auto' (default) runs the synthesis passes when upstream sync's gate says they may move; 'off' never does. */
  synthesis?: 'auto' | 'off';
}
export interface NodeFilter { filePath?: string; name?: string; kind?: NodeKind; language?: Language }
export interface EdgeFilter { source?: string; target?: string; kind?: EdgeKind }

// 2: overlay_hidden_base_edges (Reco 2/3).
const OVERLAY_SCHEMA_VERSION = '2';
const metaKeys = { worktreeId: 'worktree_id', branch: 'branch', baseCommit: 'base_commit', headCommit: 'head_commit' } as const;

export function attachReadOnly(db: SqliteDatabase, filePath: string, alias: 'base' | 'overlay'): void {
  // URI mode=ro is enforced by SQLite, not just by our query surface.
  db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(`${pathToFileURL(path.resolve(filePath)).href}?mode=ro`);
}

/** Main is the writable overlay; the attached base is always read-only. Close after use. */
export class Overlay {
  constructor(readonly db: SqliteDatabase) {
    // Explicit columns: ALTER TABLE appends stable_key on migrated bases, while
    // fresh schema.sql puts it beside qualified_name. SELECT * would misalign.
    const columns = db.prepare('PRAGMA table_info(nodes)').all().map((r) => `n.${r.name}`).join(', ');
    db.exec(`
      CREATE TEMP VIEW hidden_files AS
        SELECT path FROM overlay_files UNION SELECT old_path FROM overlay_files WHERE old_path IS NOT NULL;
      CREATE TEMP VIEW merged_nodes AS
        SELECT ${columns}, 'overlay' AS layer FROM main.nodes n
        UNION ALL
        SELECT ${columns}, 'base' AS layer FROM base.nodes n
        WHERE n.file_path NOT IN (SELECT path FROM hidden_files);
    `);
  }

  close(): void { this.db.close(); }

  getMeta(): OverlayMeta {
    const get = this.db.prepare('SELECT value FROM layer_meta WHERE key = ?');
    return Object.fromEntries(Object.entries(metaKeys).map(([name, key]) => [name, get.get(key).value])) as unknown as OverlayMeta;
  }

  /** Caller advances headCommit only after all per-file transactions succeed. */
  setHeadCommit(headCommit: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE layer_meta SET value = ? WHERE key = 'head_commit'").run(headCommit);
      this.db.prepare("UPDATE layer_meta SET value = ? WHERE key = 'updated_at'").run(String(Date.now()));
    })();
  }

  getNodes(filter: NodeFilter = {}): MergedNode[] {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [property, column] of Object.entries({ filePath: 'file_path', name: 'name', kind: 'kind', language: 'language' })) {
      const value = filter[property as keyof NodeFilter];
      if (value !== undefined) { clauses.push(`${column} = ?`); values.push(value); }
    }
    return this.db.prepare(`SELECT * FROM merged_nodes ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY file_path, start_line, start_column, id`).all(...values).map(mergedNode);
  }

  getNodeByStableKey(stableKey: string): MergedNode | undefined {
    const row = this.db.prepare('SELECT * FROM merged_nodes WHERE stable_key = ?').get(stableKey);
    return row ? mergedNode(row) : undefined;
  }

  /** FTS5 expression syntax, not upstream fuzzy/ranked search. */
  searchNodes(query: string): MergedNode[] {
    return this.db.prepare(`
      SELECT n.*, 'overlay' AS layer FROM main.nodes_fts f JOIN main.nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ?
      UNION ALL
      SELECT ${this.db.prepare('PRAGMA table_info(nodes)').all().map((r) => `n.${r.name}`).join(', ')}, 'base' AS layer
        FROM base.nodes_fts f JOIN base.nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ? AND n.file_path NOT IN (SELECT path FROM hidden_files)
    `).all(query, query).map(mergedNode);
  }

  getEdges(filter: EdgeFilter = {}): MergedEdge[] {
    const rows = this.db.prepare(`
      SELECT e.*, 'overlay' AS layer, NULL AS replacement, 0 AS hidden,
        NOT EXISTS (SELECT 1 FROM merged_nodes t WHERE t.id = e.target) AS dangling
      FROM main.edges e WHERE EXISTS (SELECT 1 FROM merged_nodes s WHERE s.id = e.source)
      UNION ALL
      SELECT e.*, 'base' AS layer, replacement.id AS replacement,
        t.file_path IN (SELECT path FROM hidden_files) AS hidden,
        t.file_path IN (SELECT path FROM hidden_files) AND replacement.id IS NULL AS dangling
      FROM base.edges e JOIN base.nodes s ON s.id = e.source JOIN base.nodes t ON t.id = e.target
      LEFT JOIN main.nodes replacement ON replacement.stable_key = t.stable_key
      WHERE s.file_path NOT IN (SELECT path FROM hidden_files)
        AND e.id NOT IN (SELECT edge_id FROM main.overlay_hidden_base_edges)
    `).all();
    return rows.map((row): MergedEdge => ({
      source: row.source, target: row.hidden && row.replacement ? row.replacement : row.target,
      kind: row.kind, metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      line: row.line ?? undefined, column: row.col ?? undefined, provenance: row.provenance ?? undefined,
      layer: row.layer,
      ...(row.hidden && row.replacement ? { possibly_stale: true } : {}),
      ...(row.dangling ? { dangling: true } : {}),
    })).filter((edge) => Object.entries(filter).every(([key, value]) => value === undefined || edge[key as keyof EdgeFilter] === value));
  }

  upsertFile(file: OverlayFile, extraction: ExtractionResult, projectRoot: string, options?: OverlayUpdateOptions): Promise<OverlayUpdateStats> {
    return this.upsertFiles([{ file, extraction }], projectRoot, options);
  }

  /**
   * One commit's changes in one transaction, resolved once after every file's
   * rows are in: per-file resolution rescans refs naming overlay symbols each
   * time, which is quadratic in the number of changed files. Async because the
   * synthesis passes are; run one update per overlay at a time.
   */
  async upsertFiles(entries: ReadonlyArray<{ file: OverlayFile; extraction: ExtractionResult }>, projectRoot: string,
    options: OverlayUpdateOptions = {}): Promise<OverlayUpdateStats> {
    for (const { file, extraction } of entries) {
      validatePath(file.path);
      if (file.oldPath !== undefined) validatePath(file.oldPath);
      if (file.status === 'renamed' && (!file.oldPath || file.oldPath === file.path)) throw new Error('A rename needs a distinct oldPath');
      if (file.status !== 'renamed' && file.oldPath !== undefined) throw new Error('oldPath is only valid for a rename');
      if (file.status === 'deleted' && (extraction.nodes.length || extraction.edges.length || extraction.unresolvedReferences.length)) {
        throw new Error('A deleted file cannot contain extraction rows');
      }
      if (extraction.nodes.some((node) => node.filePath !== file.path)) throw new Error('Extraction nodes must belong to the overlay file');
    }
    return this.update(async (queries, db) => {
      for (const { file, extraction } of entries) {
        this.removeFileRows(queries, file.path);
        // Two ownership rows cannot ambiguously claim a rename's old path.
        const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
        const overlap = this.db.prepare('SELECT 1 FROM overlay_files WHERE path = ? OR old_path = ?');
        if (paths.some((p) => overlap.get(p, p))) throw new Error('Overlay file ownership overlaps another row');
        this.db.prepare(`INSERT INTO overlay_files
          (path, status, old_path, blob_id, base_blob_id, language, indexed_at, errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(file.path, file.status, file.oldPath ?? null, file.blobId ?? null, file.baseBlobId ?? null,
            file.language ?? extraction.nodes[0]?.language ?? null, Date.now(), extraction.errors.length ? JSON.stringify(extraction.errors) : null);
        queries.insertNodes(extraction.nodes);
        const owned = new Set(extraction.nodes.map((node) => node.id));
        for (const edge of extraction.edges) {
          if (!owned.has(edge.source)) throw new Error('Extracted edges must originate in the overlay file');
          this.insertEdge(edge);
        }
        for (const ref of extraction.unresolvedReferences) {
          if (!owned.has(ref.fromNodeId) || (ref.filePath !== undefined && ref.filePath !== file.path)) {
            throw new Error('Unresolved references must originate in the overlay file');
          }
        }
        queries.insertUnresolvedRefsBatch(extraction.unresolvedReferences.map((ref) => ({
          ...ref, filePath: file.path, language: ref.language ?? file.language ?? extraction.nodes.find((n) => n.id === ref.fromNodeId)!.language,
        })));
      }
      return this.resolve(db, entries.flatMap(({ file }) => (file.oldPath ? [file.path, file.oldPath] : [file.path])),
        entries.filter(({ file }) => file.status === 'added' || file.status === 'renamed').map(({ file }) => file.path), projectRoot, options);
    });
  }

  removeFile(filePath: string, projectRoot: string, options: OverlayUpdateOptions = {}): Promise<OverlayUpdateStats> {
    return this.update(async (queries, db) => {
      // A removed rename row gives its old path back to the base.
      const oldPath: string | null = this.db.prepare('SELECT old_path FROM overlay_files WHERE path = ?').get(filePath)?.old_path ?? null;
      this.removeFileRows(queries, filePath);
      return this.resolve(db, oldPath ? [filePath, oldPath] : [filePath], oldPath ? [oldPath] : [], projectRoot, options);
    });
  }

  /**
   * One write transaction held across the async synthesis passes. The
   * adapter's transaction() cannot span an await, so BEGIN/COMMIT are explicit
   * and writers inside get a connection whose transaction() runs its body in
   * place (what the adapter does for a nested call anyway).
   */
  private async update(body: (queries: QueryBuilder, db: SqliteDatabase) => Promise<OverlayUpdateStats>): Promise<OverlayUpdateStats> {
    if (this.updating) throw new Error('An overlay update is already running on this connection');
    this.updating = true;
    const inner: SqliteDatabase = Object.create(this.db, { transaction: { value: <T>(fn: (...args: any[]) => T) => (...args: any[]) => fn(...args) } });
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const stats = await body(new QueryBuilder(inner), inner);
        this.db.prepare("UPDATE layer_meta SET value = ? WHERE key = 'updated_at'").run(String(Date.now()));
        this.db.exec('COMMIT');
        return stats;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.updating = false;
    }
  }

  private updating = false;

  private removeFileRows(queries: QueryBuilder, filePath: string): void {
    // No cross-DB foreign keys: source/target cleanup is explicit. Edges from
    // other overlay files into replaced nodes become dangling until re-resolved.
    this.db.prepare('DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)').run(filePath);
    queries.deleteNodesByFile(filePath);
    this.db.prepare('DELETE FROM overlay_files WHERE path = ?').run(filePath);
  }

  private insertEdge(edge: Edge): void {
    const exists = this.db.prepare('SELECT 1 FROM merged_nodes WHERE id = ?');
    if (!exists.get(edge.source) || !exists.get(edge.target)) throw new Error('Overlay edge endpoint is not visible in the merged graph');
    this.db.prepare('INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(edge.source, edge.target, edge.kind, edge.metadata ? JSON.stringify(edge.metadata) : null,
        edge.line ?? null, edge.column ?? null, edge.provenance ?? null);
  }

  /**
   * Upstream resolution over the merged view (merged-resolver.ts). projectRoot
   * is the worktree checked out at the overlay's head: module configuration and
   * some source lines are read from disk there.
   */
  private resolve(db: SqliteDatabase, changedPaths: readonly string[], addedPaths: readonly string[], projectRoot: string,
    options: OverlayUpdateOptions): Promise<OverlayUpdateStats> {
    return engine().resolveOverlayMerged(db, { changedPaths, addedPaths, projectRoot, synthesis: options.synthesis });
  }
}

function mergedNode(row: Parameters<typeof rowToNode>[0] & { stable_key: string; layer: 'base' | 'overlay' }): MergedNode {
  return { ...rowToNode(row), stableKey: row.stable_key, layer: row.layer };
}

function validatePath(filePath: string): void {
  if (!filePath || path.isAbsolute(filePath) || filePath.includes('\\') || filePath.split('/').some((s) => !s || s === '.' || s === '..')) {
    throw new Error('Overlay paths must be normalized project-relative paths with forward slashes');
  }
}

export function createOverlay(overlayPath: string, baseDbPath: string, meta: OverlayMeta): Overlay {
  // Exclusive creation prevents accidentally resetting another worktree's graph.
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.closeSync(fs.openSync(overlayPath, 'wx'));
  const { db } = createDatabase(overlayPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    // Reuse upstream shapes/triggers/indexes. Neither edge endpoint can have a
    // local FK: a rechecked base reference also has a base-owned source.
    const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
      .replace(/,\s*FOREIGN KEY \(source\) REFERENCES nodes\(id\) ON DELETE CASCADE,\s*FOREIGN KEY \(target\) REFERENCES nodes\(id\) ON DELETE CASCADE/, '');
    db.transaction(() => {
      db.exec(schema);
      db.exec(`CREATE TABLE layer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE overlay_files (
          path TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('added','modified','deleted','renamed')),
          old_path TEXT, blob_id TEXT, base_blob_id TEXT, language TEXT,
          indexed_at INTEGER NOT NULL, errors TEXT
        );
        -- Base edges the merged view leaves out, rebuilt on every update: re-resolved
        -- into the overlay (Reco 3), or synthesized ones the merged graph's synthesis
        -- no longer draws or that point into a hidden file. One column, so
        -- "id NOT IN overlay_hidden_base_edges" probes the key.
        CREATE TABLE overlay_hidden_base_edges (edge_id INTEGER PRIMARY KEY);`);
      const set = db.prepare('INSERT INTO layer_meta (key, value) VALUES (?, ?)');
      for (const [name, key] of Object.entries(metaKeys)) set.run(key, meta[name as keyof OverlayMeta]);
      set.run('updated_at', String(Date.now()));
      set.run('overlay_schema_version', OVERLAY_SCHEMA_VERSION);
      db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
        .run(CURRENT_SCHEMA_VERSION, Date.now(), 'Overlay schema');
    })();
    db.close();
    return openOverlay(overlayPath, baseDbPath);
  } catch (error) {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(overlayPath + suffix, { force: true });
    throw error;
  }
}

export function openOverlay(overlayPath: string, baseDbPath: string): Overlay {
  if (!fs.existsSync(overlayPath)) throw new Error(`Overlay does not exist: ${overlayPath}`);
  const { db } = createDatabase(overlayPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
    if (getCurrentVersion(db) !== CURRENT_SCHEMA_VERSION ||
      db.prepare("SELECT value FROM layer_meta WHERE key = 'overlay_schema_version'").get()?.value !== OVERLAY_SCHEMA_VERSION) {
      throw new Error('Unsupported overlay schema version');
    }
    attachReadOnly(db, baseDbPath, 'base');
    if (db.prepare('SELECT MAX(version) AS version FROM base.schema_versions').get()?.version !== CURRENT_SCHEMA_VERSION) {
      throw new Error('Base must be migrated to the current schema before attaching');
    }
    return new Overlay(db);
  } catch (error) { db.close(); throw error; }
}

export function upsertOverlayFile(overlay: Overlay, file: OverlayFile, extraction: ExtractionResult, projectRoot: string,
  options?: OverlayUpdateOptions): Promise<OverlayUpdateStats> {
  return overlay.upsertFile(file, extraction, projectRoot, options);
}
export function removeOverlayFile(overlay: Overlay, filePath: string, projectRoot: string, options?: OverlayUpdateOptions): Promise<OverlayUpdateStats> {
  return overlay.removeFile(filePath, projectRoot, options);
}
