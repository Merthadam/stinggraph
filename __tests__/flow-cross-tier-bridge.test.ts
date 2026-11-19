/**
 * explore's Flow across services when the agent names only the two ends: a
 * page's call and the backend's repository method. The gateway handler and the
 * backend handler between them are names the agent has no way to know, so once
 * a bridge crosses a cross-tier edge it may take one more unnamed hop
 * (CROSS_TIER_EXTRA_BRIDGE). A bridge that stays inside one service keeps the
 * one-hop cap. Also covers the two edges the travella flow was missing: a JS
 * call through a parameter's default (`{ api = plansApi }`) and a FastAPI
 * `Annotated[Repo, Depends(…)]` parameter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import type { Node } from '../src/types';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cross-tier-bridge-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

const PROJECT: Record<string, string> = {
  'requirements.txt': 'fastapi\nhttpx\n',
  'package.json': JSON.stringify({ name: 'web', dependencies: { react: '^18.0.0' } }),
  'crud/repository.py': `class PlanRepository:
    def create(self, subject):
        return self.prepare(subject)

    def prepare(self, subject):
        return deep_save(subject)


class ProfileRepository:
    def create(self, subject):
        return subject


def deep_save(subject):
    return subject
`,
  'crud/api.py': `from typing import Annotated
from fastapi import APIRouter, Depends
from .repository import PlanRepository, ProfileRepository

def create_router():
    router = APIRouter(prefix="/v1/plans")

    def repository():
        yield PlanRepository()

    Repo = Annotated[PlanRepository, Depends(repository)]

    @router.post("")
    def create(repo: Repo):
        return repo.create("me")

    @router.get("/inline")
    def inline(repo: Annotated[PlanRepository, Depends(repository)]):
        return repo.create("me")

    return router


def create_profile_router():
    router = APIRouter(prefix="/v1/profile")

    def repository():
        yield ProfileRepository()

    Repo = Annotated[ProfileRepository, Depends(repository)]

    @router.post("")
    def create_profile(repo: Repo):
        return repo.create("me")

    return router
`,
  'gateway/client.py': `import httpx

class CrudClient:
    def __init__(self, base_url):
        self.base_url = base_url

    def request(self, method, path):
        with httpx.Client(base_url=self.base_url) as client:
            return client.request(method, path)
`,
  'gateway/api.py': `from fastapi import FastAPI, Request
from .client import CrudClient

def create_app(crud_client: CrudClient):
    app = FastAPI()

    @app.api_route("/v1/plans", methods=["GET", "POST"])
    async def lifecycle_proxy(request: Request):
        return crud_client.request(request.method, request.url.path)

    return app
`,
  'web/api.js': `export async function request(path, body, options = {}) {
  const response = await fetch(path, { method: options.method || (body === undefined ? 'GET' : 'POST') });
  return response.json();
}
`,
  'web/plansApi.js': `import { request } from './api';

export const plansApi = {
  create: id => request('/v1/plans', {}, { method: 'POST' }),
};
`,
  'web/PlansApp.jsx': `import React from 'react';
import { plansApi } from './plansApi';

export function PlansApp({ onDone, api = plansApi }) {
  async function createPlan() {
    const plan = await api.create('x');
    onDone(plan);
  }
  return <button onClick={createPlan}>New</button>;
}

export function Shadowed({ api = plansApi }) {
  function go() {
    const api = makeFake();
    return api.create('y');
  }
  return go();
}

export function Undefaulted({ api }) {
  return api.create('z');
}

function makeFake() {
  return {};
}
`,
  // In-process: two unnamed hops between named ends, no service boundary.
  'web/local.js': `export function start() {
  return stepOne();
}
function stepOne() {
  return stepTwo();
}
function stepTwo() {
  return finish();
}
export function finish() {
  return 1;
}
`,
};

const chainOf = (cg: CodeGraph, query: string): string[] =>
  (resolveNamedSymbolFlow(cg, query).chains[0]?.steps ?? []).map((s) => `${s.node.name}@${s.node.filePath.split('/')[0]}`);

const callees = (cg: CodeGraph, qualifiedName: string, file: string): string[] => {
  const node = cg.getNodesInFile(file).find((n: Node) => n.qualifiedName === qualifiedName);
  return node ? cg.getCallees(node.id).map((c) => c.node.qualifiedName).sort() : [];
};

describe("explore's Flow bridges two unnamed handlers across a service boundary", () => {
  it('runs from the page through the gateway and the backend handler to the named repository method', async () => {
    const cg = await indexProject(PROJECT);
    expect(chainOf(cg, 'createPlan plansApi.create PlanRepository.create')).toEqual([
      'createPlan@web',
      'create@web',
      'POST /v1/plans@gateway',
      'lifecycle_proxy@gateway',
      'POST /v1/plans@crud',
      'create@crud',
      'create@crud',
    ]);
  });

  it('allows only one extra unnamed hop after the crossing', async () => {
    const cg = await indexProject(PROJECT);
    // lifecycle_proxy, create, PlanRepository.create, prepare: four unnamed after the crossing.
    expect(chainOf(cg, 'plansApi.create deep_save')).toEqual([]);
  });

  it('keeps the one-hop cap inside one service (fan-out guard)', async () => {
    const cg = await indexProject(PROJECT);
    expect(chainOf(cg, 'start finish')).toEqual([]);
    expect(chainOf(cg, 'start stepTwo finish')).toEqual(['start@web', 'stepOne@web', 'stepTwo@web', 'finish@web']);
  });
});

describe('the edges the cross-service flow rides', () => {
  it("resolves a JS call through a parameter's default onto the default's member", async () => {
    const cg = await indexProject(PROJECT);
    expect(callees(cg, 'PlansApp::createPlan', 'web/PlansApp.jsx')).toContain('plansApi::create');
    // A local that rebinds the name, or a parameter with no default, says nothing.
    expect(callees(cg, 'Shadowed::go', 'web/PlansApp.jsx')).not.toContain('plansApi::create');
    expect(callees(cg, 'Undefaulted', 'web/PlansApp.jsx')).not.toContain('plansApi::create');
  });

  it("types a FastAPI parameter by the class its Annotated alias carries, in the alias's own scope", async () => {
    const cg = await indexProject(PROJECT);
    expect(callees(cg, 'create_router::create', 'crud/api.py')).toEqual(['PlanRepository::create']);
    expect(callees(cg, 'create_router::inline', 'crud/api.py')).toEqual(['PlanRepository::create']);
    expect(callees(cg, 'create_profile_router::create_profile', 'crud/api.py')).toEqual(['ProfileRepository::create']);
  });
});
