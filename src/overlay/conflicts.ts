import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';
import { attachReadOnly } from './database';

export interface OverlayOwner { overlayPath: string; worktreeId: string; branch: string }
export interface OverlayConflicts {
  fileConflicts: Array<{ path: string; owners: OverlayOwner[] }>;
  symbolConflicts: Array<{ stableKey: string; owners: OverlayOwner[] }>;
  /** The base has the path but no git blob stamp, or never indexes the path, so main-moved cannot be decided. */
  unverifiable: Array<{ path: string; owner: OverlayOwner }>;
  mainMoved: Array<{ path: string; owner: OverlayOwner; baseBlobId: string | null; currentBlobId: string | null }>;
}

/** One overlay attached at a time: any number of worktrees stays under SQLite's 10-ATTACH limit. */
function visitOverlays(baseDbPath: string, overlayPaths: readonly string[], visit: (db: SqliteDatabase, owner: OverlayOwner) => void): void {
  const { db } = createDatabase(baseDbPath, { readOnly: true });
  try {
    for (const overlayPath of new Set(overlayPaths)) {
      attachReadOnly(db, overlayPath, 'overlay');
      try {
        const get = db.prepare('SELECT value FROM overlay.layer_meta WHERE key = ?');
        visit(db, { overlayPath, worktreeId: get.get('worktree_id').value, branch: get.get('branch').value });
      } finally { db.exec('DETACH DATABASE overlay'); }
    }
  } finally { db.close(); }
}

// shortcut: nodes carry no body hash, so "changed" compares span length, columns
// and declaration fields; a same-length body edit is missed here (the file
// conflict still reports it). Store a per-node content hash if this matters.
const SAME_SHAPE = `b.end_line - b.start_line = o.end_line - o.start_line AND b.start_column = o.start_column
  AND b.end_column = o.end_column AND b.signature IS o.signature AND b.docstring IS o.docstring
  AND b.visibility IS o.visibility AND b.is_exported IS o.is_exported AND b.is_async IS o.is_async
  AND b.is_static IS o.is_static AND b.is_abstract IS o.is_abstract AND b.decorators IS o.decorators
  AND b.type_parameters IS o.type_parameters AND b.return_type IS o.return_type`;

/** Stable keys an overlay added, removed or changed relative to the base; file nodes are left to file conflicts. */
const CHANGED_KEYS_SQL = `
  SELECT o.stable_key FROM overlay.nodes o
  WHERE o.stable_key IS NOT NULL AND o.kind <> 'file'
    AND NOT EXISTS (SELECT 1 FROM main.nodes b WHERE b.stable_key = o.stable_key AND ${SAME_SHAPE})
  UNION
  SELECT b.stable_key FROM main.nodes b JOIN overlay.overlay_files f ON b.file_path = f.path OR b.file_path = f.old_path
  WHERE b.stable_key IS NOT NULL AND b.kind <> 'file'
    AND NOT EXISTS (SELECT 1 FROM overlay.nodes o WHERE o.stable_key = b.stable_key)`;

export function findConflicts(baseDbPath: string, overlayPaths: readonly string[]): OverlayConflicts {
  const files = new Map<string, OverlayOwner[]>();
  const symbols = new Map<string, OverlayOwner[]>();
  const mainMoved: OverlayConflicts['mainMoved'] = [];
  const unverifiable: OverlayConflicts['unverifiable'] = [];
  const add = (map: Map<string, OverlayOwner[]>, key: string, owner: OverlayOwner) => {
    const owners = map.get(key) ?? [];
    if (!owners.some((o) => o.overlayPath === owner.overlayPath)) owners.push(owner);
    map.set(key, owners);
  };
  visitOverlays(baseDbPath, overlayPaths, (db, owner) => {
    // A rename is compared against its old path, where the base holds it.
    for (const file of db.prepare(`SELECT o.*, f.path AS current_path, f.git_blob_id AS current_blob_id FROM overlay.overlay_files o
      LEFT JOIN main.files f ON f.path = COALESCE(o.old_path, o.path)`).all()) {
      add(files, file.path, owner);
      if (file.old_path) add(files, file.old_path, owner);
      const baseHasPath = file.current_path !== null;
      const neverIndexed = !baseHasPath && file.language === null && file.status !== 'added';
      if (neverIndexed || (baseHasPath && (file.current_blob_id === null || (file.base_blob_id === null && file.status !== 'added')))) {
        // An unstamped base row (or a non-added overlay row with no base blob)
        // is not evidence either way; nor is a missing row for a path neither
        // layer extracted (README, lockfiles), which the base never indexes.
        unverifiable.push({ path: file.path, owner });
      } else if (file.base_blob_id === null ? baseHasPath : file.base_blob_id !== file.current_blob_id) {
        // added + base now has it; or known base blob that is gone or different.
        mainMoved.push({ path: file.path, owner, baseBlobId: file.base_blob_id, currentBlobId: file.current_blob_id });
      }
    }
    for (const row of db.prepare(CHANGED_KEYS_SQL).all()) add(symbols, row.stable_key, owner);
  });
  return {
    fileConflicts: [...files].filter(([, owners]) => owners.length > 1).map(([path, owners]) => ({ path, owners })),
    symbolConflicts: [...symbols].filter(([, owners]) => owners.length > 1).map(([stableKey, owners]) => ({ stableKey, owners })),
    mainMoved, unverifiable,
  };
}

/** Ownership is file-level: an overlay owns a path (or old rename path) it lists, and every symbol in it, removed ones included. */
export function whoOwns(baseDbPath: string, overlayPaths: readonly string[], stableKeyOrPath: string): OverlayOwner[] {
  const owners: OverlayOwner[] = [];
  visitOverlays(baseDbPath, overlayPaths, (db, owner) => {
    const owned = db.prepare(`SELECT 1 FROM overlay.overlay_files f WHERE f.path = ? OR f.old_path = ?
      OR EXISTS (SELECT 1 FROM overlay.nodes n WHERE n.stable_key = ? AND n.file_path = f.path)
      OR EXISTS (SELECT 1 FROM main.nodes n WHERE n.stable_key = ? AND (n.file_path = f.path OR n.file_path = f.old_path)) LIMIT 1`)
      .get(stableKeyOrPath, stableKeyOrPath, stableKeyOrPath, stableKeyOrPath);
    if (owned) owners.push(owner);
  });
  return owners;
}
