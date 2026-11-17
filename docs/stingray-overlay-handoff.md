# Handoff: shared base graph + per-worktree overlays (DB / storage part)

Source: Stingray (github.com/Merthadam/stingray). Stinggraph is a fork of CodeGraph v1.6.2
(upstream remote `upstream` = colbymchenry/codegraph, tag `v1.6.2`). Stingray currently embeds
CodeGraph as a library with **one full index per worktree** in `<worktree>/.codegraph/codegraph.db`
(see Stingray `electron/codegraph.ts`). That is slow and wasteful: every worktree re-indexes the whole repo.

## Goal

One shared CodeGraph index for `main` (the **base**), plus a small **overlay per worktree** that only
contains the files that worktree changed, with ownership/status per file. The overlay is resolved
(promoted into the base) when the branch is merged. This also lets us see cross-worktree conflicts.

## Decisions already made with the user

1. **Ownership is file-level** (not symbol-level). A worktree owns a file if it changed it.
2. **Base = latest fetched `origin/main` commit.** Store it as `base_commit`.
3. **On merge, overlays are resolved into the base**, and conflicts must be easy to see.
4. **Fork CodeGraph** (this repo). The public API does not expose per-file extraction or scoped
   resolution, so we need to.
5. **Cross-file edges first:** edges from base files into a file a worktree changed are drawn as
   dashed "possibly stale" edges. Exact relinking comes later.
6. **Commits trigger overlay updates**, not every file save. Content comes from git (`git show <commit>:<path>`).
   The file list comes from `git diff --name-status <merge-base>..HEAD`. Use the git blob id as the content hash.
7. **Priorities:** (b) conflict detection, then (d) cross-worktree queries for agents, e.g. "this change belongs to worktree B".
8. **Scope:** only worktrees managed by Stingray.

## The DB problem to solve

### Node identity (blocker)
`generateNodeId(file, kind, name, line)` puts the **line number in the id**. A line shift above a
symbol changes its id, so the base and overlay ids for the "same" symbol don't match.
→ Add a **stable key**: `stable_key = file_path + '#' + kind + '#' + qualified_name`. If there are
duplicates, such as overloads or repeated names, add an ordinal `#n` in source order. Keep `id` as is
for upstream compatibility. Join base and overlay via `stable_key`.

### Base DB migration (in `src/db/migrations.ts`, next version after `CURRENT_SCHEMA_VERSION = 16`)
- `nodes.stable_key TEXT`. Backfill it in SQL from `file_path`, `kind` and `qualified_name`.
  Add `CREATE INDEX idx_nodes_stable_key ON nodes(stable_key)`.
- `files.git_blob_id TEXT` (nullable). Filled when content came from git, and used for cheap
  "same content?" checks during promotion.
- `project_metadata` keys: `base_commit`, `base_ref` (e.g. `origin/main`), `layer_kind = 'base'`.
- Also update `schema.sql` so fresh DBs match. Follow the existing migration pattern (idempotent,
  re-runnable from older versions, as the v6–v9 comments describe).

### Overlay storage (recommendation; confirm it in the Phase 0 spike)
**One overlay SQLite file per worktree**, e.g. `<worktree>/.codegraph/overlay.db`, opened alongside a
read-only base via `ATTACH`. Why:
- SQLite has a single writer per file. With separate files, worktrees never block each other or the base reindex.
- Deleting a worktree means deleting a file. There are no orphan rows in the base.
- Upstream schema/queries stay intact. The overlay reuses the same table shapes.

The alternative is one DB with a `layer_id` column on every table. Queries are simpler, but there is
writer contention and every query in `queries.ts` (6k lines) needs touching. Only choose this if the spike shows ATTACH is a dead end.

Overlay tables (same columns as the base for `nodes`, `edges`, `unresolved_refs`, `nodes_fts`, plus):
```sql
CREATE TABLE layer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- worktree_id, branch, base_commit (merge-base used), head_commit, updated_at, overlay_schema_version
CREATE TABLE overlay_files (
  path TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('added','modified','deleted','renamed')),
  old_path TEXT,            -- for renames
  blob_id TEXT,             -- git blob at head_commit (NULL if deleted)
  base_blob_id TEXT,        -- git blob at base_commit (NULL if added)
  language TEXT, indexed_at INTEGER NOT NULL, errors TEXT
);
```
- `overlay_files` **is the ownership table**.
- Edges in the overlay may target **base** node ids. Cross-DB FKs are impossible, so the overlay
  `edges` table has **no FK on target**. Validate targets in code instead.
