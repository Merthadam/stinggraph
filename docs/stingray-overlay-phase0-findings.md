# Stingray overlay: Phase 0 findings

This covers steps 4–5 of `docs/stingray-overlay-handoff.md`. It ends at the review gate before Phase 1.
Nothing is committed. The measurements were taken on 2026-11-16 against the uncommitted tree on top of
`932a7fab`.

**Short version:** ATTACH works, the stable keys work, and the merged view works. Every remapped
`possibly_stale` edge that the reference also draws was correct (9,572 of 9,573 distinct edges across
all runs). On a 1,858-file repo, an overlay update is 3–42× faster than a full index. The large
remaining gap is **resolution**: the merged view misses 0.1–36% of a full index's edges, and
80–100% of those misses come from the overlay's unique-name resolver. That resolver also adds a
few wrong edges. Phase 1 should replace it with upstream
resolution, scoped to the changed files, before Stingray trusts overlay edges.

**Update (Reco 1, §10):** done. Overlays now resolve with the upstream `ReferenceResolver` over the
merged view. On the same six pairs, no remaining missing or extra edge is attributable to the
resolver. What is left is framework route nodes and synthesizers (gap 2), base edges into moved
or hidden files (gap 3), and whole-graph drift. Sections 4–9 describe the state before that change
unless they say otherwise.

**Update (Reco 2 & 3, §11):** done. Overlay extraction runs the frameworks a full index of the
head checkout detects, the synthesis passes run over the merged graph, and base edges into hidden
files (plus base edges whose target name the overlay adds or removes) are re-resolved from their
refs. On all six pairs the merged view now equals the full index of H: **0 missing and 0 extra
nodes and edges**, no `possibly_stale` or `dangling` rows left. The price is time on large repos:
the whole-graph synthesis costs 1.3–1.8 s on this repo whatever the overlay's size, so the 11-file
update goes from 0.43 s to about 2 s and the 104-file one from 5.6 s to 8.2–8.9 s (a full index is
8.9–9.3 s). `synthesis: 'off'` takes that back (0.8 s / 6.6–7.5 s) at the cost of the synthesized
edges.

## 1. What was built (API summary)

Everything new is in `src/overlay/` and is re-exported from `src/index.ts`. Extraction still goes
through `engine()`, so the read path stays light.

| Export | What it does |
|---|---|
| `extractFile(path, content, language?, frameworkNames?)` | Parses bytes supplied by the caller (from `git show`), with no DB and no filesystem read. It now applies the indexer's 1 MiB cap (see §6). Since §11 it runs the framework extractors named by `detectOverlayFrameworks(projectRoot)`. |
| `resolveScoped(db, filePaths, projectRoot)` | Runs upstream `ReferenceResolver.resolveAndPersist` on the pending refs of `filePaths` in **one** DB. Overlays do not use it; they use `resolveOverlayMerged` (§10). |
| migration v17 / `schema.sql` | Adds `nodes.stable_key` with an index, and `files.git_blob_id`. A fresh index and a migrated one use the same column order. |
| `recomputeStableKeys`, `setGitBlobIds`, `setBaseInfo` / `getBaseInfo` | Key maintenance. Stamp blob ids and `base_commit` / `base_ref` / `layer_kind=base`. |
| `createOverlay(path, baseDb, meta)` / `openOverlay` | Creates or opens an overlay. Each worktree has its own SQLite file with the upstream table shapes plus `layer_meta` and `overlay_files`, and the base is ATTACHed read-only. Creation is exclusive (`wx`). |
| `Overlay.getNodes / getNodeByStableKey / searchNodes / getEdges` | The merged view. It applies the hiding rule, remaps base edges into hidden files by `stable_key` and flags them `possibly_stale`, and flags `dangling` when no match exists. |
| `Overlay.upsertFile` / **`Overlay.upsertFiles`** (new in this step) | Writes one commit's changed files in one transaction and resolves **once** after all rows are in. Since §10 both take `projectRoot`, the worktree checked out at the head commit. Since §11 they are async, take `{ synthesis }` and return `OverlayUpdateStats`. |
| `Overlay.removeFile`, `setHeadCommit`, `getMeta` | Ownership row removal (also takes `projectRoot` since §10). `head_commit` is written last. |
| `findConflicts(baseDb, overlayPaths)` | Reports file conflicts, symbol conflicts, `mainMoved` and `unverifiable`. |
| `whoOwns(baseDb, overlayPaths, stableKeyOrPath)` | Returns the worktree(s) that own a path, or the file that holds a symbol. Ownership is file-level by design. |

New eval scripts are in `scripts/overlay-eval/` (run them after `npm run build`; they load `dist/`):

- `compare.ts --repo R --base B --head H [--out f.json] [--keep]` builds the base index of B with blob
  ids and base info, builds the overlay for H from git only, builds a reference full index of H, and
  diffs the result. It prints JSON and a summary, and attributes each difference to a cause.
- `conflicts.ts <travella clone>` creates three synthetic branches in the clone and builds three
  overlays over one base. It prints `findConflicts` and `whoOwns` output.
- Run both as `npx tsx --tsconfig scripts/overlay-eval/tsconfig.json …`. The root `tsconfig.json`
  maps `web-tree-sitter` to `src/web-tree-sitter.d.ts` through `paths`. tsx applies that mapping at
  runtime, so `require('web-tree-sitter')` gets an empty module and `Parser.init` crashes. `npm run
  eval` (`npx tsx __tests__/evaluation/runner.ts`) is probably affected the same way. I did not
  check that or change it.

## 2. The stable_key rule and how it fails

`stable_key = file_path # kind # COALESCE(qualified_name, name)`. The first duplicate has no suffix,
and later duplicates get `#1`, `#2`, … in `(start_line, start_column, id)` order. The key is computed
in SQL by one function. The migration, every node writer in `queries.ts`, and the bulk-index end
(`endBulkParseLoad`) all use it.

Measured: on a 1,858-file repo, inserting a line at the top of N files changed no stable keys.
`possibly_stale` remaps were confirmed by the reference index in 196/196 and 9,327/9,328 cases.

Known failure modes:

| Case | Effect | Seen in eval |
|---|---|---|
| Overloads or repeated names reordered, or one inserted before another | Ordinals swap, so base edges remap to the wrong overload, or a symbol conflict is reported on the wrong ordinal. | Not hit (Python and TS repos). Expect it in Java, C#, C++ and Kotlin. |
| Class or namespace renamed | Every member's `qualified_name` changes, so all base edges into it go `dangling`, and conflicts show a remove plus an add. | — |
| File renamed or moved (`R`), or a module split into a package | The path is part of the key, so every key changes. Base edges into the old path go `dangling`. | travella-split: `claude.py` → `claude/` package gave 42 dangling rows (35 distinct), and the reference drew 35 edges to the new files. |
| Anonymous or synthetic names (lambdas, `<anonymous>`, framework route names) | The key is only as stable as the extractor's naming. Route qualified names include the file path. | — |

## 3. ATTACH findings

