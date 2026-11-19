/**
 * A Python method call on a receiver nothing types is guessed by the method's
 * name alone. The guess never lands in a module the calling package cannot
 * load: one no module in the caller's directory reaches through its imports.
 * In a monorepo crud's `self.session.get(…)` on a SQLAlchemy session went to
 * auth's `SessionStore.get`. A module the package imports, at any depth, or
 * wires in from a sibling (dependency injection) keeps the guess.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function calls(files: Record<string, string>, fromName: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-reach-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('method').concat(cg.getNodesByKind('function')).find((n) => n.name === fromName)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.qualifiedName}`)
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const STORE = 'class SessionStore:\n    def get(self, key):\n        return key\n\n    def execute(self, sql):\n        return sql\n';
const CANVAS = 'class Canvas:\n    def __init__(self, session):\n        self.session = session\n\n    def load(self, key):\n        return self.session.get(key)\n';
const BASE = {
  'pyproject.toml': '[project]\nname = "mono"\n',
  'services/__init__.py': '',
  'services/auth/__init__.py': '',
  'services/auth/session_store.py': STORE,
  'services/crud/__init__.py': '',
};

describe('a Python guess by method name out of the calling package\'s reach', () => {
  it('does not link another service\'s method the caller\'s package never imports', async () => {
    const out = await calls({
      ...BASE,
      'services/crud/canvas.py': CANVAS,
      'services/crud/checkout.py': 'def run(db):\n    return db.execute("select 1")\n',
    }, 'load');
    expect(out).toEqual([]);
  });

  it('does not link a plain local receiver either', async () => {
    const out = await calls({
      ...BASE,
      'services/crud/checkout.py': 'def run(db):\n    return db.execute("select 1")\n',
    }, 'run');
    expect(out).toEqual([]);
  });

  it('keeps the guess when the file imports the target module', async () => {
    const out = await calls({
      ...BASE,
      'services/crud/canvas.py': `from services.auth.session_store import SessionStore\n\n\n${CANVAS}`,
    }, 'load');
    expect(out).toEqual(['method:SessionStore::get']);
  });

  it('keeps the guess when a sibling module wires the target in', async () => {
    const out = await calls({
      ...BASE,
      'services/crud/canvas.py': CANVAS,
      'services/crud/app.py': 'from services.auth.session_store import SessionStore\nfrom .canvas import Canvas\n\ncanvas = Canvas(SessionStore())\n',
    }, 'load');
    expect(out).toEqual(['method:SessionStore::get']);
  });

  it('keeps the guess when the target is reached through an imported module', async () => {
    const out = await calls({
      ...BASE,
      'services/auth/__init__.py': 'from .session_store import SessionStore\n',
      'services/crud/canvas.py': `from services.auth import SessionStore\n\n\n${CANVAS}`,
    }, 'load');
    expect(out).toEqual(['method:SessionStore::get']);
  });
});
