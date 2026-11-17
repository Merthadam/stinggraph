/**
 * A worktree overlay over a read-only base: the merged view's hiding, remap,
 * dangling and search rules (docs/stingray-overlay-handoff.md, Phase 0 step 3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { getDatabasePath } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { createOverlay, extractFile, openOverlay, removeOverlayFile, setBaseInfo, upsertOverlayFile, type Overlay } from '../src/overlay';

const BASE_FILES: Record<string, string> = {
  'src/auth.ts': 'export function parseToken(t: string) { return t.trim(); }\n',
  'src/login.ts': "import { parseToken } from './auth';\nexport function login(t: string) { return parseToken(t); }\n",
  'src/util.ts': 'export function helper() { return 1; }\nexport function gone() { return 2; }\n',
  'src/main.ts': "import { helper, gone } from './util';\nexport function main() { helper(); gone(); brandNew(); }\n",
  'src/old.ts': 'export function legacy() { return 0; }\n',
  'src/moved.ts': 'export function movable() { return 0; }\n',
};

describe('overlay merged view', () => {
  let dir: string;
  let baseDb: string;
  let overlayPath: string;
  let overlay: Overlay;
  let checkout: string; // the worktree at the overlay's head, which the resolver reads module config from

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overlay-view-'));
    const project = path.join(dir, 'project');
    for (const [file, content] of Object.entries(BASE_FILES)) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.writeFileSync(path.join(project, file), content);
    }
    (await CodeGraph.init(project, { index: true })).close();
    baseDb = getDatabasePath(project);
    checkout = path.join(dir, 'wt');
    fs.cpSync(project, checkout, { recursive: true, filter: (src) => !src.includes('.codegraph') });
    overlayPath = path.join(checkout, '.codegraph', 'overlay.db');
    overlay = createOverlay(overlayPath, baseDb, { worktreeId: 'wt-a', branch: 'feature/a', baseCommit: 'c0', headCommit: 'c0' });
  });

  afterEach(() => {
    overlay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(checkout, filePath)), { recursive: true });
    fs.writeFileSync(path.join(checkout, filePath), content);
  };
  const put = async (filePath: string, content: string, status: 'added' | 'modified' | 'renamed', oldPath?: string) => {
    write(filePath, content);
    await upsertOverlayFile(overlay, { path: filePath, status, oldPath, blobId: 'b-' + filePath }, await extractFile(filePath, content), checkout);
  };
  const named = (name: string) => overlay.getNodes({ name });
  const edgesBetween = (sourceName: string, targetName: string) => {
    const source = named(sourceName)[0];
    const target = overlay.getEdges({ source: source.id });
    return target.filter((edge) => {
      const t = overlay.getNodes().find((n) => n.id === edge.target);
      return edge.dangling ? targetName === '<dangling>' : t?.name === targetName;
    });
  };

  it('attaches the base read-only and starts as exactly the base', () => {
    expect(overlay.getMeta()).toEqual({ worktreeId: 'wt-a', branch: 'feature/a', baseCommit: 'c0', headCommit: 'c0' });
    expect(named('parseToken').map((n) => n.layer)).toEqual(['base']);
    expect(() => overlay.db.exec("INSERT INTO base.files (path, content_hash, language, size, modified_at, indexed_at) VALUES ('x','x','typescript',0,0,0)"))
      .toThrow(/readonly|read-only/i);
    expect(() => createOverlay(overlayPath, baseDb, overlay.getMeta())).toThrow(); // never resets an existing overlay
    overlay.setHeadCommit('c1');
    overlay.close();
    overlay = openOverlay(overlayPath, baseDb);
    expect(overlay.getMeta().headCommit).toBe('c1');
  });

  it('a modified file hides its base rows, and a base call into it is re-resolved to the new node', async () => {
    const before = edgesBetween('login', 'parseToken');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ layer: 'base' });

    await put('src/auth.ts', '// shifted\n\nexport function parseToken(t: string) { return t; }\n', 'modified');
    const nodes = named('parseToken');
    expect(nodes.map((n) => [n.layer, n.startLine, n.stableKey])).toEqual([['overlay', 3, 'src/auth.ts#function#parseToken']]);
    const after = edgesBetween('login', 'parseToken');
    // The base edge is hidden; its ref bound again over the merged view.
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ layer: 'overlay', target: nodes[0].id, metadata: { overlayRebound: true } });
    expect(after[0].possibly_stale).toBeUndefined();
    expect(overlay.getNodeByStableKey('src/auth.ts#function#parseToken')?.layer).toBe('overlay');
  });

  it('a base call into a symbol the overlay removed is gone, as in a full index', async () => {
    await put('src/util.ts', 'export function helper() { return 1; }\n', 'modified');
    const main = named('main')[0];
    const outgoing = overlay.getEdges({ source: main.id, kind: 'calls' });
    expect(outgoing.filter((e) => e.dangling || e.possibly_stale)).toEqual([]);
    expect(outgoing.map((e) => overlay.getNodes().find((n) => n.id === e.target)?.stableKey)).toEqual(['src/util.ts#function#helper']);
    expect(named('gone')).toEqual([]);
  });

  it('falls back to possibly_stale / dangling for base edges with no ref to re-resolve', async () => {
    // An index from before edges carried their ref (refName stamp).
    overlay.close();
    const { db } = createDatabase(baseDb);
    db.prepare("UPDATE edges SET metadata = json_remove(metadata, '$.refName') WHERE kind = 'calls'").run();
    db.close();
    overlay = openOverlay(overlayPath, baseDb);

    await put('src/util.ts', '// shifted\nexport function helper() { return 1; }\n', 'modified');
    const main = named('main')[0];
    const outgoing = overlay.getEdges({ source: main.id, kind: 'calls' });
    expect(outgoing.filter((e) => e.dangling)).toHaveLength(1); // gone
    expect(outgoing.filter((e) => e.possibly_stale)).toMatchObject([{ layer: 'base', target: named('helper')[0].id }]);
  });

  it('re-resolves nothing from base files while the base is at another commit than the overlay\'s merge-base', async () => {
    overlay.close();
    const { db } = createDatabase(baseDb);
    setBaseInfo(db, { baseCommit: 'main-moved', baseRef: 'origin/main' }); // the overlay was created at c0
    db.close();
    overlay = openOverlay(overlayPath, baseDb);

    write('src/auth.ts', '// shifted\n\nexport function parseToken(t: string) { return t; }\n');
    const stats = await overlay.upsertFiles([{ file: { path: 'src/auth.ts', status: 'modified' },
      extraction: await extractFile('src/auth.ts', '// shifted\n\nexport function parseToken(t: string) { return t; }\n') }], checkout);
    expect(stats).toMatchObject({ baseInStep: false, rebound: { refs: 0 }, synthesis: { ran: false } });
    expect(edgesBetween('login', 'parseToken')).toMatchObject([{ layer: 'base', possibly_stale: true }]);
  });

  it('deleted and renamed files hide the base path; removing the row restores the base', async () => {
    await upsertOverlayFile(overlay, { path: 'src/old.ts', status: 'deleted', baseBlobId: 'x' },
      { nodes: [], edges: [], unresolvedReferences: [], errors: [] }, checkout);
    expect(named('legacy')).toEqual([]);
    expect(overlay.getNodes({ filePath: 'src/old.ts' })).toEqual([]);

    await put('src/renamed.ts', 'export function movable() { return 0; }\n', 'renamed', 'src/moved.ts');
    expect(named('movable').map((n) => [n.layer, n.filePath])).toEqual([['overlay', 'src/renamed.ts']]);

    await removeOverlayFile(overlay, 'src/old.ts', checkout);
    expect(named('legacy').map((n) => n.layer)).toEqual(['base']);
  });

  it('resolves added-file refs against the merged view and rechecks base refs against new symbols', async () => {
    await put('src/new.ts', "import { parseToken } from './auth';\nexport function brandNew() { return parseToken('x'); }\n", 'added');
    expect(edgesBetween('brandNew', 'parseToken')).toMatchObject([{ layer: 'overlay', kind: 'calls' }]);

    const fromBase = edgesBetween('main', 'brandNew');
    expect(fromBase).toHaveLength(1);
    expect(fromBase[0]).toMatchObject({ layer: 'overlay', metadata: { overlayBaseRef: true } });

    // Hiding the base source file drops the base-sourced overlay edge too.
    await put('src/main.ts', 'export function main() { return 0; }\n', 'modified');
    expect(overlay.getEdges().filter((e) => e.metadata?.overlayBaseRef)).toEqual([]);
  });

  it('a multi-file update resolves the same whichever file is upserted first', async () => {
    // login.ts first: its call resolves to the base parseToken, which auth.ts then hides at a new line.
    await put('src/login.ts', "import { parseToken } from './auth';\nexport function login(t: string) { return parseToken(t) + extra(); }\n", 'modified');
    await put('src/auth.ts', '// moved\n\nexport function parseToken(t: string) { return t; }\nexport function extra() { return 1; }\n', 'modified');
    const calls = overlay.getEdges({ source: named('login')[0].id, kind: 'calls' });
    expect(calls.filter((e) => e.dangling)).toEqual([]);
    expect(calls.map((e) => overlay.getNodes().find((n) => n.id === e.target)?.stableKey).sort())
      .toEqual(['src/auth.ts#function#extra', 'src/auth.ts#function#parseToken']);
  });

  it('upsertFiles writes a whole commit and resolves it once', async () => {
    const files = {
      'src/caller.ts': "import { later } from './later';\nexport function caller() { return later(); }\n",
      'src/later.ts': 'export function later() { return 1; }\n',
    };
    for (const [p, content] of Object.entries(files)) write(p, content);
    await overlay.upsertFiles(await Promise.all(Object.entries(files).map(async ([p, content]) =>
      ({ file: { path: p, status: 'added' as const }, extraction: await extractFile(p, content) }))), checkout);
    expect(edgesBetween('caller', 'later')).toMatchObject([{ layer: 'overlay', kind: 'calls' }]);
  });

  it('searches both FTS tables with the hiding rule', async () => {
    const hits = (query: string) => overlay.searchNodes(query).filter((n) => n.kind === 'function').map((n) => [n.layer, n.name]).sort();
    expect(hits('parseToken')).toEqual([['base', 'parseToken']]);
    await put('src/auth.ts', 'export function parseToken(t: string) { return t; }\nexport function parseTokenStrict() {}\n', 'modified');
    expect(hits('parseToken*')).toEqual([['overlay', 'parseToken'], ['overlay', 'parseTokenStrict']]);
    expect(hits('legacy')).toEqual([['base', 'legacy']]);
  });

  it('rejects edges whose endpoints are not in the merged view', async () => {
    const extraction = await extractFile('src/x.ts', 'export function x() {}\n');
    extraction.edges.push({ source: extraction.nodes[0].id, target: 'no-such-node', kind: 'calls' });
    await expect(upsertOverlayFile(overlay, { path: 'src/x.ts', status: 'added' }, extraction, checkout)).rejects.toThrow(/not visible/);
    expect(overlay.getNodes({ filePath: 'src/x.ts' })).toEqual([]); // the transaction rolled back
  });
});
