/**
 * Overlays get what a full index adds after per-file extraction: framework
 * extractors (route nodes), the synthesis passes over the merged graph
 * (src/overlay/merged-resolver.ts), with base synthesized edges into hidden
 * files left out. Each case is checked against a full index of the checkout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { getDatabasePath } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { createOverlay, detectOverlayFrameworks, extractFile, type Overlay, type OverlayFile } from '../src/overlay';

const BASE_FILES: Record<string, string> = {
  'requirements.txt': 'fastapi\n',
  'api/app.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n',
  'web/Child.jsx': 'export function Child() {\n  return <div>child</div>;\n}\n',
  'web/Parent.jsx': "import { Child } from './Child';\n\nexport function Parent() {\n  return <Child />;\n}\n",
};

describe('overlay framework extraction and synthesis', () => {
  let dir: string;
  let project: string;
  let baseDb: string;
  let checkout: string;
  let overlay: Overlay;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overlay-synth-'));
    project = path.join(dir, 'project');
    for (const [file, content] of Object.entries(BASE_FILES)) write(project, file, content);
    (await CodeGraph.init(project, { index: true })).close();
    baseDb = getDatabasePath(project);
    checkout = path.join(dir, 'wt');
    fs.cpSync(project, checkout, { recursive: true, filter: (src) => !src.includes('.codegraph') });
    overlay = createOverlay(path.join(checkout, '.codegraph', 'overlay.db'), baseDb, { worktreeId: 'wt', branch: 'wt', baseCommit: 'c0', headCommit: 'c0' });
  });

  afterEach(() => {
    overlay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(root: string, file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }

  /** One commit: the checkout gets the files, the overlay their extraction with the project's frameworks. */
  async function commit(files: Record<string, [OverlayFile['status'], string | null]>) {
    for (const [file, [, content]] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(checkout, file));
      else write(checkout, file, content);
    }
    const frameworksFor = detectOverlayFrameworks(checkout);
    return overlay.upsertFiles(await Promise.all(Object.entries(files).map(async ([file, [status, content]]) => ({
      file: { path: file, status },
      extraction: content === null ? { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 }
        : await extractFile(file, content, undefined, frameworksFor(file)),
    }))), checkout);
  }

  const keyOf = (id: string) => overlay.getNodes().find((n) => n.id === id)?.stableKey ?? `<missing ${id}>`;
  const mergedEdges = () => overlay.getEdges().filter((e) => e.kind !== 'contains')
    .map((e) => `${keyOf(e.source)} ${e.kind} ${keyOf(e.target)}`).sort();

  /** Every non-`contains` edge of a full index of a copy of the checkout, by stable key. */
  async function fullIndexEdges(): Promise<string[]> {
    const copy = path.join(dir, 'reference');
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(checkout, copy, { recursive: true, filter: (src) => !src.includes('.codegraph') });
    (await CodeGraph.init(copy, { index: true })).close();
    const { db } = createDatabase(getDatabasePath(copy), { readOnly: true });
    try {
      return db.prepare(`SELECT s.stable_key || ' ' || e.kind || ' ' || t.stable_key AS edge FROM edges e
        JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind != 'contains' ORDER BY edge`)
        .all().map((r: { edge: string }) => r.edge);
    } finally { db.close(); }
  }

  it('extracts route nodes from an overlay file with the frameworks a full index detects', async () => {
    expect(overlay.getNodes({ kind: 'route' }).map((n) => n.layer)).toEqual(['base']);
    await commit({ 'api/app.py': ['modified',
      BASE_FILES['api/app.py'] + '\n\n@app.post("/items")\ndef create_item():\n    return {}\n'] });
    const routes = overlay.getNodes({ kind: 'route' });
    expect(routes.map((n) => [n.layer, n.name])).toEqual([['overlay', 'GET /health'], ['overlay', 'POST /items']]);
    const create = overlay.getNodeByStableKey('api/app.py#function#create_item')!;
    expect(overlay.getEdges({ target: create.id, kind: 'references' }).map((e) => e.source))
      .toEqual([routes.find((n) => n.name === 'POST /items')!.id]);
    expect(mergedEdges()).toEqual(await fullIndexEdges());
  });

  it('draws a synthesized edge from an added overlay component, as a full index does', async () => {
    const stats = await commit({ 'web/Page.jsx': ['added', "import { Child } from './Child';\n\nexport function Page() {\n  return <Child />;\n}\n"] });
    expect(stats.synthesis.ran).toBe(true);
    const page = overlay.getNodeByStableKey('web/Page.jsx#function#Page')!;
    const child = overlay.getNodeByStableKey('web/Child.jsx#function#Child')!;
    const synthesized = overlay.getEdges({ source: page.id, target: child.id }).filter((e) => e.metadata?.synthesizedBy);
    expect(synthesized).toMatchObject([{ layer: 'overlay', kind: 'calls' }]);
    expect(mergedEdges()).toEqual(await fullIndexEdges());
  });

  it('redraws a base synthesized edge into a modified file, and drops it when the target is deleted', async () => {
    const synthesizedInto = (stableKey: string) => overlay.getEdges().filter((e) => e.metadata?.synthesizedBy && keyOf(e.target) === stableKey);
    expect(synthesizedInto('web/Child.jsx#function#Child')).toMatchObject([{ layer: 'base' }]);

    await commit({ 'web/Child.jsx': ['modified', '// shifted\n\n' + BASE_FILES['web/Child.jsx']] });
    const child = overlay.getNodeByStableKey('web/Child.jsx#function#Child')!;
    expect(child.layer).toBe('overlay');
    // Base-sourced, redrawn by the synthesis over the merged graph; the base edge is hidden.
    expect(synthesizedInto('web/Child.jsx#function#Child')).toMatchObject([{ layer: 'overlay', target: child.id }]);
    expect(overlay.getEdges().filter((e) => e.possibly_stale || e.dangling)).toEqual([]);
    expect(mergedEdges()).toEqual(await fullIndexEdges());

    await commit({ 'web/Child.jsx': ['deleted', null] });
    expect(overlay.getEdges().filter((e) => e.metadata?.synthesizedBy)).toEqual([]);
    expect(overlay.getEdges().filter((e) => e.possibly_stale || e.dangling)).toEqual([]);
    expect(mergedEdges()).toEqual(await fullIndexEdges());
  });

  it("with synthesis off, a base synthesized edge into a hidden file falls back to the stable-key remap", async () => {
    write(checkout, 'web/Child.jsx', '// shifted\n\n' + BASE_FILES['web/Child.jsx']);
    const content = fs.readFileSync(path.join(checkout, 'web/Child.jsx'), 'utf8');
    const stats = await overlay.upsertFiles([{ file: { path: 'web/Child.jsx', status: 'modified' }, extraction: await extractFile('web/Child.jsx', content) }],
      checkout, { synthesis: 'off' });
    expect(stats.synthesis.ran).toBe(false);
    expect(stats.fallbackEdges).toBe(1);
    const child = overlay.getNodeByStableKey('web/Child.jsx#function#Child')!;
    expect(overlay.getEdges().filter((e) => e.metadata?.synthesizedBy)).toMatchObject([{ layer: 'base', target: child.id, possibly_stale: true }]);
  });
});
