import type { SqliteDatabase } from '../db/sqlite-adapter';

/**
 * The first occurrence has no suffix; subsequent occurrences get #1, #2, ...
 * in (start_line, start_column, id) order. Adding/removing overloads can change
 * ordinals; shifting lines above an unchanged group cannot. Migration and every
 * node writer use this same SQL, avoiding two subtly different key algorithms.
 */
export function recomputeStableKeys(db: SqliteDatabase, filePaths?: readonly string[]): void {
  const sql = (scoped: boolean) => `
    WITH ranked AS (
      SELECT id, file_path || '#' || kind || '#' || COALESCE(qualified_name, name) AS prefix,
        ROW_NUMBER() OVER (
          PARTITION BY file_path, kind, COALESCE(qualified_name, name)
          ORDER BY start_line, start_column, id
        ) - 1 AS ordinal
      FROM nodes ${scoped ? 'WHERE file_path = ?' : ''}
    ), keyed AS (
      SELECT id, prefix || CASE WHEN ordinal = 0 THEN '' ELSE '#' || ordinal END AS key FROM ranked
    )
    UPDATE nodes SET stable_key = keyed.key FROM keyed
    WHERE nodes.id = keyed.id AND nodes.stable_key IS NOT keyed.key`;
  if (filePaths === undefined) {
    db.exec(sql(false));
  } else if (filePaths.length > 0) {
    const statement = db.prepare(sql(true));
    db.transaction(() => {
      for (const filePath of new Set(filePaths)) statement.run(filePath);
    })();
  }
}

/**
 * Node writers call this. A fresh index drops idx_nodes_file_path for its bulk
 * parse window, where a per-file recompute would scan the whole table per
 * batch; endBulkParseLoad recomputes every key once instead.
 */
export function recomputeStableKeysAfterWrite(db: SqliteDatabase, filePaths: readonly string[]): void {
  const indexed = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_file_path'").get();
  if (indexed) recomputeStableKeys(db, filePaths);
}

/** Stamp files whose indexed content came from git; a later content change clears the stamp. */
export function setGitBlobIds(db: SqliteDatabase, blobIds: ReadonlyMap<string, string | null>): void {
  const set = db.prepare('UPDATE files SET git_blob_id = ? WHERE path = ?');
  db.transaction(() => {
    for (const [filePath, blobId] of blobIds) set.run(blobId, filePath);
  })();
}

export interface BaseInfo { baseCommit: string; baseRef: string; layerKind: 'base' }

export function setBaseInfo(db: SqliteDatabase, info: Omit<BaseInfo, 'layerKind'>): void {
  const set = db.prepare('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const [key, value] of Object.entries({ base_commit: info.baseCommit, base_ref: info.baseRef, layer_kind: 'base' })) {
      set.run(key, value, Date.now());
    }
  })();
}

/** Null until the caller stamps a git-backed base; indexing does not invoke git for this. */
export function getBaseInfo(db: SqliteDatabase): BaseInfo | null {
  const get = db.prepare('SELECT value FROM project_metadata WHERE key = ?');
  const commit = get.get('base_commit')?.value;
  const ref = get.get('base_ref')?.value;
  return commit != null && ref != null && get.get('layer_kind')?.value === 'base'
    ? { baseCommit: commit, baseRef: ref, layerKind: 'base' } : null;
}
