/**
 * Cross-overlay queries: file and symbol conflicts, ownership, and the
 * three-state main-moved check (Phase 0 step 3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { createOverlay, extractFile, findConflicts, setGitBlobIds, upsertOverlayFile, whoOwns, type OverlayFile } from '../src/overlay';

const EMPTY = { nodes: [], edges: [], unresolvedReferences: [], errors: [] };

describe('overlay conflicts', () => {
  let dir: string;
  let project: string; // conflicts read rows only; resolution needs some checkout
  let baseDb: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overlay-conflicts-'));
    project = path.join(dir, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src/shared.ts'), 'export function a() { return 1; }\nexport function b() { return 2; }\n');
    fs.writeFileSync(path.join(project, 'src/stamped.ts'), 'export const s = 1;\n');
    fs.writeFileSync(path.join(project, 'src/unstamped.ts'), 'export const u = 1;\n');
    fs.writeFileSync(path.join(project, 'src/landed.ts'), 'export const l = 1;\n');
    (await CodeGraph.init(project, { index: true })).close();
    baseDb = getDatabasePath(project);
    const connection = DatabaseConnection.open(baseDb);
    try {
      setGitBlobIds(connection.getDb(), new Map([
        ['src/shared.ts', 'blob-shared'], ['src/stamped.ts', 'blob-stamped-v2'], ['src/landed.ts', 'blob-landed'],
      ]));
    } finally { connection.close(); }
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function overlay(name: string, files: Array<[OverlayFile, string | null]>): Promise<string> {
    const overlayPath = path.join(dir, name, 'overlay.db');
    const o = createOverlay(overlayPath, baseDb, { worktreeId: name, branch: `feature/${name}`, baseCommit: 'c0', headCommit: 'c1' });
    return (async () => {
      try {
        for (const [file, content] of files) await upsertOverlayFile(o, file, content === null ? EMPTY : await extractFile(file.path, content), project);
      } finally { o.close(); }
      return overlayPath;
    })();
  }

  it('reports file and symbol conflicts across several overlays, and who owns what', async () => {
    const a = await overlay('a', [[{ path: 'src/shared.ts', status: 'modified', baseBlobId: 'blob-shared' },
      'export function a() {\n  return 10;\n}\nexport function b() { return 2; }\n']]);
    const b = await overlay('b', [[{ path: 'src/shared.ts', status: 'modified', baseBlobId: 'blob-shared' },
      'export function a() {\n  return 20;\n}\nexport function b() { return 2; }\n']]);
    const c = await overlay('c', [[{ path: 'src/other.ts', status: 'added' }, 'export const o = 1;\n']]);
    // More overlays than SQLite's default 10 attached databases.
    const many = [a, b, c, ...await Promise.all(Array.from({ length: 9 }, (_, i) =>
      overlay(`x${i}`, [[{ path: `src/x${i}.ts`, status: 'added' }, `export const x${i} = 1;\n`]])))];

    const conflicts = findConflicts(baseDb, many);
    expect(conflicts.fileConflicts.map((f) => [f.path, f.owners.map((o) => o.worktreeId)])).toEqual([['src/shared.ts', ['a', 'b']]]);
    // b() is unchanged in both, so only a() conflicts.
    expect(conflicts.symbolConflicts.map((s) => s.stableKey)).toEqual(['src/shared.ts#function#a']);

    expect(whoOwns(baseDb, many, 'src/shared.ts#function#a').map((o) => o.branch)).toEqual(['feature/a', 'feature/b']);
    expect(whoOwns(baseDb, many, 'src/other.ts').map((o) => o.worktreeId)).toEqual(['c']);
    expect(whoOwns(baseDb, many, 'src/nobody.ts')).toEqual([]);
  });

  it('a removed symbol conflicts with another overlay changing it', async () => {
    const a = await overlay('a', [[{ path: 'src/shared.ts', status: 'modified', baseBlobId: 'blob-shared' },
      'export function a() { return 1; }\n']]);
    const b = await overlay('b', [[{ path: 'src/shared.ts', status: 'modified', baseBlobId: 'blob-shared' },
      'export function a() { return 1; }\nexport function b(x: number) { return x; }\n']]);
    expect(findConflicts(baseDb, [a, b]).symbolConflicts.map((s) => s.stableKey)).toEqual(['src/shared.ts#function#b']);
  });

  it('classifies main-moved in its distinct states', async () => {
    const o = await overlay('a', [
      // (1) base row exists but carries no blob stamp: unverifiable, not moved
      [{ path: 'src/unstamped.ts', status: 'modified', baseBlobId: 'blob-u' }, 'export const u = 2;\n'],
      // (2) added in the overlay, but main now has the path
      [{ path: 'src/landed.ts', status: 'added' }, 'export const l = 2;\n'],
      // (3) a known base blob, and main deleted the file
      [{ path: 'src/vanished.ts', status: 'modified', baseBlobId: 'blob-v' }, 'export const v = 2;\n'],
      // (4) both known and different
      [{ path: 'src/stamped.ts', status: 'deleted', baseBlobId: 'blob-stamped-v1' }, null],
      // (5) added, and main still lacks it: fine
      [{ path: 'src/fresh.ts', status: 'added' }, 'export const f = 1;\n'],
      // (6) not a file the base indexes (no extraction): no evidence, not moved
      [{ path: 'README.md', status: 'modified', baseBlobId: 'blob-readme' }, null],
      // unchanged base blob: fine
      [{ path: 'src/shared.ts', status: 'modified', baseBlobId: 'blob-shared' }, 'export function a() { return 1; }\n'],
    ]);
    const { mainMoved, unverifiable } = findConflicts(baseDb, [o]);
    expect(unverifiable.map((u) => u.path).sort()).toEqual(['README.md', 'src/unstamped.ts']);
    expect(mainMoved.map((m) => [m.path, m.baseBlobId, m.currentBlobId]).sort()).toEqual([
      ['src/landed.ts', null, 'blob-landed'],
      ['src/stamped.ts', 'blob-stamped-v1', 'blob-stamped-v2'],
      ['src/vanished.ts', 'blob-v', null],
    ]);
  });
});
