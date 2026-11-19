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

  const PLANS = 'def as_utc(value):\n    return value\n\n\nclass PlanRepository:\n    def fetch(self, plan_id):\n        return plan_id\n\n\ndef make_repo():\n    return PlanRepository()\n';

  it('does not link a service whose module the package reaches only for a helper beside the class', async () => {
    const out = await calls({
      ...BASE,
      'services/auth/plans.py': PLANS,
      'services/crud/canvas.py': 'from services.auth.plans import as_utc\n\n\ndef run(plan):\n    as_utc(plan)\n    return plan.fetch("revision")\n',
    }, 'run');
    expect(out).toEqual(['function:as_utc']);
  });

  it('keeps the guess when a helper imported from the module hands out the class', async () => {
    const out = await calls({
      ...BASE,
      'services/auth/plans.py': PLANS,
      'services/crud/canvas.py': 'from services.auth.plans import make_repo\n\n\ndef run(plan, key):\n    return plan.fetch(key)\n',
    }, 'run');
    expect(out).toEqual(['method:PlanRepository::fetch']);
  });
});

describe('a Python guess by method name on a local that is evidently a builtin value', () => {
  const STORE_PKG = {
    'pyproject.toml': '[project]\nname = "mono"\n',
    'app/__init__.py': '',
    'app/plans.py': 'class PlanRepository:\n    def get(self, plan_id):\n        return plan_id\n\n    def items(self):\n        return []\n',
    // A class `Plan` is what lets `plan.get` past the builtin-method filter.
    'app/models.py': 'class Plan:\n    pass\n',
  };
  const caller = (body: string, sig = 'subject') =>
    `from app.plans import PlanRepository\n\n\ndef read(${sig}) -> dict[str, int]:\n    return {}\n\n\ndef handle(${sig}):\n${body}`;

  it.each([
    ['a dict literal', '    plan = {"revision": 1}\n    return plan.get("revision")\n'],
    ['a multi-line dict literal', '    plan = {\n        "revision": 1,\n    }\n    return plan.get("revision")\n'],
    ['dict(...)', '    plan = dict(revision=1)\n    return plan.get("revision")\n'],
    ['model_dump()', '    plan = subject.model_dump(mode="json")\n    return plan.get("revision")\n'],
    ['json()', '    plan = subject.json()\n    return plan.get("revision")\n'],
    ['json.loads()', '    plan = json.loads(subject)\n    return plan.get("revision")\n'],
    ['a dict annotation', '    plan: dict[str, int] = load(subject)\n    return plan.get("revision")\n'],
    ['a same-file function annotated -> dict', '    plan = read(subject)\n    return plan.get("revision")\n'],
  ])('does not link a local bound to %s', async (_label, body) => {
    const out = await calls({ ...STORE_PKG, 'app/service.py': caller(body) }, 'handle');
    expect(out.filter((c) => c.startsWith('method:'))).toEqual([]);
  });

  it('does not link a parameter annotated as a Mapping', async () => {
    const out = await calls({
      ...STORE_PKG,
      'app/service.py': caller('    return plan.get("revision")\n', 'plan: Mapping[str, int], subject'),
    }, 'handle');
    expect(out).toEqual([]);
  });

  it('keeps the guess on a local the project constructs', async () => {
    const out = await calls({
      ...STORE_PKG,
      'app/service.py': caller('    plan = make_repo(subject)\n    return plan.get("revision")\n'),
    }, 'handle');
    expect(out).toEqual(['method:PlanRepository::get']);
  });
});
