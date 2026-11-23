# Service layers: named levels above the file

Status: **config-only layers implemented** (per the spike's recommendation): `src/graph/layers.ts`,
`CodeGraph.getLayers` / `getLayerRollup`, `codegraph layers`. Nothing is stored and `codegraph_explore`
is untouched; the storage and explore-scoping sections below remain design only.

## Problem

The graph's hierarchy stops at the file. `contains` edges give file → class → method, but nothing
above a file has a node, so two things are missing:

1. **Views can't zoom out.** Stingray views have flat groups only. There is no "system → service →
   module → file → symbol" ladder to drill down through, and nothing rolls 40 calls between two
   folders up into one edge.
2. **Agents can't use the names people use.** A user asks about "the agent service" or "the
   connector"; the agent passes those words to `codegraph_explore`, they match no symbol, and are
   dropped. The agent then Greps a folder to find out what the service is.

## Levels

| Level | Meaning | Source (default, no config) |
|---|---|---|
| L0 system | repo / workspace | repo root |
| L1 service | a deployable or runnable unit | manifests and run config (below) |
| L2 module | a feature area inside a service | first folder level under the service's source root |
| L3 file | file | `file` nodes (exists) |
| L4 symbol | class / function / route / component | `contains` from file (exists) |
| L5 member | method / field | `contains` from class (exists) |

Fixed ladder, not free nesting: every node has exactly one parent at each level above it. A file
outside every service belongs to an implicit `(unassigned)` service so totals still add up.

## Where names come from

Deterministic, in this order; a later source refines an earlier one, never contradicts it.

1. **Inferred.** Workspace packages (`package.json` workspaces, `pnpm-workspace.yaml`,
   Cargo/Go workspaces), roots of `pyproject.toml` / `package.json` / `go.mod`, and
   `compose.yaml` services — resolved through their `command` / entrypoint module path, not their
   Dockerfile, since one image is often shared (travella builds every Python service from
   `Dockerfile.auth`). Inferred names are the folder or compose name (`crud`, `mcps`).
   **Folder fallback.** Without a usable `layers.yaml`, files no inferred service covers — all of
   them in a single-package repo, since the root manifest is L0, not a service — are grouped by
   folder: starting at the repo root and stepping down while everything sits in one folder with
   nothing loose beside it (a lone `src/`), each subfolder becomes a service (evidence `folder
   fallback: …`), and files loose at that level (below the root) one named after their folder.
   Tests, `scripts/`, `docs/`, examples, fixtures, dot-folders and files directly in the root stay
   `(unassigned)`. A folder whose name another service has keeps its path as id.
2. **Declared.** `.stinggraph/layers.yaml` (committed; `.codegraph/` is gitignored as a whole, so config can't live there) gives human names, aliases, merges and
   module splits. This is where "CRUD backend" comes from — the code never says it.

```yaml
version: 1
services:
  - id: crud
    label: CRUD backend
    aliases: [backend, data service, crud api]
    include: ["services/crud/**"]
  - id: agent
    label: Agent service
    aliases: [agent, agent runtime]
    include: ["services/agent/**"]
  - id: connector
    label: Connector service
    aliases: [connectors, mcp, mcps, research mcp, map mcp]
    include: ["services/mcps/**"]
  - id: portal
    label: Portal
    aliases: [frontend, web app, ui]
    include: ["frontend/**"]
    exclude: ["frontend/src/design-system/**"]   # library code: left out for now
    modules:
      - { id: plans, label: Plans, include: ["frontend/src/features/plans/**"] }
  - id: auth
    label: Auth service
    include: ["services/auth/**"]
# services/shared and frontend/src/design-system are library code and stay (unassigned) for now.
```

Compose services that share one folder become L2 modules of that folder's service by default:
`research-mcp` and `map-mcp` → modules of the Connector service, each covering the module its
`command` runs (`services.mcps.research_server`, `services.mcps.map_server`) plus what only it
imports.

Globs use the same dialect as view scopes. A file matching two services is a config error, reported
by `codegraph status`, never resolved silently. A service's `exclude:` removes files from it.

## Storage

- New node kinds `service` and `module` (or `module` reused for L2 — decide during the spike),
  with `contains` edges service → module → file. Ids are `service:<id>` / `module:<service>/<id>`,
  so `stable_key` stays meaningful across re-indexes.
- Labels and aliases go into `nodes_fts` like any other name, so search finds them.
- Roll-up edges are **not stored**. They are a query: group `calls` / `references` / `imports`
  / cross-tier edges by the endpoints' L1 or L2 ancestor and count them. Storing them would add a
  second thing to keep in sync on every incremental sync and in the overlay.
- Overlay: layers are recomputed over the merged view, so a branch shows up at every level
  ("2 files changed in Agent service"). A branch that edits `layers.yaml` gets its own layers.

## How agents use it (no new tool)

Per the project's rule — adapt the tool to the agent — this only changes what the tools already
called do with the words they already receive:

- **`codegraph_explore` scoping.** A query token or phrase matching a service/module label or alias
  narrows symbol matching to that subtree. `agent service planTrip` picks the agent's `planTrip`, not
  the portal's. The token is consumed, not searched as a symbol.
- **Service-only queries.** A query that is only a service name returns its entry points (routes,
  compose command target, exported handlers, queue consumers), its outbound roll-up edges and its
  inbound callers — the "tour" the agent otherwise builds by reading the folder.
- **Confidence gate.** Only exact label/alias matches (case- and separator-insensitive) count.
  Generic words (`api`, `core`, `app`, `service`) never scope on their own. No match → today's
  behaviour, unchanged. Silent beats wrong.
- `codegraph_node` and the CLI print the service/module a symbol belongs to in its header.

## Views

Stingray views get a `hierarchy` mode: start at L1, click a node to expand it in place to its
children, edges re-aggregate at the visible level. Existing `group:` stays as is. This part is
Stingray-side and can follow once the engine exposes levels and the roll-up query.

## Eval (must pass before anything ships)

Methodology per `docs/AGENTS.md`: deterministic probes first, then agent A/B.

**Repos**
- travella (`origin/main`): 4 named services + auth + shared library; Python + React.
- one medium real monorepo with workspace packages and no `layers.yaml` (tests inference alone).
- one control repo with no service structure (express) — must be byte-identical with and without.

**Prompts** — per repo, ≥5 that name a service or module, ≥5 that don't. Travella examples:
1. How does the portal create a plan and get it stored by the CRUD backend?
2. What does the agent service call in the connector service during research?
3. What breaks in the portal if I change the CRUD backend's plan summary schema?
4. How does the auth service validate a token before the CRUD backend serves a request?
5. Where does the agent service read a traveler's profile from?
Controls: the same flows phrased with symbol names only.

**Arms**: baseline (no layers) · inferred only · inferred + `layers.yaml`.

**Measures**: Read/Grep count, codegraph call count, wall clock, answer correctness (graded
against a hand-written answer key per prompt), and for probes: is the right symbol picked, is the
expected flow in explore's Flow section.

**Pass bar**: on named-service prompts, fewer Read/Grep and equal-or-better correctness than
baseline; on control prompts and the control repo, no change. If inferred-only doesn't help, the
feature ships config-only.

## Decisions

1. L2 reuses the existing `module` kind; layer modules are told apart by their `module:` id prefix
   and a `metadata.layer = 'module'` flag, since some extractors already emit language modules.
2. Config lives in `.stinggraph/layers.yaml`, committed at the repo root; the engine reads it and
   Stingray views read the same file.
3. Library code (`services/shared`, `design-system`) is left out for now — `(unassigned)`.
4. Compose services sharing a folder become L2 modules of one service (`research-mcp`, `map-mcp`
   under the Connector service).

## Spike results (deterministic probes only, travella `origin/main` 20b0b34)

Scripts: `scripts/layers-eval/` (`layers.ts` assignment + inference, `prompts.ts` prompts and
answer keys, `probe.ts` explore arms + roll-up). Output: `/tmp/layers-eval-results/`
(`layers.md`, `probe.md`, `explore-<prompt>.txt` with every arm's raw output). Index: 394 files,
6,510 nodes. The `layers.yaml` used is the example above, except `research mcp` / `map mcp` moved
from Connector-service aliases to two declared modules (`Research MCP`, `Map MCP`, one file each).
No `src/` changes and no agent runs.

### Inference vs `layers.yaml`

375/394 files get the same L1 service both ways. Per service, inferred precision / recall:
crud, agent, connector (`mcps`), auth 100% / 100%. Portal (`frontend`) 89.9% / 100%: the 19
`frontend/src/design-system/**` files, which only the config's `exclude:` knows about. Both ways leave
`services/shared`, the 8 loose `services/*.py` modules, `scripts/` and 2 root files unassigned.

- Compose `command` resolution does what the doc says: `crud`, `agent`, `research-mcp` and `map-mcp`
  resolve through `uvicorn services.x.y:app` / `python -m services.x.y`. `auth` has no `command`,
  so inference uses the `CMD` of the Dockerfile it builds, which is what compose runs. The frontend
  is found from `frontend/package.json` and not from compose.
- Inferred modules: `research-mcp` and `map-mcp` each come out as only their entry file, because
  every other file they import is imported by both. That matches the declared modules. Inference
  can't produce the declared `portal/plans` module. Its default L2 is the first folder under
  `frontend/src`, which is `features`.
- Inference only gets folder names (`crud`, `mcps`, `frontend`). "CRUD backend", "connector" and
  "portal" have to come from config.

### Explore scoping (simulated)

5 prompts name a service (N1–N5, the doc's list). The 5 controls (C1–C5) ask about the same flows
using the same symbol bag without the service words. Each has a hand-written answer key of 6–8
symbols, 36 in total. Arm A is today's explore. Arm B simulates scoping from `layers.yaml`. B-inf
simulates scoping from inferred names only.

| | key symbols in output | key symbols in Flow | off-target-service files | output chars |
|---|---|---|---|---|
| named, A | 16/36 | 0 | 1 (1.4K chars) | 110,876 |
| named, B | 18/36 | 0 | 0 | 118,837 |
| named, B-inf | 18/36 | 0 | 0 | 117,379 |
| controls, A = B = B-inf | 14/36 | 0 | 3 (10.7K chars) | 113,668 |

- **Controls are unaffected.** No alias matched, so the query and the output were byte-identical
  (`probe.ts` asserts this). explore was also deterministic across repeated runs.
- **The gain is 2 symbols, both from qualifying a token:**
  - N5: `handle` → `AgentTurnService.handle`.
  - N2: `call` → `MapsClient.call …`, which surfaced `_MapsObserver._call`.
  - N4 dropped the agent's `app.py` (the other `identity_dependency`) and one file, losing no key
    symbol.
  - N1 and N3 didn't change.
- **One wrong narrowing.** In N3, `summary` was rewritten to the portal's
  `AccountSettingsPage.summary`. It is in scope, but it has nothing to do with the plan summary.
  An exact-name match inside the right service can still be the wrong symbol.
- **Ambiguity is low once tests are excluded.** Of 22 distinct query tokens that name a symbol, only 4 have more
  than one non-test definition in the repo:
  - `create`: 4
  - `call`: 3 (34 including test doubles)
  - `identity`: 2
  - `identity_dependency`: 2

  Words like `plan`, `research` and `read` match only test helpers. Wrong-service picks were not
  what kept the agent from the answer.
- **What kept explore short was missing edges between services.** The Flow section was empty in
  every arm. 2-node chains (`handle → CrudContextReader.profile`) don't render as Flow, and every
  longer flow crosses a hop that has no edge:
  - portal `request('/v1/plans')` → auth `@app.api_route("/v1/plans")`. That route isn't
    extracted as a route.
  - The auth proxy → CRUD and the agent `CrudContextReader.profile` → CRUD. CRUD routes lose their
    function-scoped `APIRouter(prefix=…)` and are indexed as `POST:` / `GET:`.
  - Agent `MapsClient.call("search_places")` → the `@map_mcp.tool()` handlers.
  - The index has 0 cross-tier synthesized edges.

  The symbols missing in every arm are exactly the far side of these hops: the map/travel MCP
  tools, `lifecycle_proxy` / `CrudClient.request`, `get_traveler_profile`, and the portal
  consumers of `destination_summary`.
- Alias collisions with symbol names: `backend` (one test helper) and `Plans` (`create_router.plans`).
  Both are harmless here, but they show that one-word aliases can collide with symbol names.

### Service-only query and roll-up

The roll-up is one SQL statement over `edges`. It joins a file→service map passed as JSON
(`json_each`) and groups cross-service edges by the service of each endpoint's file. It took
~0.5 s on this index, which is acceptable for a spike. A real implementation would keep the map
in a table.

- **"connector service":** 13 MCP tool handlers (5 map, 2 research, 6 travel) and 2 compose
  targets. Inbound: agent 61 edges. Outbound: agent 36 (shared contracts), auth 33, unassigned 21,
  crud 2. Today, `explore("connector service")` returns 20K chars across 5 files, none of them in
  the Connector service.
- **"agent service":** 8 routes and compose target `services/agent/app.py`. Outbound: unassigned
  146, crud 132, connector 61, auth 35. Inbound: connector 36, auth 17, crud 11. Today's explore
  shows 2 of 5 files from the service.
- **The roll-up also shows mis-bound edges.** 57 non-test `calls` edges cross a service boundary
  through `instance-method` name resolution, and all 57 are wrong. Examples:
  - CRUD's SQLAlchemy `self.session.get` → auth's `SessionStore.get` (×20)
  - `sqlite3` / SQLAlchemy `db.execute` / `session.execute` → auth's `_DatabaseCompat.execute` (×22)
  - auth `store.delete` → the agent's `InMemoryCheckpointStore.delete` (×8)
  - an agent `plan.get` on a dict → CRUD's `PlanRepository.get` (×3)

  The `auth`/`crud` counts in the roll-up are inflated by these edges.

### Caveats

- **This is a simulation.** Scoping was simulated as a query rewrite: alias phrases removed, and an
  ambiguous exact-name token replaced by the qualified names of its in-scope non-test
  definitions. A real implementation would also narrow full-text hits, file admission and blast
  radius, so arm B understates both the help and the harm.
  - Module-level duplicates could only be expressed as `stem.fn` (`auth.identity_dependency`),
  which explore resolves only loosely.
- **The sample is small and hand-written.** It is one repo, 5+5 prompts, and queries and answer
  keys I wrote by hand. Small wording changes move the output by several thousand chars (an
  earlier run with duplicated rewritten tokens changed N2's results). A ±2-symbol difference is
  within that noise.
- **Not measured:** agent behaviour (Read/Grep, call count, wall clock), the doc's second repo
  (a monorepo with only inference) and the express control repo.

### Recommendation

- **Don't build `codegraph_explore` service scoping.** On the prompts it was designed for, it moved
  2 of 36 key symbols, never produced a Flow, and made one wrong narrowing. The words agents add
  ("agent service", "CRUD backend") didn't hurt today's explore: named prompts found 16/36 key
  symbols against 14/36 for the controls.
- **Config-only for layers.** Keep the L1/L2 assignment (inference first, `layers.yaml` for
  exclusions, human names and module splits) and the roll-up query as data for Stingray views.
  Inference alone was 100% on the four backend services.
- **The engine-side lever this spike points to is coverage, not scoping:**
  - FastAPI function-scoped `APIRouter(prefix=…)` and `api_route` routes
  - HTTP client → route tier edges between Python services
  - MCP `call_tool(name)` → `@<server>.tool()` dispatch
  - not letting `instance-method` name matching cross a service boundary the source file doesn't
    import
- **The one scoping idea worth an agent A/B later** is the service-only summary. Agents already
  send "connector service", and today that query returns nothing from the service.