- **Read-only attach works with a URI:** `ATTACH 'file:///abs/base.db?mode=ro' AS base` under
  `node:sqlite`. Writes to `base.*` fail with `SQLITE_READONLY`, as tested in
  `overlay-merged-view.test.ts`. SQLite enforces this, not the query layer.
- **The overlay is `main` and the base is `base`.** The merged view is two TEMP views:
  `hidden_files` and `merged_nodes` (a UNION ALL with explicit column lists). `SELECT *` must not be
  used, because migrated bases append `stable_key` while fresh ones list it last. The two are now
  equal, but explicit columns keep it safe.
- **Overlay `edges` has no FKs.** Endpoints are validated in code (`insertEdge`), and source and
  target cleanup is explicit.
- **The 10-ATTACH limit:** `findConflicts` and `whoOwns` open the base read-only and attach **one
  overlay at a time**, then DETACH it. Tests cover 12 overlays. Cost: 3 overlays on Travela took
  2–5 ms. Batching 9 at a time is possible but not needed at this scale.
- **Query-plan trap (fixed, see §6):** a lookup on the merged view with `language = ?` used
  `idx_nodes_language` on the overlay branch and scanned every overlay node of that language for
  each ref. Hot predicates on the views need checking with `EXPLAIN QUERY PLAN`.
- A base in WAL mode still needs its `-shm` file (or write access to its directory) to be read with
  `mode=ro`. If Stingray ever puts the base on a read-only mount, use `immutable=1` and only while
  the base indexer is not running.

## 4. Correctness: merged view (base B plus overlay H) vs full index of H

Edges are compared as distinct `(source stable_key, target stable_key, kind)` triples, and nodes as
stable keys. Nothing is excluded. Every difference is assigned to exactly one cause by
`compare.ts`.

Travela, `/tmp/travella-eval` (clone; the original was not touched). Three Travela pairs plus one
extra: `main10` is 10 commits on `main`, where nearly the whole tree is new. `phase2` is the
phase-2 merge. `unify` includes 2 renames and 15 deletes. `split` turns a module into a package and
includes a rename. The self-repo runs use a clone of this repo at `932a7fab`.

| pair | changed (A/M/D/R) | ref nodes | missing nodes | ref edges | missing edges | extra edges | `possibly_stale` rows (confirmed distinct) | `dangling` rows |
|---|---|---|---|---|---|---|---|---|
| travella `HEAD~10..HEAD` | 145 (135/8/2/0), 39 parsed | 451 | 24 (5.3%), all FastAPI `route` | 926 | 330 (35.6%) | 61 | 0 | 0 |
| travella `2cf7a9c..c53745d` | 29 (26/3/0/0), 14 parsed | 451 | 8 (1.8%), `route` | 926 | 105 (11.3%) | 33 | 0 | 0 |
| travella `e137466~3..e137466` | 69 (24/28/15/2), 24 parsed | 2,622 | 28 (1.1%), `route` | 5,507 | 540 (9.8%) | 108 | 53 (44/44) | 2 |
| travella `0ee3d86~3..0ee3d86` | 26 (17/6/2/1), 18 parsed | 1,426 | 3 (0.2%), `route` | 2,892 | 171 (5.9%) | 68 | 5 (5/5) | 42 |
| codegraph `HEAD~5..HEAD` | 11 (6/5/0/0), 10 parsed | 38,667 | 0 | 90,864 | 97 (0.11%) | 34 | 226 (196/196) | 0 |
| codegraph `HEAD~40..HEAD` | 104 (47/57/0/0), 101 parsed | 38,667 | 0 | 90,864 | 5,371 (5.9%) | 414 | 13,281 (9,327/9,328) | 0 |

Missing edges by kind: the largest groups are `imports` (133 / 46 / 223 / 105 / 25 / 1,435) and
`calls`. By provenance, nearly all are `null` (resolved by the upstream resolver). The only
heuristic ones are synthesized: 3 `jsx-render` on travella main10, and 19 `interface-impl` plus 1
`event-emitter` on codegraph-40.

Causes. A count of 0 is left blank, and the columns follow the row order of the table above.