- Deleted files have an `overlay_files` row and no nodes. That row hides the base file.

### Read semantics (the "merged view" of one worktree)
- **Nodes** = overlay nodes ∪ base nodes whose `file_path` is NOT in `overlay_files` (including deleted and renamed `old_path`).
- **Edges** = overlay edges ∪ base edges whose source file is not hidden. If a base edge's target is in a
  hidden file, remap it by `stable_key` to the overlay node and mark it `possibly_stale` (dashed).
  If there is no match, mark it `dangling`.
- **FTS/search**: union both FTS tables with the same hiding rule.
- Put this behind one module (e.g. `src/overlay/`) that exposes the same query surface Stingray uses
  (see Stingray `electron/views/rules/codegraph-api.ts`), so `queries.ts` stays mostly upstream.

### Updating an overlay (on a new commit in the worktree)
1. `git merge-base origin/main HEAD` → `base_commit`. If it differs from the base DB's `base_commit`,
   the base must be advanced first (or the worktree is "main moved", see conflicts).
2. `git diff --name-status base_commit..HEAD` → upsert `overlay_files`. Drop rows for files that went back to base content.
3. For each changed file: extract from `git show HEAD:<path>` (**needs `extractFile(path, content)` exported**),
   then run **scoped resolution** for that file's unresolved refs against base+overlay. Also re-check base
   `unresolved_refs` that might now resolve to new overlay symbols, keeping that result in the overlay.
4. One transaction per update. Write `head_commit` last.

### Promotion on merge / main moving forward
When the base advances to a new `origin/main` commit:
- For every changed file in main: if some overlay has the **same blob id** for that path, **copy** its rows
  (nodes/edges/unresolved_refs, with stable keys) into the base instead of re-extracting. Otherwise reindex the file in the base.
- Then remove those `overlay_files` rows from the overlays whose content now equals base. Delete the overlay when it is empty.
- Run resolution on the affected unresolved refs in the base.
- Base writes happen only in this "base indexer" step, never from a worktree.

### Conflicts (cross-overlay queries)
Open the base, ATTACH each overlay (default limit is 10; compile/raise the limit or query in batches), and compute:
- **file conflict**: the same `path` is in ≥2 overlays.
- **symbol conflict**: the same `stable_key` is changed in ≥2 overlays (finer-grained signal than file).
- **main moved**: `overlay_files.base_blob_id` ≠ current base `files.git_blob_id` for that path.
- **belongs to B**: a query of the form "who owns / last touched `stable_key` X" returns the worktree(s). Stingray
  uses it to warn an agent that its change overlaps another worktree's work.

## Phase 0 spike (do this first, small PRs)
1. Export from the fork: `extractFile(path, content, language?)` → nodes/edges/unresolved refs, and
   `resolveScoped(db, filePaths)`. Keep the changes additive. Prefer new files over edits to upstream ones,
   so rebasing on upstream stays easy.
2. Base migration (stable_key, git_blob_id, base_commit) plus tests (fresh DB and migration from v16).
3. Overlay DB create/open/ATTACH, plus the merged-view read for nodes/edges.
4. **Correctness check** on Travela (`~/Documents/travella`, a LangGraph Python project): merged view
   of base+overlay vs a **full index of the worktree HEAD**. Diff the node stable_keys and edge
   (source_key, target_key, kind). Report the differences and stale-edge counts. Also measure time and
   size vs a full index.
5. Write findings in `docs/` and stop for review before Phase 1 (Stingray integration behind a setting with fallback to full per-worktree index).

## Out of scope for now
Working-tree (uncommitted) mode, exact relinking of stale edges, matching prompts to worktrees,
upstreaming to CodeGraph, and the Stingray UI (the Stingray repo owns that).
