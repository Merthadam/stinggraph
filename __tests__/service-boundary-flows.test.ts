/**
 * A request crossing services: a page's fetch wrapper onto a FastAPI gateway,
 * the gateway's proxy onto the backend that serves the same path, a service's
 * httpx call onto another's route, and an MCP client's tool call onto the
 * server's `@mcp.tool()` function — and explore's Flow riding them through
 * each route to its handler.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import type { Edge, Node } from '../src/types';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-service-flows-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

const meta = (e: Edge): Record<string, unknown> => (e.metadata as Record<string, unknown> | undefined) ?? {};

/** Synthesized edges by `synthesizedBy`, as `source → target` (target route name or function name). */
function synthesized(cg: CodeGraph, by: string): Array<{ from: string; to: string; meta: Record<string, unknown> }> {
  const out: Array<{ from: string; to: string; meta: Record<string, unknown> }> = [];
  const nodes = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')];
  for (const n of nodes) {
    for (const e of cg.getOutgoingEdgesFrom([n.id])) {
      if (meta(e).synthesizedBy !== by) continue;
      const t = cg.getNode(e.target) as Node;
      out.push({ from: n.qualifiedName, to: `${t.name} @${t.filePath}`, meta: meta(e) });
    }
  }
  return out.sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
}

const routeNames = (cg: CodeGraph, file: string): string[] =>
  cg.getNodesInFile(file).filter((n) => n.kind === 'route').map((n) => n.name).sort();

describe('FastAPI routes', () => {
  it('takes each route prefix from the APIRouter declared in its own factory function', async () => {
    const cg = await indexProject({
      'requirements.txt': 'fastapi\n',
      'crud/api.py': `from fastapi import APIRouter

def create_router():
    router = APIRouter(prefix="/v1/plans")

    @router.post("")
    def create():
        return {}

    @router.get("/{plan_id}")
    def read(plan_id: str):
        return {}

    return router


def create_profile_router():
    router = APIRouter(prefix="/v1/profile")

    @router.get("")
    def get_profile():
        return {}

    return router
`,
    });
    expect(routeNames(cg, 'crud/api.py')).toEqual(['GET /v1/plans/{plan_id}', 'GET /v1/profile', 'POST /v1/plans']);
  });

  it('extracts api_route as one route per listed method, GET when none is listed', async () => {
    const cg = await indexProject({
      'requirements.txt': 'fastapi\n',
      'gw/api.py': `from fastapi import FastAPI, Request

app = FastAPI()

@app.api_route("/v1/plans", methods=["GET", "POST"])
@app.api_route("/v1/plans/{suffix:path}", methods=["PUT"])
async def plans(request: Request):
    return {}

@app.api_route("/health")
def health():
    return {}
`,
    });
    expect(routeNames(cg, 'gw/api.py')).toEqual(['GET /health', 'GET /v1/plans', 'POST /v1/plans', 'PUT /v1/plans/{suffix:path}']);
    const plans = cg.getNodesByKind('function').find((n) => n.name === 'plans')!;
    const handlerOf = cg.getNodesInFile('gw/api.py').filter((n) => n.kind === 'route' && n.name.includes('/v1/plans'))
      .map((r) => cg.getOutgoingEdgesFrom([r.id]).filter((e) => e.kind === 'references').map((e) => e.target));
    expect(handlerOf).toEqual([[plans.id], [plans.id], [plans.id]]);
  });
});

const GATEWAY_PROJECT: Record<string, string> = {
  'requirements.txt': 'fastapi\nhttpx\n',
  'package.json': JSON.stringify({ name: 'web', dependencies: { react: '^18.0.0' } }),
  'crud/api.py': `from fastapi import APIRouter
from .repository import save

def create_router():
    router = APIRouter(prefix="/v1/plans")

    @router.get("")
    def list_plans():
        return []

    @router.post("")
    def create():
        return save()

    @router.get("/{plan_id}/agent-context")
    def agent_context(plan_id: str):
        return {}

    return router
`,
  'crud/repository.py': 'def save():\n    return {}\n',
  'items_a/api.py': 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/v1/items")\ndef items_a():\n    return []\n',
  'items_b/api.py': 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/v1/items")\ndef items_b():\n    return []\n',
  'gateway/client.py': `import httpx

class CrudClient:
    def __init__(self, base_url):
        self.base_url = base_url

    def request(self, method, path):
        with httpx.Client(base_url=self.base_url) as client:
            return client.request(method, path)
`,
  'gateway/api.py': `from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool
from .client import CrudClient

def create_app(crud_client: CrudClient):
    app = FastAPI()

    @app.api_route("/v1/plans", methods=["GET", "POST"])
    @app.api_route("/v1/plans/{suffix:path}", methods=["GET", "POST", "DELETE"])
    async def lifecycle_proxy(request: Request):
        def forward():
            return crud_client.request(
                request.method,
                request.url.path,
            )
        return await run_in_threadpool(forward)

    @app.get("/v1/items")
    async def items_proxy(request: Request):
        return crud_client.request(request.method, request.url.path)

    @app.get("/v1/session")
    async def session(request: Request):
        return {"path": request.url.path}

    return app
`,
  'web/api.js': `export async function request(path, body, options = {}) {
  const response = await fetch(path, { method: options.method || (body === undefined ? 'GET' : 'POST') });
  return response.json();
}
`,
  'web/plans.js': `import { request } from './api';

export function createPlan() {
  return request('/v1/plans', {}, {});
}

export function postPlan() {
  return request('/v1/plans', {}, { method: 'POST' });
}
`,
  'agent/reader.py': `import httpx

class Reader:
    def __init__(self, base_url):
        self.base_url = base_url

    async def context(self, plan_id):
        async with httpx.AsyncClient(timeout=10) as client:
            return await client.get(f"{self.base_url}/v1/plans/{plan_id}/agent-context")

    async def plans(self):
        async with httpx.AsyncClient(timeout=10) as client:
            return await client.get(f"{self.base_url}/v1/plans")
`,
};

