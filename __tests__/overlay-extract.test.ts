/**
 * extractFile / resolveScoped: per-file extraction without a database, and
 * resolution limited to one file's pending refs (Phase 0 step 1).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile, resolveScoped } from '../src';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

describe('extractFile and resolveScoped', () => {
  let dir: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overlay-extract-'));
    connection = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    queries = new QueryBuilder(connection.getDb());
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function store(filePath: string, content: string) {
    const result = await extractFile(filePath, content);
    queries.insertNodes(result.nodes);
    queries.insertEdges(result.edges);
    queries.insertUnresolvedRefsBatch(result.unresolvedReferences);
    queries.upsertFile({ path: filePath, contentHash: filePath, language: 'typescript', size: content.length,
      modifiedAt: 0, indexedAt: 0, nodeCount: result.nodes.length });
    return result;
  }

  it('extracts supplied content without touching a database or the filesystem', async () => {
    const result = await extractFile('src/a.py', 'def helper():\n    return 1\n\ndef run():\n    return helper()\n');
    expect(result.nodes.filter((n) => n.kind === 'function').map((n) => n.name)).toEqual(['helper', 'run']);
    expect(result.unresolvedReferences.map((r) => r.referenceName)).toContain('helper');
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
    expect(connection.getDb().prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
  });

  it('skips a file over the indexer size cap, like a full index does', async () => {
    const result = await extractFile('src/big.py', 'def f():\n    return 1\n' + '#'.repeat(1024 * 1024));
    expect(result.nodes).toEqual([]);
    expect(result.errors.map((e) => e.code)).toEqual(['size_exceeded']);
  });

  it('resolves only the named files and leaves other pending refs alone', async () => {
    await store('src/auth.ts', 'export function parseToken(t: string) { return t; }\n');
    await store('src/login.ts', "import { parseToken } from './auth';\nexport function login(t: string) { return parseToken(t); }\n");
    await store('src/other.ts', "import { parseToken } from './auth';\nexport function other(t: string) { return parseToken(t); }\n");

    resolveScoped(connection.getDb(), ['src/login.ts'], dir);
    const calls = connection.getDb().prepare(`SELECT s.name AS source, t.name AS target FROM edges e
      JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind = 'calls'`).all();
    expect(calls).toEqual([{ source: 'login', target: 'parseToken' }]);
    expect(queries.getUnresolvedReferencesByFiles(['src/other.ts']).length).toBeGreaterThan(0);
  });
});