| cause | main10 | phase2 | unify | split | cg-5 | cg-40 |
|---|---|---|---|---|---|---|
| **missing:** a changed file's ref left unresolved by the overlay's name fallback | 267 | 73 | 411 | 112 | 88 | 4,848 |
| **missing / extra:** same endpoints, but a different kind (Python `Foo()` drawn as `calls` instead of `instantiates`, or a TS file node's `imports` edge skipped beside a `calls`) | 60 / 60 | 32 / 32 | 127 / 93 | 24 / 23 | 9 / – | 503 / 18 |
| **missing:** synthesized edges (synthesizers are not run on overlays) | 3 | | | | | 20 |
| **missing:** unchanged base file → changed file; the base edge pointed at the old path | | | 2 | 35 | | |
| **extra:** `dangling` base edge (target key gone, e.g. a moved module) | | | 2 | 35 | | |
| **extra:** wrong edge from name fallback | 1 | 1 | 13 | 10 | | 368 |
| **extra:** unchanged → unchanged base edge that the H index no longer draws (resolution context moved) | | | | | 34 | 27 |
| **extra:** `possibly_stale` remap that is wrong | | | | | | 1 |

Concrete examples:
- **Name fallback skips imports and anything ambiguous.**
  `services/agent/app.py#file → services/auth/config.py#class#CognitoConfig imports` is missing.
  The overlay never resolves `imports` refs, and it gives up on any name with two candidates.
- **Name fallback picks the wrong target.** In `__tests__/bundle-launcher.test.ts#function#stage`,
  `String(…)` became `calls → src/resolution/ambient-modules.ts#enum_member#Kind::String` because
  that name is unique in the project. Upstream knows `String` is a builtin.
- **Kind.** `services/agent/app.py#function#create_app → …#class#CognitoJwtVerifier` is
  `instantiates` in the reference and `calls` in the overlay. Upstream promotes `calls` to a class
  into `instantiates` at resolution time (`resolution/index.ts`).
- **Relinking.** After `claude.py` became the `claude/` package,
  `services/agent/tests/test_agent_api.py#file → services/agent/claude.py#class#ClaudeGatewayAdapter`
  is `dangling`. The reference points at `services/agent/claude/adapter.py#class#ClaudeGatewayAdapter`.
- **Frameworks.** All the missing nodes are FastAPI `route` nodes from `services/auth/api.py` and
  `services/crud/api.py`. Overlay extraction does not run framework `extract` or `postExtract`.

Conflict sanity check (`conflicts.ts`). The base was Travela `main`. Branch a edits `api.py`,
`repository.py` and `README.md`, and adds a file. Branch b shifts every line of `api.py` and edits
`frontend/src/api.js`. Branch c starts before `services/crud` existed, appends to `api.py`, and adds
its own `services/crud/repository.py`.
- **File conflicts:** `services/auth/api.py` [a,b,c] and `services/crud/repository.py` [a,c]. Correct.
- **mainMoved:** `services/crud/repository.py` [c] (it was added on both sides). Correct. c's
  `api.py` is not reported, which is also correct because main never changed it.
- **unverifiable:** `README.md` [a]. Before the fix in §6 it was a false `mainMoved`.
- **Symbol conflicts:** only 16 FastAPI `route` keys [a,b,c]. These are noise: the overlay has no
  route nodes, so every overlay that touches `api.py` looks as if it removed every route. Both a and
  b edited the body of `create_app` (a nested `def health`/`register` line), yet it is **not**
  reported. The `SAME_SHAPE` shortcut misses edits that keep the same length (this limitation was
  already documented).
- **`whoOwns`:** `api.py#function#create_app::health` → [a,b,c] (file-level, by design).
  `frontend/src/api.js#function#request` → [b]. An untouched file → [].

## 5. Time and size

Single runs on an Apple Silicon laptop, Node 24.21. The overlay update covers `git diff`, `git show`
per file, extraction, writes, resolution and `head_commit`.

| pair | base full index | overlay update (extract / write+resolve) | reference full index | overlay vs full |
|---|---|---|---|---|
| travella main10 | 0.29 s | 0.42 s (0.33 / 0.06) | 0.43 s | ~1× (nearly the whole tree changed) |
| travella phase2 | 0.49 s | 0.19 s (0.13 / 0.02) | 0.33 s | 1.7× faster |
| travella unify | 1.27 s | 0.34 s (0.23 / 0.06) | 0.90 s | 2.6× faster |
| travella split | 0.79 s | 0.22 s (0.16 / 0.02) | 0.56 s | 2.5× faster |
| codegraph HEAD~5 | 8.43 s | 0.21 s (0.13 / 0.04) | 8.77 s | **42× faster** |
| codegraph HEAD~40 | 8.40 s | 3.46 s (1.97 / 1.45) | 9.96 s | 2.9× faster |

Before the two fixes in §6, the codegraph HEAD~40 overlay update took **70.4 s**, which is 7× slower
than a full index. Fixing the merged-view plan alone brought it to 10.5 s with per-file upserts.
Batching alone brought it to 29.2 s. With both fixes it takes 3.5–4.0 s.

| pair | base .db | overlay .db | reference .db | overlay rows (files / nodes / edges / unresolved) |
|---|---|---|---|---|
| travella main10 | 0.19 MB | 1.50 MB | 1.55 MB | 145 / 427 / 732 / 1,622 |
| travella phase2 | 1.11 MB | 0.59 MB | 1.55 MB | 29 / 139 / 246 / 500 |
| travella unify | 9.68 MB | 1.67 MB | 8.89 MB | 69 / 508 / 766 / 1,920 |
| travella split | 4.46 MB | 0.68 MB | 4.61 MB | 26 / 203 / 269 / 568 |
| codegraph HEAD~5 | 147.4 MB | 0.70 MB | 147.6 MB | 11 / 133 / 226 / 704 |
| codegraph HEAD~40 | 142.6 MB | 26.9 MB | 147.6 MB | 104 / 5,538 / 14,216 / 38,926 |

- An empty overlay is 0.2 MB (schema plus FTS).
- Overlays are heavy for each changed file because refs the fallback cannot resolve stay in
  `unresolved_refs`. On codegraph HEAD~40 that is 38.9k of them.
- For 5 worktrees on the codegraph repo, the shared base plus overlays is about 148 MB + 5 × (0.7–27
  MB). Five full indexes would be about 5 × 148 MB.

Cost of v17 on upstream code paths. Before = clean `932a7fab` (`/tmp/cg-base/dist`), after = this
tree. Each sync inserts a line at the top of N `src/*.ts` files and is repeated 3 times.

| codegraph repo | before | after |
|---|---|---|
| full index | 8.0–9.6 s | 7.9–9.2 s |
| sync, 1 file | 1.75–1.78 s | 1.68–1.75 s |
| sync, 20 files | 2.62–3.03 s | 2.58–2.83 s |
| sync, 100 files | 4.19–4.91 s | 4.20–4.79 s |
| DB size (codegraph / Travela) | 148.3 MB / 1.55 MB | 154.8 MB / 1.63 MB (+4.4% / +4.7%) |

The per-write stable-key recompute in `queries.ts` has no measurable cost on sync at this scale. The
cost is the column plus its index, about 4.5% of DB size.

## 6. Bugs found and fixed in this step (each with a test)

1. **Results depended on upsert order, and edges dangled after multi-file updates.** If file A was
   upserted before file B, A's refs resolved against B's base rows. Once B was upserted, those base
   rows were hidden, and the edge went `dangling` while the ref was already deleted. In the first
   eval this caused 22 and 5 false dangling edges on travella unify and split (dangling rows went
   from 30 to 2 and from 47 to 42; the remaining ones are real base edges). Fix in
   `Overlay.resolveScoped`: overlay-resolved edges whose target is no longer visible are reopened as
   refs, and pending overlay refs that name any overlay symbol are retried.
   Test: `overlay-merged-view.test.ts` › "a multi-file update resolves the same whichever file is
   upserted first". It fails without the fix.
2. **Overlay updates were quadratic in the number of changed files.** Resolution re-ran over every
   ref naming an overlay symbol on every upsert. Fix: `Overlay.upsertFiles(entries)` writes one
   commit in one transaction and resolves once, which is what the handoff's "one transaction per
   update" describes. `upsertFile` is now a one-entry call to it.
   Test: "upsertFiles writes a whole commit and resolves it once".
3. **Bad query plan in the merged-view name lookup.** Writing `language = ?` made SQLite drive the
   overlay branch through `idx_nodes_language`. The predicate is now `+language = ?`. Behavior is
   unchanged and the existing tests cover it.
4. **`extractFile` ignored the indexer's 1 MiB cap.** A 1.7 MB file (`name-matcher.ts`) produced
   2,245 nodes and 8k edges that a full index never has, and took 6 s to write. It now returns the
   indexer's `size_exceeded` warning and no rows.
   Test: `overlay-extract.test.ts` › "skips a file over the indexer size cap".
5. **`findConflicts` reported a false `mainMoved` for paths the base never indexes** (README,
   lockfiles). They now go to `unverifiable`. Main-deleted source files, which the overlay did
   extract, are still `mainMoved`.
   Test: `overlay-conflicts.test.ts` › main-moved state (6).

`npx vitest run __tests__/overlay-*.test.ts` passes 20/20.

## 7. Gaps, ranked by impact

1. **Done in §10.** The unique-name fallback is gone. It accounted for 80–100% of missing edges
   and all the wrong ones. Overlays now run the upstream `ReferenceResolver` over the merged view.
   Follow-ups that §10 leaves open are listed there as gaps 1a–1d.
2. **Done in §11.** Framework extraction and the synthesis passes now run for overlays. Route
   nodes are there, the route noise in symbol conflicts is gone, and the synthesized edges match.
   What §11 leaves open is listed there.
3. **Done in §11.** Base edges into hidden files are re-resolved from their refs and stored as
   `overlayRebound` overlay edges; the base edges are hidden. `possibly_stale` and `dangling` are
   now only a fallback.
4. **Symbol conflicts miss edits of the same length** (the `SAME_SHAPE` shortcut). The test showed
   that two worktrees editing `create_app`'s body are not reported.
   *Fix:* store a per-node body hash (`content_hash` over the node's byte span) in both layers at
   extraction, and compare hashes.
5. **Done in §11.** The 27–34 base → base edges were all one cause: H adds a second `getDb`
   method, which makes `db.getDb()` in unchanged files ambiguous in a full index. Upstream sync's
   definition-delta rebind (CG-33) now runs for overlays and removes them.
6. **Extraction cost per file.** Each file runs one `git show`. Extraction (`git show` plus parse)
   is about 57% of the update time on codegraph HEAD~40.
   *Fix:* use one `git cat-file --batch` process per update.
7. **Overlay size.** Unresolved refs dominate it. Gap 1 did not shrink it: refs that upstream
   cannot resolve are parked as `failed`, as in a full index, so a later update can retry them
   (29.2k rows on codegraph HEAD~40, against 38.9k before). Also consider not storing
   `nodes_fts` for overlays under about 100 files and using LIKE instead.

## 8. Risks

- **Stable-key recompute on writes.** No regression was measured on sync (1, 20 and 100 files) or
  on full index. Two paths remain unmeasured: `updateNode` (framework postExtract renames) and
  `deleteNode`. They do a `SELECT file_path` plus a per-file window query for each call, and could
  show up on a framework-heavy repo (NestJS prefixing many routes). Measure on a large NestJS or
  Laravel repo before upstreaming. A cheap fix is to batch them at the end of the postExtract pass.
- **Key churn on Java, C# and C++ overloads** (§2). Edges flagged `possibly_stale` must stay
  visually tentative in Stingray until gap 3 is done.
- **Base advancing under open overlays.** `openOverlay` attaches whatever base file exists. If the
  base indexer rewrites it in place (WAL), readers stay consistent per statement, but the overlay's
  `base_commit` can trail the base. Stingray must compare the overlay's `base_commit` with
  `getBaseInfo()` on open and rebuild the overlay when they differ (a cheap operation: 0.2–3.5 s).
- **Upstream rebase surface.** The edits to upstream files are `migrations.ts`, `schema.sql`,
  `queries.ts` (3 hooks), `db/index.ts`, `engine.ts`, `index.ts` and the vitest alias. Each is
  small, but `queries.ts` and `schema.sql` change often upstream.
- The handoff's `resolveScoped(db, filePaths)` export (upstream resolver, single DB) is still not
  what overlays use. Since §10 overlays use `resolveOverlayMerged`, which wraps the same upstream
  call. `resolveScoped` stays for single-DB callers.

## 9. Phase 1 proposal: Stingray integration behind a setting

**Setting:** `codegraph.sharedBase` (default off). When it is off, Stingray keeps today's behavior:
one full `<worktree>/.codegraph/codegraph.db` per worktree.

When it is on:
1. **Base indexer (one per repo, in Stingray's main process).**
   - Keeps a clean detached worktree at `origin/main`, for example
     `<stingray-data>/bases/<repo-id>/`, and its `.codegraph/codegraph.db`.
   - On fetch, when `origin/main` moved, it runs `sync` (or a full index on first run), then
     `setGitBlobIds(git ls-tree -r)`, then `setBaseInfo`. This is the only base writer.
   - Promotion as in the handoff comes after gap 1. For Phase 1, re-sync the base and let the
     overlays rebuild.
2. **Per-worktree overlay (`<worktree>/.codegraph/overlay.db`).**
   - On a commit in the worktree or when a worktree is created,
     Stingray computes `merge-base origin/main HEAD`.
     - If the base's `base_commit` differs, it waits for or triggers the base indexer, then
       **recreates** the overlay. This is cheap; incremental base-change handling waits for Phase 2.
     - Otherwise it runs `git diff --name-status -M mb..HEAD`, extracts each changed file with
       `extractFile(git show)`, calls `upsertFiles`, drops files that went back to base content
       (`removeFile`), and calls `setHeadCommit`. `compare.ts`'s `buildOverlay` is the reference
       implementation to lift.
   - The worker runs off the UI thread, and there is one overlay writer per worktree.
3. **Queries.**
   - Stingray's `codegraph-api.ts` reads through `Overlay` for the worktree's graph:
     `getNodes`, `getEdges` (render `possibly_stale` dashed, `dangling` hidden or ghosted),
     `searchNodes`, and `getNodeByStableKey`.
   - Conflicts come from `findConflicts(baseDb, managedOverlayPaths)` on each overlay update.
     Show file conflicts and `mainMoved` first, and symbol conflicts only after gap 4, or with
     `route` keys filtered out.
   - Agent warnings use `whoOwns`.
4. **Fallback.** Stingray falls back to the full per-worktree index for that worktree, logs the
   reason, and keeps the setting on for the others, in these cases:
   - a schema-version or overlay-version mismatch, or a failed ATTACH;
   - a base that is missing or out of date for longer than a timeout;
   - an overlay update that throws;
   - more than about 300 changed files, where an overlay stops paying off (travella main10 was
     about 1×).
5. **Gate for turning the setting on by default.** Gaps 1 and 2 are done, and `compare.ts` shows
   less than 1% missing or extra edges on Travela and on one medium TS repo, with overlay updates at
   least 3× faster than a full index. Add `compare.ts` to a nightly check.

Order of work: gap 1 (scoped upstream resolver on the merged view), then the Phase 1 wiring behind
the setting, then gap 2, then gap 3. Gap 4 is needed before symbol conflicts are shown to users.

## 10. Reco 1: upstream resolver over the merged view

Measured on 2026-11-17 on the same pairs, commits and machine as §4–5 (`compare.ts`, now with the H
checkout as `projectRoot`). Raw JSON and summaries are in `/tmp/overlay-results-reco1/` (not committed).

### Design

`src/overlay/merged-resolver.ts` (`resolveOverlayMerged`, reached through `engine()`). The
overlay's `upsertFiles` and `removeFile` call it inside their transaction. No upstream file
was edited for this. `engine.ts` gained one export line.

- **Shadowing.** On the overlay connection, the overlay is `main` and the base is the attached
  read-only `base`. SQLite resolves an unqualified table name temp → main → attached. For the
  length of one resolution, TEMP VIEWs named `nodes`, `edges` and `files` shadow main's tables, so
  an unmodified `QueryBuilder` and `ReferenceResolver` read base + overlay with the hiding rule.
  - `nodes` is `main.nodes` ∪ base nodes outside hidden files.
  - `edges` is `main.edges` ∪ base edges whose source is not in a hidden file.
  - `files` is base files outside hidden files ∪ the non-deleted `overlay_files` rows, mapped to
    upstream's columns: blob id as `content_hash`, `size` 0, `generated` 0.
  - Columns are listed explicitly from `main`'s `table_info`, so a migrated base's column order
    does not matter.
  - Two TEMP tables, `hidden_paths` and `hidden_base_nodes`, snapshot the hiding rule. With
    `x NOT IN temp.t`, SQLite probes their primary key instead of rebuilding a subquery on every
    statement. Each hot lookup (by `name`, `lower(name)`, `qualified_name`, `file_path`, `id`,
    edges by `source`/`target`) is pushed into both UNION ALL branches and uses the table index.
    I checked this with `EXPLAIN QUERY PLAN` and with per-statement timings on codegraph HEAD~40.
    The slowest view-backed lookup is `nodes WHERE name = ?`: 10k calls in 89 ms.
- **Writes.** During `resolveAndPersist`, the only write that reaches a shadowed table is
  `INSERT OR IGNORE INTO edges`. A TEMP `INSTEAD OF INSERT` trigger routes it to `main.edges`, and
  the outer `OR IGNORE` applies inside the trigger. A delete or update on a shadowed view fails
  with "cannot modify … because it is a view". That is deliberate: such a write comes from a
  sync-only path, and it should fail loudly rather than write to the wrong layer. `getExistingNodeIds`
  reads the merged `nodes`, so an edge is inserted only if both endpoints are visible. That
  replaces the old `insertEdge` check for resolver edges.
- **`unresolved_refs` is not shadowed while resolving.** Row ids collide between the two files, and
  the resolver deletes and parks refs by row id. Overlay refs live in `main.unresolved_refs` and
  follow the upstream lifecycle (`pending` → deleted, or `failed`). Base refs are passed in memory
  **without** a row id. Their cleanup statements (by legacy key) then match nothing in `main`, and
  the read-only base is never touched. To *select* which base refs to retry, a base-only
  `unresolved_refs` view is created around upstream's own selectors and then dropped. Refs from
  hidden files are filtered out afterwards in JS: inside the view, that filter cost a table read
  per counted row, about 0.4 s on HEAD~40.
- **Views exist only for the resolution.** They are created and dropped inside the update
  transaction. `Overlay`'s own writers (`insertNodes`, `deleteNodesByFile`, the ref batch insert)
  use unqualified names and must keep writing the real `main` tables. Prepared statements
  re-prepare on the schema change.
- **Steps per update.** The update is a pure function of the overlay state, except where noted.
  1. **Reopen.** An overlay edge whose target left the merged view goes back to being its ref
     (upstream `resurrectRefFromDroppedEdge`, from the `refName`/`refKind` stamp). This keeps the
     §6.1 order fix.
  2. **Rebuild base-ref edges.** Every edge sourced in a base node (a base ref bound to an overlay
     symbol) is deleted and rebuilt from scratch on each update. `metadata.overlayBaseRef = true`
     is the marker readers see. The rebuild keys on the base-owned source.
  3. **Resolve.** `resolveAndPersist` runs, in order, on:
     - every pending overlay ref;
     - the failed overlay refs that the *changed* files could now satisfy (upstream sync's #1240
       selection: symbol names, `module:` keys, imports of added files, scoped and folder imports);
     - the failed base refs from unhidden files that *any* overlay file could satisfy, by the same
       selection.
  `instantiates` promotion, import resolution, receiver and type context and framework `resolve()`
  all come from upstream unchanged.
- **Memos.** Each call creates a new `QueryBuilder` and `createResolver(projectRoot, …)`. The
  name-matcher, import-resolver, module-config and other memos are keyed by the resolver's context
  object (`clearNameMatcherMemos(context)` et al.), so no memo outlives one update or crosses
  overlays, or the base. Test: two overlays whose checkouts map `@lib/*` differently each resolve
  through their own `tsconfig.json`, in both orders.
- **Disk vs git.** Node, edge, file and ref rows come from the two DBs, and file contents for
  extraction come from git. The resolver reads `projectRoot` from disk for:
  - module configuration (tsconfig/jsconfig `paths` and `extends`, package.json workspaces and
    dependencies, go.mod, Cargo manifests, compile databases);
  - framework detection;
  - the source lines of some refs (receiver and binding checks).
  So `projectRoot` must be the worktree checked out at the overlay's head commit. In Stingray that
  is the worktree itself. Uncommitted edits there can skew those reads but no rows. The name-only
  fallback was removed, not kept as a fallback: upstream resolution has no case where it would
  apply.

**Rejected:**
- **A `QueryBuilder` subclass or adapter.** Resolution calls about 80 distinct `QueryBuilder`
  methods (counted with grep), each with its own SQL. Overriding them would duplicate most of a
  6k-line file and drift on every upstream rebase.
- **A scratch copy of the base.** It costs a 150 MB copy per update.
- **Permanent shadow views on the connection.** The overlay's own writers would then write
  through them.
- **A second connection.** It cannot share the update's write transaction.
- **Shadowing `unresolved_refs` during resolution.** Its ids collide between the two files.

### Results (missing / extra edges, before → after)

| pair | ref edges | missing before → after | extra before → after | what remains (cause) |
|---|---|---|---|---|
| travella main10 | 926 | 330 → **27** | 61 → **0** | 24 FastAPI `route` edges, 3 `jsx-render` (gap 2) |
| travella phase2 | 926 | 105 → **8** | 33 → **0** | 8 `route` (gap 2) |
| travella unify | 5,507 | 540 → **30** | 108 → **2** | 28 `route` (gap 2). 2 missing and 2 extra are two base edges into `ProcessReceiptCache::put`, which moved from `candidate_store.py` to `run_store.py`, so they are `dangling` (gap 3) |
| travella split | 2,892 | 171 → **38** | 68 → **35** | 35 missing and 35 extra are the base edges into `claude.py` → `claude/` (gap 3). 3 `route` (gap 2) |
| codegraph HEAD~5 | 90,864 | 97 → **0** | 34 → **34** | 34 extra are unchanged → unchanged base edges the H index no longer draws (gap 5) |
| codegraph HEAD~40 | 90,864 | 5,371 → **20** | 414 → **28** | 19 `interface-impl` and 1 `event-emitter` synthesized (gap 2). 27 extra are whole-graph (gap 5), and 1 is a wrong `possibly_stale` remap (gap 3) |

- The "changed-file ref unresolved", "other kind" (`calls` vs `instantiates`, skipped imports) and
  "wrong edge from name fallback" rows of §4 are all **0** on every pair.
- Nodes are unchanged; the only missing ones are `route` nodes.
- `possibly_stale` confirmations are unchanged (44/44, 5/5, 196/196, 9,327/9,328).
- `conflicts.ts` output is identical.

### Time and size (single runs, as in §5)

| pair | overlay update before (extract / write+resolve) | after | full index of H | overlay vs full, after |
|---|---|---|---|---|
| travella main10 | 0.42 s (0.33 / 0.06) | 0.55 s (0.37 / 0.14) | 0.39 s | ~1× (whole tree new) |
| travella phase2 | 0.19 s (0.13 / 0.02) | 0.23 s (0.14 / 0.04) | 0.39 s | 1.7× |
| travella unify | 0.34 s (0.23 / 0.06) | 0.44 s (0.23 / 0.16) | 1.00 s | 2.3× |
| travella split | 0.22 s (0.16 / 0.02) | 0.28 s (0.16 / 0.07) | 0.60 s | 2.1× |
| codegraph HEAD~5 (11 files) | 0.21 s (0.13 / 0.04) | **0.43 s** (0.12 / 0.27) | 8.86 s | **21×** |
| codegraph HEAD~40 (104 files) | 3.46 s (1.97 / 1.45) | **5.63 s** (2.01 / 3.58) | 8.96 s | **1.6×** |

- **HEAD~40 profile** (write+resolve ≈ 3.6–4.2 s across runs):
  - resolving the 46.7k pending overlay refs: 2.15 s;
  - retrying 2.7k failed overlay refs: 0.28 s;
  - selecting and resolving 7.7k base refs: 0.7 s;
  - creating the resolver: 57 ms;
  - the rest is row writes.
  
  SQL is about 1.6 s of the total, and the view-backed lookups are a small part of it. Most of the
  time is the resolver's own JS (name matching, binding scans), which is the work being bought.
  For scale, upstream `sync` of 100 changed files on this repo takes 4.2–4.8 s end to end (§5). An
  overlay update of 104 files is now in the same range, plus 2 s of `git show` and parse
  (gap 6).
- **HEAD~5:** the fixed cost (resolver creation, the merged `DISTINCT name` warm-up, base-retry
  selection) adds about 0.2 s.
- **Size:** overlays grow 4–14%, from more edges (HEAD~40: 14.2k → 23.2k) and parked `failed` refs.
  HEAD~40 goes 26.9 → 30.6 MB.

### Tests

`__tests__/overlay-resolution.test.ts` is new. It covers:
- an import-resolved ambiguous name (`helper` exported by two base files);
- `new Widget()` giving `instantiates`;
- the file-level `imports` edges, with parity against a full index of the checkout;
- a base file's failed refs binding to an added overlay symbol, with parity, and going away on
  `removeFile`;
- the same graph for a commit applied together, forward or backward;
- per-overlay module config with no shared memo.

The existing overlay tests now pass a checkout as `projectRoot`.
`npx vitest run __tests__/overlay-*.test.ts __tests__/lazy-engine.test.ts __tests__/name-matcher-memo-clears.test.ts`
passes 33/33. Full `npm test` fails only the 30 `installer-targets.test.ts` cases that already fail
on a clean checkout.

### Remaining gaps after Reco 1 (beyond §7 gaps 2–7)

- **1a. Sync-only re-open passes are not replicated.** Upstream `sync` also:
  - rebinds refs whose old answer a changed file shadows (CG-33);
  - re-opens imports when a tsconfig, package.json or go.mod changes;
  - re-opens importers of barrels, defaults and retargeted modules (`module-importers.ts`);
  - re-opens route lazy-module readers;
  - drains deferred chain refs in the batched path.
  
  For overlay refs these matter only across *separate* updates: a commit's files are resolved
  together, after all of them are written. For base refs that already resolved in the base, they
  are gap 3. No eval pair showed a difference from these passes. Wire the relevant ones in when a
  pair does.
- **1b. Base edges in the `edges` view keep their raw target.** Remapping by `stable_key` would
  stop lookups by target from using an index. A base edge into a hidden file whose node id changed
  therefore does not join, for example a supertype through a moved class. This is gap 3 territory.
- **1c. Base-ref edges are rebuilt on every update.** Their cost scales with the whole overlay
  (0.7 s at 104 files), not with the commit. If long-lived branches make that hurt, select by the
  changed files' names, as for overlay refs, and drop only edges whose target left the view.
- **1d. Upstream-shaped `files` rows for overlay files are approximate.** `size` is 0 and
  `generated` is 0, because the generated-file banner check is not run. A generated overlay file is
  therefore ranked as hand-written by resolvers that consult it.

## 11. Reco 2 & 3: frameworks, synthesis and re-resolved base edges

Measured on the same pairs, commits and machine as §10 (`compare.ts`, H checkout as `projectRoot`).
Raw JSON and summaries are in `/tmp/overlay-results-reco23/` (not committed).

### Design

All of it is in `src/overlay/` (`extract-engine.ts`, `merged-resolver.ts`, `database.ts`).
The only upstream file touched is `src/engine.ts`, whose overlay export line gained
`detectOverlayFrameworks`. Upstream internals are reached three times by bracket access
(`orchestrator['ensureDetectedFrameworks']`, `orchestrator['frameworksForFile']`,
`resolver['frameworks']` / `resolver['context']`). TypeScript type-checks bracket access to private
members, so an upstream rename fails the build instead of failing silently.

**Frameworks (Reco 2, extraction).** `detectOverlayFrameworks(projectRoot)` runs the
orchestrator's own detection over the head checkout and returns its per-file gating
(`appDependencies`: Next, Nuxt, Expo Router, Vue Router only apply inside their own app).
`extractFile(path, content, language?, frameworkNames?)` passes the result to
`extractFromSource`, as the indexer does.
- **Why detect instead of reusing the base's metadata.** Upstream already stamps
  `frameworks_at_index` into the base. That list describes B, though, and is wrong when the branch
  adds a framework (a new `requirements.txt` line), and it has no per-file gating.
- **Cost.** Detecting from the checkout gives exactly what a full index of H uses, for 0.04–0.08 s
  per update.
- **postExtract.** Framework `postExtract` (route prefixes composed across files) runs over the
  merged graph before resolution, as in a full index. Renames are applied to overlay rows only.
  Frameworks keep `id` and `qualifiedName` on these renames, so stable keys do not move. A rename
  of a base row is counted (`skippedBaseRenames`) and not applied. It was 0 on every pair.

**Base edges, re-resolved (Reco 3).** At each update, before resolution:
- **Into hidden files.** Every base edge from a visible file into a hidden one goes back to its
  ref, through upstream `resurrectRefFromDroppedEdge`. The edge id goes into a new overlay table,
  `overlay_hidden_base_edges`, which both the resolver's `edges` view and `Overlay.getEdges` leave
  out. Synthesized edges are excluded here; the synthesis step below handles them.
- **Names the overlay adds or removes.** The same happens to base edges between visible files
  whose target *name* the overlay adds or removes. This is upstream sync's definition-delta rebind
  (CG-33), computed for the whole overlay against the base, with upstream's
  `getResolutionEdgesByTargetName` selection and its per-name ceiling of 500. The delta names also
  join the failed-ref retry keys, as in sync.
- **Resolution.** The refs resolve after the overlay's own refs and before the base-ref retry.
  Their edges are base-sourced overlay edges marked `metadata.overlayRebound` (and
  `overlayBaseRef`), and they are rebuilt on every update like the other base-sourced edges.
- **When re-resolution fails.** A ref that no longer resolves produces no edge, which is what a
  full index draws. This is how the wrong `possibly_stale` remap of §4 and §10 disappeared.
- **Fallback.** Only an edge with no `refName` stamp keeps the old remap (`possibly_stale` to the
  node with the same stable key, else `dangling`). That covers an index written before upstream
  stamped refs, synthesized edges when synthesis did not run, and every edge while the base is out
  of step (below).
- **API.** `MergedEdge` keeps both flags, documented as the fallback. In all six pairs, no edge
  needed the fallback.
- **Query plan.** The edges into hidden nodes are read with a `CROSS JOIN` from the temp
  `hidden_base_nodes` snapshot to `base.edges(target)`. Without it, the planner scanned every base
  edge, because a temp table has no statistics (EXPLAIN QUERY PLAN: 276 ms → 23 ms for 685 hidden
  nodes).

**Resolution passes.** After the `resolveAndPersist` calls, `resolveChainedCallsViaConformance` and
`resolveDeferredThisMemberRefs` now drain the refs the resolver deferred until
`implements`/`extends` edges exist, as a full index does. Before this, those refs stayed pending
in the overlay.

**Synthesis (Reco 2).** The whole `synthesizeCallbackEdges`, meaning `SYNTH_PASSES` (including
`tier-synthesizer`, `cpp-template-instantiations`, const-alias) plus the Go pre-passes, runs over
the merged graph in the shape of upstream's `SynthesisStage`:
- **Staging.** The TEMP `edges` view hides every synthesized edge of both layers, and inserts go
  to a TEMP `synthesis_edges` table. A TEMP `synthesis_inputs` table shadows main's.
- **What the overlay keeps.** Staged edges the base does not already draw between visible nodes
  are persisted. On codegraph HEAD~40 that was 20: the 19 `interface-impl` and 1 `event-emitter`
  edges that were missing. Visible base synthesized edges the merged graph no longer draws, or that
  point into a hidden file, are hidden. None were in the eval pairs; the tests cover it.
- **Matching.** Edges are matched on `(source, target, kind)`. The base's synthesized edges are
  read once per update into a temp table, about 1 ms.
- **Scoping.** Upstream has no scoped synthesis; sync only gates whether the whole-graph pass
  runs. The overlay uses the same gate over *all* overlay files, so the result is a function of
  the overlay: a synthesized base edge touches or was wired in a hidden file, a hidden file was a
  synthesis input, an overlay file matches `hasSynthesisPattern`, or an overlay node is a JSX child
  candidate or a name a const alias may point at. On this repo every TS file is a synthesis input,
  so the gate always fires. On Travela it fires too, and costs 8–43 ms there.
- **`synthesis: 'off'`.** The option on `upsertFiles` / `removeFile` skips the passes. Base
  synthesized edges into hidden files then fall back to the remap, and the overlay draws no
  synthesized edges of its own.

**Not run, on purpose:**
- **Parameter flows** (`resolveParameterFlows`, Ruby only). It updates and deletes `edges` rows by
  id, which the shadow views reject. A Ruby overlay therefore keeps the calls as resolved, without
  the parameter-flow retarget.
- **`crossFileNodes`** (React Router table routes). It inserts and deletes `nodes`. Not run, so a
  React Router table handed to the router from another file gets no overlay route nodes.
- **postExtract renames of base rows** (counted, see above).

None of these occur in the eval pairs.

**Base out of step.** The rows of unchanged files only match the checkout when the base was
indexed at the overlay's merge-base. When the base's `base_commit` differs from the overlay's
(main moved), the update re-resolves no base ref (failed refs, edges into hidden files, the
definition delta) and skips synthesis. `stats.baseInStep` is false, and base edges into hidden
files keep the fallback flags until Stingray rebuilds the overlay on the new base (§9). This is not
only about accuracy. `conflicts.ts`'s branch c is such an overlay, and resolving base refs against
it crashed upstream's name matcher: `pythonOwnLines` threw `RangeError: Invalid typed array
length` on a node whose lines run past the file on disk. This is an upstream robustness bug in the
same class as a file edited between index and sync. A base with no `setBaseInfo` stamp counts as
in step.

**API changes.**
- **Async updates.** `Overlay.upsertFiles` / `upsertFile` / `removeFile` (and
  `upsertOverlayFile` / `removeOverlayFile`) are now async and return `OverlayUpdateStats`
  (per-phase timings, rebound counts, fallback count, synthesis counts, `baseInStep`). The
  synthesis passes are async, so one write transaction is held across awaits: an explicit
  `BEGIN IMMEDIATE`/`COMMIT`, with writers inside getting a connection whose `transaction()` runs
  in place. A second update on the same `Overlay` while one runs throws.
- **Schema.** `OVERLAY_SCHEMA_VERSION` is 2 (the new table). A version 1 overlay fails to open
  with "Unsupported overlay schema version". Recreate it.

### Results (missing / extra, Reco 1 → Reco 2 & 3)

| pair | ref nodes / edges | missing nodes | missing edges | extra edges | `possibly_stale` / `dangling` rows | rebound refs (by name) → edges |
|---|---|---|---|---|---|---|
| travella main10 | 451 / 926 | 24 → **0** | 27 → **0** | 0 → **0** | 0 / 0 → 0 / 0 | 0 |
| travella phase2 | 451 / 926 | 8 → **0** | 8 → **0** | 0 → **0** | 0 / 0 → 0 / 0 | 41 (41) → 41 |
| travella unify | 2,622 / 5,507 | 28 → **0** | 30 → **0** | 2 → **0** | 53 / 2 → 0 / 0 | 95 (40) → 95 |
| travella split | 1,426 / 2,892 | 3 → **0** | 38 → **0** | 35 → **0** | 5 / 42 → 0 / 0 | 115 (68) → 115 |
| codegraph HEAD~5 | 38,667 / 90,864 | 0 → 0 | 0 → **0** | 34 → **0** | 226 / 0 → 0 / 0 | 1,214 (988) → 1,148 |
| codegraph HEAD~40 | 38,667 / 90,864 | 0 → 0 | 20 → **0** | 28 → **0** | 13,281 / 0 → 0 / 0 | 18,540 (5,259) → 18,486 |

What closed each Reco 1 remainder:
- **The `route` nodes and their `references` edges** (24, 8, 28 and 3 on Travela) came back with
  framework extraction.
- **The 3 `jsx-render` edges** (main10) and the **19 `interface-impl` + 1 `event-emitter` edges**
  (codegraph HEAD~40) came back with synthesis. In both cases the overlay persists exactly those;
  on the other pairs the merged synthesis equals the base's.
- **The 35 + 35 split edges and the 2 + 2 unify edges** came back with re-resolution. The base
  edges into `claude.py` now bind into the `claude/` package, and those into
  `ProcessReceiptCache::put` now bind into `run_store.py`.
- **The wrong `possibly_stale` remap** (`torture.tsx#component#DefaultsRef → … size`) is now the
  one rebound ref that no longer resolves (18,540 refs → 18,486 edges, with duplicates collapsed),
  as in a full index.
- **"Whole-graph drift"** (34 and 27 extra edges, plus their missing counterparts) had a single
  cause, and it was resolution, not synthesis. H adds `__tests__/ruby-namesake-classes.test.ts`
  with a class `Db { getDb() }`, so `db.getDb()` in unchanged test files is ambiguous in a full
  index of H and parks as failed. In the base it bound to `DatabaseConnection::getDb`. A full
  re-synthesis would not have removed these edges (provenance `null`, kind `calls`); the
  definition-delta rebind does. No other drift remains on any pair.
- **The rebound counts** show where these come from: the "by name" share is the CG-33 rebind, and
  the rest are edges into hidden files.
- **`compare.ts`** gained two cause labels, a synthesized edge drawn by a given layer and a rebound
  edge not in the reference, plus a `--synthesis off` flag. No pair needs them now.

`conflicts.ts`: symbol conflicts went from 16 FastAPI `route` keys to **none**. File conflicts,
`mainMoved`, `unverifiable` and `whoOwns` are unchanged. The `create_app` body edit that a and b
share is still not reported (gap 4, `SAME_SHAPE`).

With `synthesis: 'off'`, codegraph HEAD~5 is still 0 / 0. HEAD~40 misses exactly the 20
synthesized edges.

### Time and size

Overlay update time (single runs, except the repeated HEAD~40 rows):

| pair | Reco 1 | Reco 2 & 3 | of which synthesis | full index of H |
|---|---|---|---|---|
| travella main10 | 0.55 s | 0.59 s | 13 ms | 0.38 s |
| travella phase2 | 0.23 s | 0.28 s | 8 ms | 0.36 s |
| travella unify | 0.44 s | 0.57 s | 43 ms | 0.82 s |
| travella split | 0.28 s | 0.35 s | 18 ms | 0.58 s |
| codegraph HEAD~5 (11 files) | 0.43 s | **1.99 s** (off: 0.83 s) | 1.28 s | 8.9 s |
| codegraph HEAD~40 (104 files), 4 runs | 5.63 s | **8.2–8.9 s** (off: 6.6–8.1 s, 3 runs) | 1.6–1.8 s | 8.9–9.3 s |

- **HEAD~40 profile** (ms, typical run):
  - extract (`git show` + parse): 1,950;
  - resolve pending overlay refs: 1,900;
  - **synthesis: 1,800** (of which `tierEdges` and `registryEdges` take about 270 ms each on HEAD~5,
    and reading all 1,581 files for `synthesis_inputs` takes about 130 ms);
  - **rebound resolve: 800** (18.5k refs);
  - base-ref retry: 550–630;
  - **collect rebound: 300** (definition delta and edge selection);
  - overlay retry: 270;
  - framework detect: 80;
  - postExtract: 60.
  
  The bold rows are new. One noisy run measured 11.3 s overlay against 10.75 s full; the machine
  was slow across the board then.
- **Against the threshold.** The 104-file update is now about 0.9× the full index. It stays under
  it, but with little margin, so `synthesis: 'off'` is the documented lever. The cheapest real
  margin is gap 6 (one `git cat-file --batch` instead of 104 `git show`), which is caller code
  (`compare.ts`'s `buildOverlay`, and Stingray's equivalent).
- **The 11-file regression** (0.43 → 2 s) is the whole-graph synthesis plus 0.3 s of rebinding.
  It cannot be scoped without upstream per-pass input tracking.
- **Size.** Rebound edges are stored in the overlay: HEAD~40 goes 30.6 → 38.5 MB (edges
  23.2k → 41.7k), HEAD~5 0.77 → 1.37 MB. On Travela it grows 1–6%.

### Tests

New:
- `overlay-synthesis.test.ts` (FastAPI + JSX fixture; each case diffs the whole merged graph
  against a full index of the checkout): route nodes from an overlay file; a `jsx-render` edge
  from an added overlay component; a base synthesized edge into a modified file redrawn to the new
  node, and gone, with no flag, when the target file is deleted; with `synthesis: 'off'`, the
  fallback remap.
- `overlay-resolution.test.ts`: a module split into a package (`lib.ts` → `lib/index.ts`
  re-exporting `lib/move.ts`) re-resolves the unchanged importer's calls to the new files, with
  parity, in all three commit orders; and a base edge between unchanged files moves when the
  overlay adds a second definition of its name (CG-33), with parity.
- `overlay-merged-view.test.ts`: the old `possibly_stale` / `dangling` cases now expect a re-resolved
  overlay edge, and no edge for a removed symbol. New cases cover the fallback flags for edges with
  no ref stamp, and an out-of-step base.
- The existing order-independence tests still pass.

Mutation checks:
- without the delta rebind, the CG-33 test fails;
- without re-resolution, 3 tests fail;
- with synthesis forced off, 2 synthesis tests fail.

`npx vitest run __tests__/overlay-*.test.ts __tests__/lazy-engine.test.ts
__tests__/name-matcher-memo-clears.test.ts` passes 41/41. See the final report for the full
`npm test` run.

### Remaining gaps after Reco 2 & 3 (ranked)

1. **Synthesis cost is whole-graph.** It is 1.3–1.8 s on this repo for any overlay, including an
   11-file one, so the 11-file update costs 2 s instead of 0.43 s. Upstream has no scoped
   synthesis; a real fix needs per-pass input tracking upstream. Until then, `synthesis: 'off'`
   exists for latency-sensitive paths.
2. **The 104-file update is about 0.9× a full index.** Gap 6 (batched `git cat-file`) and
   synthesis off are the levers. An overlay of more than about 100 files on a large repo is near
   the point where §9's "fall back to a full index" threshold should sit.
3. **Sync-only passes not replicated.** Parameter flows (Ruby), `crossFileNodes` (React Router
   tables) and base-row postExtract renames (above) are not run, and neither are these §10 gap 1a
   re-opens other than CG-33:
   - module-config changes (tsconfig, package.json, go.mod in the branch);
   - barrel, default and retargeted-module importers;
   - route lazy-module readers;
   - Python `typeFrom` edges and package-importer re-opens.

   Base edges *into* hidden files are covered by re-resolution regardless. These passes concern
   base → base edges whose answer was read from a changed file without a name change. None showed
   in the eval pairs.
4. **Out-of-step base.** No base ref is re-resolved and synthesis does not run, so base edges into
   hidden files fall back to the flags. Stingray must rebuild the overlay when `base_commit`
   moves (§9). The upstream `pythonOwnLines` crash on disk/DB line mismatch should be reported
   upstream.
5. **One transaction across awaits.** An update holds the overlay's write lock for its whole
   duration, up to about 9 s on a large overlay. Readers on other connections use WAL and are not
   blocked. Two updates on one `Overlay` are rejected.
6. **Gap 4 (SAME_SHAPE)** and **gap 7 (overlay size)** as before. Size grew with stored rebound
   edges.

## Appendix: how to reproduce

```bash
npm run build
git clone ~/Documents/travella /tmp/travella-eval
git clone <this repo> /tmp/cg-eval-self
npx tsx --tsconfig scripts/overlay-eval/tsconfig.json scripts/overlay-eval/compare.ts \
  --repo /tmp/travella-eval --base e137466~3 --head e137466 --out /tmp/unify.json
npx tsx --tsconfig scripts/overlay-eval/tsconfig.json scripts/overlay-eval/compare.ts \
  --repo /tmp/cg-eval-self --base HEAD~40 --head HEAD
npx tsx --tsconfig scripts/overlay-eval/tsconfig.json scripts/overlay-eval/conflicts.ts /tmp/travella-eval
```

The raw JSON for every run in §4–5 is in `/tmp/overlay-results/`, for §10 in
`/tmp/overlay-results-reco1/`, and for §11 in `/tmp/overlay-results-reco23/`. None is committed. The
sync and size benchmark was a throwaway script in `/tmp/syncbench/`; it is not checked in. It ran
`indexAll` and then 3 rounds of "insert a line at the top of N `src/*.ts` files, then
`CodeGraph.open`, then `sync`", against both `dist/` trees.
