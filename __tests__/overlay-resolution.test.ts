/**
 * Overlay resolution is upstream's ReferenceResolver over the merged view
 * (src/overlay/merged-resolver.ts), not a name lookup: imports, ambiguous
 * names, `instantiates`, base refs binding to overlay symbols, order, and
 * resolver memos that must not cross overlays.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { getDatabasePath } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { createOverlay, extractFile, type Overlay, type OverlayFile } from '../src/overlay';

const BASE_FILES: Record<string, string> = {
  'src/util1.ts': 'export function helper() { return 1; }\n',
  'src/util2.ts': 'export function helper() { return 2; }\n',
  'src/model.ts': 'export class Widget { run() { return 1; } }\n',
  'src/consumer.ts': "import { fresh } from './fresh';\nexport function consume() { return fresh(); }\n",
  'src/a/x.ts': "export function x() { return 'a'; }\n",
  'src/b/x.ts': "export function x() { return 'b'; }\n",
  'src/lib.ts': 'export function moveMe() { return 1; }\nexport function stay() { return 2; }\n',
  'src/libuser.ts': "import { moveMe, stay } from './lib';\nexport function useLib() { return moveMe() + stay(); }\n",
  'src/svc.ts': 'export class Svc { getDb() { return 1; } }\n',
  'src/usesvc.ts': 'export function useSvc(db: any) { return db.getDb(); }\n',
};

describe('overlay resolution over the merged view', () => {
  let dir: string;
  let project: string;
  let baseDb: string;
  const open: Overlay[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overlay-resolve-'));
    project = path.join(dir, 'project');
    for (const [file, content] of Object.entries(BASE_FILES)) write(project, file, content);
    (await CodeGraph.init(project, { index: true })).close();
    baseDb = getDatabasePath(project);
  });

  afterEach(() => {
    for (const overlay of open.splice(0)) overlay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(root: string, file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }

  /** A worktree checkout (base files plus `extra`) and an empty overlay for it. */
  function worktree(name: string, extra: Record<string, string> = {}): { overlay: Overlay; checkout: string } {
    const checkout = path.join(dir, name);
    fs.cpSync(project, checkout, { recursive: true, filter: (src) => !src.includes('.codegraph') });
    for (const [file, content] of Object.entries(extra)) write(checkout, file, content);
    const overlay = createOverlay(path.join(checkout, '.codegraph', 'overlay.db'), baseDb, { worktreeId: name, branch: name, baseCommit: 'c0', headCommit: 'c0' });
    open.push(overlay);
    return { overlay, checkout };
  }

  /** A null content deletes the file. */
  async function commit(wt: { overlay: Overlay; checkout: string }, files: Record<string, [OverlayFile['status'], string | null]>): Promise<void> {
    for (const [file, [, content]] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(wt.checkout, file));
      else write(wt.checkout, file, content);
    }
    await wt.overlay.upsertFiles(await Promise.all(Object.entries(files).map(async ([file, [status, content]]) => ({
      file: { path: file, status },
      extraction: content === null ? { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 } : await extractFile(file, content),
    }))), wt.checkout);
  }

  /** Non-`contains` edges out of `file` in a full index of a copy of `checkout`, by stable key. */
  async function fullIndexEdges(checkout: string, file: string): Promise<string[]> {
    const copy = path.join(dir, 'reference');
    fs.cpSync(checkout, copy, { recursive: true, filter: (src) => !src.includes('.codegraph') });
    (await CodeGraph.init(copy, { index: true })).close();
    const { db } = createDatabase(getDatabasePath(copy), { readOnly: true });
    try {
      return db.prepare(`SELECT s.stable_key || ' ' || e.kind || ' ' || t.stable_key AS edge FROM edges e
        JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE s.file_path = ? AND e.kind != 'contains' ORDER BY edge`).all(file).map((r: { edge: string }) => r.edge);
    } finally { db.close(); }
  }

  const keyOf = (overlay: Overlay, id: string) => overlay.getNodes().find((n) => n.id === id)?.stableKey ?? `<missing ${id}>`;
  const edgesFrom = (overlay: Overlay, stableKey: string) => {
    const source = overlay.getNodeByStableKey(stableKey);
    if (!source) throw new Error(`no node ${stableKey}`);
    return overlay.getEdges({ source: source.id }).filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${keyOf(overlay, e.target)}`).sort();
  };

  it('resolves through imports: an ambiguous name, a class instantiation and the import edges', async () => {
    const wt = worktree('wt');
    await commit(wt, { 'src/use.ts': ['added',
      "import { helper } from './util2';\nimport { Widget } from './model';\nexport function use() { const w = new Widget(); w.run(); return helper(); }\n"] });
    expect(edgesFrom(wt.overlay, 'src/use.ts#function#use')).toEqual([
      'calls src/model.ts#method#Widget::run',
      'calls src/util2.ts#function#helper', // util1.ts exports a helper too: the import decides
      'instantiates src/model.ts#class#Widget',
    ]);
    expect(edgesFrom(wt.overlay, 'src/use.ts#file#src/use.ts')).toEqual(expect.arrayContaining([
      'imports src/model.ts#class#Widget', 'imports src/util2.ts#function#helper',
    ]));
    const fromFile = wt.overlay.getEdges().filter((e) => e.kind !== 'contains' && keyOf(wt.overlay, e.source).startsWith('src/use.ts#'));
    expect(fromFile.map((e) => `${keyOf(wt.overlay, e.source)} ${e.kind} ${keyOf(wt.overlay, e.target)}`).sort())
      .toEqual(await fullIndexEdges(wt.checkout, 'src/use.ts'));
  });

  it('binds a base file\'s failed refs to a symbol the overlay adds, and drops them when it goes', async () => {
    const wt = worktree('wt');
    await commit(wt, { 'src/fresh.ts': ['added', 'export function fresh() { return 1; }\n'] });
    expect(edgesFrom(wt.overlay, 'src/consumer.ts#function#consume')).toEqual(['calls src/fresh.ts#function#fresh']);
    const fromBase = wt.overlay.getEdges().filter((e) => e.metadata?.overlayBaseRef);
    expect(fromBase.map((e) => [e.layer, e.kind, keyOf(wt.overlay, e.target)]).sort()).toEqual([
      ['overlay', 'calls', 'src/fresh.ts#function#fresh'],
      ['overlay', 'imports', 'src/fresh.ts#file#src/fresh.ts'],
      ['overlay', 'imports', 'src/fresh.ts#function#fresh'],
    ]);
    // What a full index of the checkout draws from the same base file.
    expect(fromBase.map((e) => `${keyOf(wt.overlay, e.source)} ${e.kind} ${keyOf(wt.overlay, e.target)}`).sort())
      .toEqual(await fullIndexEdges(wt.checkout, 'src/consumer.ts'));

    await wt.overlay.removeFile('src/fresh.ts', wt.checkout);
    expect(wt.overlay.getEdges().filter((e) => e.metadata?.overlayBaseRef)).toEqual([]);
  });

  it('gives the same graph whichever order a commit\'s files arrive in', async () => {
    const files: Record<string, [OverlayFile['status'], string]> = {
      'src/use.ts': ['added', "import { helper, extra } from './util2';\nexport function use() { return helper() + extra(); }\n"],
      'src/util2.ts': ['modified', '// moved down\n\nexport function helper() { return 2; }\nexport function extra() { return 3; }\n'],
    };
    const graph = (overlay: Overlay) => overlay.getEdges().filter((e) => !e.dangling)
      .map((e) => `${keyOf(overlay, e.source)} ${e.kind} ${keyOf(overlay, e.target)}`).sort();
    const together = worktree('together');
    await commit(together, files);
    const forward = worktree('forward');
    await commit(forward, { 'src/use.ts': files['src/use.ts'] });
    await commit(forward, { 'src/util2.ts': files['src/util2.ts'] });
    const backward = worktree('backward');
    await commit(backward, { 'src/util2.ts': files['src/util2.ts'] });
    await commit(backward, { 'src/use.ts': files['src/use.ts'] });

    expect(edgesFrom(together.overlay, 'src/use.ts#function#use')).toEqual(['calls src/util2.ts#function#extra', 'calls src/util2.ts#function#helper']);
    expect(graph(forward.overlay)).toEqual(graph(together.overlay));
    expect(graph(backward.overlay)).toEqual(graph(together.overlay));
    expect(forward.overlay.getEdges().filter((e) => e.dangling)).toEqual([]);
  });

  it('re-resolves base edges into a module split into a package, in any commit order', async () => {
    const files: Record<string, [OverlayFile['status'], string | null]> = {
      'src/lib.ts': ['deleted', null],
      'src/lib/index.ts': ['added', "export { moveMe } from './move';\nexport function stay() { return 2; }\n"],
      'src/lib/move.ts': ['added', 'export function moveMe() { return 1; }\n'],
    };
    const fromUser = (overlay: Overlay) => overlay.getEdges().filter((e) => e.kind !== 'contains' && keyOf(overlay, e.source).startsWith('src/libuser.ts#'))
      .map((e) => `${keyOf(overlay, e.source)} ${e.kind} ${keyOf(overlay, e.target)}`).sort();
    const together = worktree('together');
    await commit(together, files);
    expect(edgesFrom(together.overlay, 'src/libuser.ts#function#useLib')).toEqual([
      'calls src/lib/index.ts#function#stay', 'calls src/lib/move.ts#function#moveMe',
    ]);
    const edges = together.overlay.getEdges().filter((e) => keyOf(together.overlay, e.source) === 'src/libuser.ts#function#useLib');
    expect(edges.every((e) => e.layer === 'overlay' && e.metadata?.overlayRebound && !e.dangling && !e.possibly_stale)).toBe(true);
    expect(fromUser(together.overlay)).toEqual(await fullIndexEdges(together.checkout, 'src/libuser.ts'));

    const forward = worktree('forward');
    await commit(forward, { 'src/lib/index.ts': files['src/lib/index.ts'], 'src/lib/move.ts': files['src/lib/move.ts'] });
    await commit(forward, { 'src/lib.ts': files['src/lib.ts'] });
    const backward = worktree('backward');
    await commit(backward, { 'src/lib.ts': files['src/lib.ts'] });
    await commit(backward, { 'src/lib/index.ts': files['src/lib/index.ts'], 'src/lib/move.ts': files['src/lib/move.ts'] });
    expect(fromUser(forward.overlay)).toEqual(fromUser(together.overlay));
    expect(fromUser(backward.overlay)).toEqual(fromUser(together.overlay));
  });

  it('re-resolves a base edge between unchanged files when the overlay adds a definition of its name', async () => {
    const wt = worktree('wt');
    expect(edgesFrom(wt.overlay, 'src/usesvc.ts#function#useSvc')).toEqual(['calls src/svc.ts#method#Svc::getDb']);
    await commit(wt, { 'src/other.ts': ['added', 'export class Other { getDb() { return 2; } }\n'] });
    const fromUseSvc = wt.overlay.getEdges().filter((e) => e.kind !== 'contains' && keyOf(wt.overlay, e.source).startsWith('src/usesvc.ts#'))
      .map((e) => `${keyOf(wt.overlay, e.source)} ${e.kind} ${keyOf(wt.overlay, e.target)}`).sort();
    expect(fromUseSvc).toEqual(await fullIndexEdges(wt.checkout, 'src/usesvc.ts'));
  });

  it('reads module config from each overlay\'s own checkout, with no memo shared between overlays', async () => {
    const tsconfig = (target: string) => JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': [`src/${target}/*`] } } });
    const alias = { 'src/alias.ts': ['added', "import { x } from '@lib/x';\nexport function viaAlias() { return x(); }\n"] as [OverlayFile['status'], string] };
    const a = worktree('wt-a', { 'tsconfig.json': tsconfig('a') });
    const b = worktree('wt-b', { 'tsconfig.json': tsconfig('b') });
    await commit(a, alias);
    await commit(b, alias);
    expect(edgesFrom(a.overlay, 'src/alias.ts#function#viaAlias')).toEqual(['calls src/a/x.ts#function#x']);
    expect(edgesFrom(b.overlay, 'src/alias.ts#function#viaAlias')).toEqual(['calls src/b/x.ts#function#x']);
    // And again in the other order, on overlays that already resolved once.
    await commit(b, alias);
    await commit(a, alias);
    expect(edgesFrom(a.overlay, 'src/alias.ts#function#viaAlias')).toEqual(['calls src/a/x.ts#function#x']);
    expect(edgesFrom(b.overlay, 'src/alias.ts#function#viaAlias')).toEqual(['calls src/b/x.ts#function#x']);
  });
});