describe('Requests across a gateway', () => {
  it('links a route handler that forwards the incoming path onto the one backend route with its method and path', async () => {
    const cg = await indexProject(GATEWAY_PROJECT);
    const proxied = synthesized(cg, 'http-proxy');
    // Not the `{suffix:path}` catch-all, not `/v1/items` (two backends serve it),
    // and not `session`, which reads the path without forwarding it.
    expect(proxied.map((e) => `${e.from} → ${e.to}`)).toEqual([
      'create_app::lifecycle_proxy → GET /v1/plans @crud/api.py',
      'create_app::lifecycle_proxy → POST /v1/plans @crud/api.py',
    ]);
    expect(proxied[1]!.meta).toMatchObject({
      channel: 'http-proxy', tier: 'server→server', method: 'POST', href: '/v1/plans',
      callee: 'crud_client.request', registeredAt: 'crud/api.py:11',
    });
  });

  it("sends a page's same-origin call through the gateway's proxy route, not straight to the backend", async () => {
    const cg = await indexProject(GATEWAY_PROJECT);
    const client = synthesized(cg, 'http-client').filter((e) => e.from === 'createPlan' || e.from === 'postPlan');
    expect(client.map((e) => `${e.from} → ${e.to} ${String(e.meta.method)}`)).toEqual([
      // The wrapper computes its method: one hop onto the one registration serving the path.
      'createPlan → GET /v1/plans @gateway/api.py GET|POST',
      'postPlan → POST /v1/plans @gateway/api.py POST',
    ]);
    expect(client.every((e) => e.meta.gateway === true && e.meta.callee === 'request')).toBe(true);
  });

  it("pairs a service's httpx call by its path tail, and leaves a path both the gateway and the backend serve alone", async () => {
    const cg = await indexProject(GATEWAY_PROJECT);
    const reader = synthesized(cg, 'http-client').filter((e) => e.from.startsWith('Reader::'));
    expect(reader.map((e) => `${e.from} → ${e.to}`)).toEqual(['Reader::context → GET /v1/plans/{plan_id}/agent-context @crud/api.py']);
    expect(reader[0]!.meta).toMatchObject({ tier: 'server→server', method: 'GET', href: '/v1/plans/${…}/agent-context' });
  });

  it("explore's Flow runs from the page through each route to the backend handler", async () => {
    const cg = await indexProject(GATEWAY_PROJECT);
    const steps = resolveNamedSymbolFlow(cg, 'postPlan lifecycle_proxy create save').chains[0]?.steps.map((s) => s.node.name);
    expect(steps).toEqual(['postPlan', 'POST /v1/plans', 'lifecycle_proxy', 'POST /v1/plans', 'create', 'save']);
  });
});

describe('MCP tool calls', () => {
  const MCP_PROJECT: Record<string, string> = {
    'requirements.txt': 'mcp\n',
    'mcps/maps.py': `from mcp.server.fastmcp import FastMCP

maps = FastMCP("maps")

@maps.tool()
async def search_places(query: str) -> dict:
    return {}

@maps.tool(name="place_details")
async def details(place_id: str) -> dict:
    return {}

@maps.tool()
async def shared() -> dict:
    return {}
`,
    'mcps/other.py': `from mcp.server.fastmcp import FastMCP

other = FastMCP("other")

@other.tool()
def shared() -> dict:
    return {}
`,
    'agent/client.py': `class MapsClient:
    async def call(self, name, arguments):
        tool_name = name
        return await self.session.call_tool(tool_name, arguments)
`,
    'agent/observer.py': `class Observer:
    async def _call(self, name, arguments):
        return await self.client.call(name, arguments)

    async def find(self):
        return await self._call("search_places", {"query": "x"})

    async def detail(self):
        return await self.client.call(
            "place_details", {},
        )

    async def either(self):
        return await self.client.call("shared", {})

    async def chosen(self, name):
        return await self._call(name, {})


async def direct(session):
    return await session.call_tool("search_places", {})
`,
  };

  it('links a literal tool name, through any wrapper of call_tool, onto the one server function registered as it', async () => {
    const cg = await indexProject(MCP_PROJECT);
    const tools = synthesized(cg, 'mcp-tool');
    expect(tools.map((e) => `${e.from} → ${e.to}`)).toEqual([
      'direct → search_places @mcps/maps.py',
      'Observer::detail → details @mcps/maps.py',
      'Observer::find → search_places @mcps/maps.py',
    ]);
    expect(tools[2]!.meta).toMatchObject({
      channel: 'mcp', tier: 'client→server', tool: 'search_places', callee: 'self._call', registeredAt: 'mcps/maps.py:5',
    });
  });
});
