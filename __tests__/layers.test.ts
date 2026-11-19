/**
 * Service layers (src/graph/layers.ts): the YAML subset, inference from
 * manifests and compose run config, `.stinggraph/layers.yaml` refining it,
 * conflicts, the roll-up over a real index, the overlay's merged view, and the
 * `codegraph layers --json` shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { getDatabasePath } from '../src/db';
import { assignLayers, computeLayerRollup, computeLayers, overlayLayerSource, parseYamlSubset, UNASSIGNED } from '../src/graph/layers';
import { createOverlay, extractFile, upsertOverlayFile } from '../src/overlay';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

describe('parseYamlSubset', () => {
  it('reads block maps, `- key:` items, flow values, quotes and comments', () => {
    expect(parseYamlSubset(
      'a: 1 # c\nb:\n  - id: x\n    tags: [p, "q r", \'it\'\'s\']\n  - { id: y, inc: ["s/**"] }\n  - plain\nc: "x: y # not a comment"\nd:\n  e: f\n',
    )).toEqual({ a: 1, b: [{ id: 'x', tags: ['p', 'q r', "it's"] }, { id: 'y', inc: ['s/**'] }, 'plain'], c: 'x: y # not a comment', d: { e: 'f' } });
  });

  it('reads compose-style lists at their key\'s indent and block scalars', () => {
    expect(parseYamlSubset('services:\n  web:\n    ports:\n    - "80:80"\n    - 443\n    command: >\n      uvicorn app:api\n      --port 80\n    image: postgres:17\n'))
      .toEqual({ services: { web: { ports: ['80:80', 443], command: 'uvicorn app:api --port 80', image: 'postgres:17' } } });
  });

  it.each([
    ['an anchor', 'a: &x 1\n', /anchors/],
    ['an unterminated flow list', 'a: [1, 2\n', /unterminated/],
    ['a bad indent', 'a:\n    b: 1\n  c: 2\n', /line 3: unexpected indentation/],
    ['a duplicate key', 'a: 1\na: 2\n', /duplicate key/],
    ['a tab indent', 'a:\n\tb: 1\n', /tab/],
    ['a line that is no key', 'a: 1\njust text\n', /expected "key: value"/],
  ])('throws on %s instead of guessing', (_name, text, error) => {
    expect(() => parseYamlSubset(text)).toThrow(error);
  });
});

describe('layers', () => {
  let dir: string;
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-layers-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  /** A travella-shaped repo: python services run by compose, one image shared, a frontend package. */
  function writeMonorepo(): string[] {
    const files = [
      'services/crud/server.py', 'services/crud/routers/plans.py',
      'services/mcps/research_server.py', 'services/mcps/map_server.py', 'services/mcps/common.py', 'services/mcps/geo.py',
      'services/auth/app.py', 'services/shared/util.py', 'services/loose.py',
      'frontend/src/features/plans/Page.tsx', 'frontend/src/design-system/Button.tsx', 'frontend/src/main.tsx',
      'scripts/seed.py',
    ];
    for (const f of files) write(f, '');
    write('frontend/package.json', '{"name":"web"}');
    write('Dockerfile.auth', 'FROM python\nWORKDIR /app\nCMD ["uvicorn", "services.auth.app:app"]\n');
    write('compose.yaml', [
      'services:',
      '  postgres:',
      '    image: postgres:17.6',
      '  crud:',
      '    build: { context: ., dockerfile: Dockerfile.auth }',
      '    command: ["uv", "run", "uvicorn", "services.crud.server:app", "--port", "8001"]',
      '  research-mcp:',
      '    build: { context: ., dockerfile: Dockerfile.auth }',
      '    command: python -m services.mcps.research_server',
      '  map-mcp:',
      '    build: { context: ., dockerfile: Dockerfile.auth }',
      '    command: ["python", "-m", "services.mcps.map_server"]',
      '  auth:',
      '    build:',
      '      context: .',
      '      dockerfile: Dockerfile.auth',
      '',
    ].join('\n'));
    return files;
  }
  const imports = [
    { source: 'services/mcps/research_server.py', target: 'services/mcps/common.py' },
    { source: 'services/mcps/map_server.py', target: 'services/mcps/common.py' },
    { source: 'services/mcps/map_server.py', target: 'services/mcps/geo.py' },
  ];
  const serviceOf = (layers: ReturnType<typeof assignLayers>) => (f: string) => layers.assignments[f]!.service;

  it('infers services from compose commands, the Dockerfile CMD and manifests; shared folders split into modules', () => {
    const files = writeMonorepo();
    const layers = assignLayers(dir, files, imports);
    const of = serviceOf(layers);
    expect(layers.config).toBeNull();
    expect(layers.errors).toEqual([]);
    expect(layers.services.map((s) => [s.id, s.files])).toEqual([
      ['frontend', 3], ['auth', 1], ['crud', 2], ['mcps', 4], [UNASSIGNED, 3],
    ]);
    expect(layers.services.find((s) => s.id === 'auth')!.evidence).toEqual(['compose:auth (Dockerfile.auth CMD)']);
    expect(layers.services.find((s) => s.id === 'frontend')!.evidence).toEqual(['manifest (package.json)']);
    expect(layers.compose.find((c) => c.name === 'postgres')).toEqual({ name: 'postgres', argv: null, from: null, entry: null });
    // Each compose service's module is its entry plus what only it imports; `common.py` both import stays a folder module.
    expect(layers.assignments['services/mcps/map_server.py']).toEqual({ service: 'mcps', module: 'map-mcp' });
    expect(layers.assignments['services/mcps/geo.py']).toEqual({ service: 'mcps', module: 'map-mcp' });
    expect(layers.assignments['services/mcps/research_server.py']).toEqual({ service: 'mcps', module: 'research-mcp' });
    expect(layers.assignments['services/mcps/common.py']).toEqual({ service: 'mcps', module: '(root)' });
    expect(layers.assignments['frontend/src/features/plans/Page.tsx']).toEqual({ service: 'frontend', module: 'features' });
    for (const f of ['services/shared/util.py', 'services/loose.py', 'scripts/seed.py']) expect(of(f)).toBe(UNASSIGNED);
  });

  it('a declared layers.yaml refines inference: labels, excludes, glob and compose modules', () => {
    const files = writeMonorepo();
    write('.stinggraph/layers.yaml', [
      'version: 1',
      'services:',
      '  - id: connector',
      '    label: Connector service',
      '    aliases: [mcp, connectors]',
      '    include: ["services/mcps/**"]',
      '    modules:',
      '      - { id: research, compose: research-mcp }',
      '  - id: portal',
      '    label: Portal',
      '    include: ["frontend/**"]',
      '    exclude: ["frontend/src/design-system/**"]   # library code',
      '    modules:',
      '      - { id: plans, include: ["frontend/src/features/plans/**"] }',
    ].join('\n'));
    const layers = assignLayers(dir, files, imports);
    const of = serviceOf(layers);
    expect(layers.errors).toEqual([]);
    expect(layers.config).toBe('.stinggraph/layers.yaml');
    expect(layers.services.map((s) => [s.id, s.origin, s.files])).toEqual([
      ['connector', 'declared', 4], ['portal', 'declared', 2], ['auth', 'inferred', 1], ['crud', 'inferred', 2], [UNASSIGNED, 'unassigned', 4],
    ]);
    const connector = layers.services[0]!;
    expect(connector).toMatchObject({ label: 'Connector service', aliases: ['mcp', 'connectors'], evidence: ['refines inferred mcps'] });
    expect(layers.assignments['services/mcps/research_server.py']).toEqual({ service: 'connector', module: 'research' });
    // Not declared as a module, so the inferred compose module still holds.
    expect(layers.assignments['services/mcps/map_server.py']).toEqual({ service: 'connector', module: 'map-mcp' });
    expect(layers.assignments['frontend/src/features/plans/Page.tsx']).toEqual({ service: 'portal', module: 'plans' });
    // The declared exclude wins over the inferred `frontend` it replaced.
    expect(of('frontend/src/design-system/Button.tsx')).toBe(UNASSIGNED);
  });

  it('reports a file two services match and leaves it unassigned', () => {
    const files = writeMonorepo();
    write('.stinggraph/layers.yaml', 'version: 1\nservices:\n  - id: a\n    include: ["services/**"]\n  - id: b\n    include: ["services/crud/**"]\n');
    const layers = assignLayers(dir, files, imports);
    const conflicts = layers.errors.filter((e) => e.candidates);
    expect(conflicts.map((e) => e.source)).toEqual(['services/crud/routers/plans.py', 'services/crud/server.py']);
    expect(conflicts[0]!.candidates).toEqual(['a', 'b']);
    expect(layers.assignments['services/crud/server.py']!.service).toBe(UNASSIGNED);
    expect(layers.assignments['services/auth/app.py']!.service).toBe('a');
  });

  it('reports an invalid config and falls back to inference rather than half-applying it', () => {
    const files = writeMonorepo();
    write('.stinggraph/layers.yaml', 'version: 1\nservices:\n  - id: a\n    includes: ["services/**"]\n  - id: a\n    include: x\n');
    const layers = assignLayers(dir, files, imports);
    expect(layers.config).toBeNull();
    expect(layers.errors.map((e) => e.message)).toEqual([
      'services[0]: unknown key "includes"',
      'service "a" needs a non-empty include',
      'duplicate service id "a"',
    ]);
    expect(layers.services.map((s) => s.id)).toContain('mcps');
  });

  it('reports a compose file it cannot read and keeps the manifest services', () => {
    const files = writeMonorepo();
    write('compose.yaml', 'x-common: &common\n  image: a\nservices:\n  web:\n    <<: *common\n');
    const layers = assignLayers(dir, files, imports);
    expect(layers.errors).toEqual([{ source: 'compose.yaml', message: expect.stringMatching(/could not read compose services: line 1: anchors/) }]);
    expect(layers.services.map((s) => s.id)).toEqual(['frontend', UNASSIGNED]);
  });

  describe('over a real index', () => {
    beforeEach(async () => {
      write('packages/api/package.json', '{"name":"api"}');
      write('packages/api/src/server.ts', "import { formatName, Greeter } from '../../lib/src/names';\nexport function serve() { return formatName(new Greeter().hi()); }\n");
      write('packages/api/src/server.test.ts', "import { formatName } from '../../lib/src/names';\nexport function check() { return formatName('x'); }\n");
      write('packages/lib/package.json', '{"name":"lib"}');
      write('packages/lib/src/names.ts', 'export function formatName(n: string) { return n.trim(); }\nexport class Greeter { hi() { return "hi"; } }\n');
      write('compose.yaml', 'services:\n  api:\n    command: node packages/api/src/server.ts\n');
      (await CodeGraph.init(dir, { index: true })).close();
    });

    it('rolls edges up between services with a per-kind breakdown, and finds entry points', async () => {
      const cg = await CodeGraph.open(dir);
      try {
        const layers = cg.getLayers();
        expect(layers.services.map((s) => [s.id, s.files])).toEqual([['api', 2], ['lib', 1], [UNASSIGNED, 1]]); // compose.yaml is indexed
        const api = layers.services[0]!;
        expect(api.evidence).toEqual(['manifest (package.json)', 'compose:api (command)']);
        expect(api.entryPoints).toEqual([
          { kind: 'compose', name: 'api', file: 'packages/api/src/server.ts' },
          { kind: 'handler', name: 'serve', file: 'packages/api/src/server.ts', line: 2 },
        ]);
        const all = cg.getLayerRollup({ layers });
        expect(all.edges).toEqual([{ from: 'api', to: 'lib', total: 9, synthesized: 0, byKind: { imports: 5, calls: 3, instantiates: 1 } }]);
        const noTests = cg.getLayerRollup({ layers, excludeTests: true });
        expect(noTests.edges).toEqual([{ from: 'api', to: 'lib', total: 6, synthesized: 0, byKind: { imports: 3, calls: 2, instantiates: 1 } }]);
        expect(cg.getLayerRollup({ level: 'module', layers }).edges.map((e) => [e.from, e.to])).toEqual([['api/(root)', 'lib/(root)']]);
      } finally {
        cg.close();
      }
    });

    it('reads a worktree overlay\'s merged view, with the worktree\'s own layers.yaml', async () => {
      const checkout = path.join(dir, '..', path.basename(dir) + '-wt');
      fs.cpSync(dir, checkout, { recursive: true, filter: (src) => !src.includes('.codegraph') });
      try {
        const overlay = createOverlay(path.join(checkout, '.codegraph', 'overlay.db'), getDatabasePath(dir), { worktreeId: 'wt', branch: 'wt', baseCommit: 'c0', headCommit: 'c0' });
        try {
          const file = 'packages/web/src/app.ts';
          const content = "import { formatName } from '../../lib/src/names';\nexport function app() { return formatName('w'); }\n";
          fs.mkdirSync(path.join(checkout, 'packages/web/src'), { recursive: true });
          fs.writeFileSync(path.join(checkout, 'packages/web/package.json'), '{"name":"web"}');
          fs.writeFileSync(path.join(checkout, file), content);
          fs.mkdirSync(path.join(checkout, '.stinggraph'));
          fs.writeFileSync(path.join(checkout, '.stinggraph/layers.yaml'), 'version: 1\nservices:\n  - id: portal\n    label: Portal\n    include: ["packages/web/**"]\n');
          await upsertOverlayFile(overlay, { path: file, status: 'added', blobId: 'b1' }, await extractFile(file, content), checkout);

          const source = overlayLayerSource(overlay);
          const layers = computeLayers(checkout, source);
          expect(layers.services.map((s) => [s.id, s.origin, s.files])).toEqual([['portal', 'declared', 1], ['api', 'inferred', 2], ['lib', 'inferred', 1], [UNASSIGNED, 'unassigned', 1]]);
          const rollup = computeLayerRollup(layers, source.fileEdgeCounts(), { excludeTests: true });
          expect(rollup.edges.map((e) => [e.from, e.to, e.byKind])).toEqual([
            ['api', 'lib', { imports: 3, calls: 2, instantiates: 1 }],
            ['portal', 'lib', { imports: 2, calls: 1 }],
          ]);
        } finally {
          overlay.close();
        }
      } finally {
        fs.rmSync(checkout, { recursive: true, force: true });
      }
    });

    it('`codegraph layers --json` prints services, errors, compose runs and the roll-up', () => {
      const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
      const out = execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, bin, 'layers', dir, '--json', '--level', 'module'], {
        encoding: 'utf-8', env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const json = JSON.parse(out);
      expect(Object.keys(json)).toEqual(['config', 'services', 'errors', 'compose', 'rollup']);
      expect(json.config).toBeNull();
      expect(json.services.map((s: { id: string }) => s.id)).toEqual(['api', 'lib', UNASSIGNED]);
      expect(json.compose).toEqual([{ name: 'api', argv: ['node', 'packages/api/src/server.ts'], from: 'command', entry: 'packages/api/src/server.ts' }]);
      expect(json.rollup).toMatchObject({ level: 'module', excludeTests: false, edges: [{ from: 'api/(root)', to: 'lib/(root)' }] });
    });
  });
});
