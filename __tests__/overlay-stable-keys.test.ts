/**
 * Schema v17: nodes.stable_key, files.git_blob_id, and the base-layer metadata
 * the shared base index carries (docs/stingray-overlay-handoff.md, Phase 0 step 2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { getBaseInfo, setBaseInfo, setGitBlobIds } from '../src/overlay';
import type { Node } from '../src/types';

function node(id: string, filePath: string, qualifiedName: string, startLine: number, kind: Node['kind'] = 'function'): Node {
  return {
    id, kind, name: qualifiedName.split('::').pop()!, qualifiedName, filePath, language: 'typescript',
    startLine, endLine: startLine, startColumn: 0, endColumn: 1, updatedAt: 0,
  };
}

describe('schema v17 stable keys', () => {
  let dir: string;
  let dbPath: string;
  let connection: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stable-keys-'));
    dbPath = path.join(dir, 'test.db');
    connection = DatabaseConnection.initialize(dbPath);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const keys = () => connection.getDb().prepare('SELECT id, stable_key FROM nodes ORDER BY id').all()
    .map((row) => [row.id, row.stable_key]);

  it('creates the columns and index on a fresh database', () => {
    const db = connection.getDb();
    expect(getCurrentVersion(db)).toBe(17);
    expect(CURRENT_SCHEMA_VERSION).toBe(17);
    expect(db.prepare('PRAGMA table_info(nodes)').all().map((r) => r.name)).toContain('stable_key');
    expect(db.prepare('PRAGMA table_info(files)').all().map((r) => r.name)).toContain('git_blob_id');
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_stable_key'").get()).toBeTruthy();
  });

  it('keys duplicates in source order: first unsuffixed, then #1, #2', () => {
    const queries = new QueryBuilder(connection.getDb());
    queries.insertNodes([
      node('c', 'a.ts', 'A::over', 30),
      node('a', 'a.ts', 'A::over', 10),
      node('b', 'a.ts', 'A::over', 20),
      node('d', 'a.ts', 'A::over', 10, 'method'),
      node('e', 'b.ts', 'A::over', 5),
    ]);
    expect(keys()).toEqual([
      ['a', 'a.ts#function#A::over'],
      ['b', 'a.ts#function#A::over#1'],
      ['c', 'a.ts#function#A::over#2'],
      ['d', 'a.ts#method#A::over'],
      ['e', 'b.ts#function#A::over'],
    ]);
    // Deleting the first renumbers the rest of its group only.
    queries.deleteNode('a');
    expect(keys().slice(0, 2)).toEqual([['b', 'a.ts#function#A::over'], ['c', 'a.ts#function#A::over#1']]);
  });

  it('migrates a v16 database, backfilling keys, and re-running is a no-op', () => {
    const queries = new QueryBuilder(connection.getDb());
    queries.insertNodes([node('a', 'a.ts', 'f', 1), node('b', 'a.ts', 'f', 2)]);
    queries.upsertFile({ path: 'a.ts', contentHash: 'h', language: 'typescript', size: 1, modifiedAt: 0, indexedAt: 0, nodeCount: 2 });
    connection.getDb().exec(`DROP INDEX idx_nodes_stable_key;
      ALTER TABLE nodes DROP COLUMN stable_key;
      ALTER TABLE files DROP COLUMN git_blob_id;
      DELETE FROM schema_versions WHERE version >= 17;
      INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (16, 0, 'fixture');`);
    connection.close();

    connection = DatabaseConnection.open(dbPath);
    const db = connection.getDb();
    expect(getCurrentVersion(db)).toBe(17);
    expect(keys()).toEqual([['a', 'a.ts#function#f'], ['b', 'a.ts#function#f#1']]);
    expect(db.prepare('SELECT git_blob_id FROM files').get()).toEqual({ git_blob_id: null });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_nodes_stable_key'").get()).toBeTruthy();

    const before = db.prepare('SELECT * FROM nodes ORDER BY id').all();
    db.exec('DELETE FROM schema_versions WHERE version >= 17');
    runMigrations(db, 16);
    expect(getCurrentVersion(db)).toBe(17);
    expect(db.prepare('SELECT * FROM nodes ORDER BY id').all()).toEqual(before);
  });

  it('stores base metadata and clears a git blob stamp when content changes', () => {
    const db = connection.getDb();
    expect(getBaseInfo(db)).toBeNull();
    setBaseInfo(db, { baseCommit: 'abc', baseRef: 'origin/main' });
    expect(getBaseInfo(db)).toEqual({ baseCommit: 'abc', baseRef: 'origin/main', layerKind: 'base' });

    const queries = new QueryBuilder(db);
    const file = { path: 'a.ts', contentHash: 'h1', language: 'typescript' as const, size: 1, modifiedAt: 0, indexedAt: 0, nodeCount: 0 };
    queries.upsertFile(file);
    setGitBlobIds(db, new Map([['a.ts', 'blob1']]));
    queries.upsertFile({ ...file, indexedAt: 1 });
    expect(db.prepare('SELECT git_blob_id FROM files').get()).toEqual({ git_blob_id: 'blob1' });
    queries.upsertFile({ ...file, contentHash: 'h2' });
    expect(db.prepare('SELECT git_blob_id FROM files').get()).toEqual({ git_blob_id: null });
  });
});

describe('stable keys through indexAll and sync', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stable-keys-index-'));
    fs.mkdirSync(path.join(dir, 'src'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function readKeys(): Map<string, string> {
    const connection = DatabaseConnection.open(getDatabasePath(dir), { readOnly: true });
    try {
      return new Map(connection.getDb().prepare("SELECT id, stable_key FROM nodes WHERE name = 'target'").all()
        .map((row) => [row.id, row.stable_key]));
    } finally { connection.close(); }
  }

  it('populates keys on a fresh index and keeps them when lines shift above a symbol', async () => {
    const file = path.join(dir, 'src/a.ts');
    fs.writeFileSync(file, 'export function target() { return 1; }\n');
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const first = readKeys();
      expect([...first.values()]).toEqual(['src/a.ts#function#target']);

      fs.writeFileSync(file, '// one\n// two\n\nexport function target() { return 1; }\n');
      await cg.sync();
      const second = readKeys();
      expect([...second.keys()]).not.toEqual([...first.keys()]); // the upstream id moved with the line
      expect([...second.values()]).toEqual([...first.values()]);

      const connection = DatabaseConnection.open(getDatabasePath(dir), { readOnly: true });
      try {
        expect(connection.getDb().prepare('SELECT COUNT(*) AS n FROM nodes WHERE stable_key IS NULL').get()).toEqual({ n: 0 });
      } finally { connection.close(); }
    } finally { cg.close(); }
  });
});
