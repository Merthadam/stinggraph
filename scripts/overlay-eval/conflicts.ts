/**
 * Sanity check for findConflicts / whoOwns on the Travela history: one base at
 * `main`, three synthetic worktree branches committed in a throwaway clone.
 *
 *   npm run build
 *   git clone ~/Documents/travella /tmp/travella-eval
 *   npx tsx --tsconfig scripts/overlay-eval/tsconfig.json scripts/overlay-eval/conflicts.ts /tmp/travella-eval
 *
 * Creates branches overlay-eval/{a,b,c} in that clone (never the original).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildBase, buildOverlay, cleanup, git } from './compare';

/* eslint-disable @typescript-eslint/no-var-requires */
const { findConflicts, whoOwns } = require(path.resolve(__dirname, '../../dist/overlay'));

function branch(repo: string, name: string, from: string, edits: Record<string, (old: string) => string>): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-branch-'));
  fs.rmSync(dir, { recursive: true });
  git(repo, 'worktree', 'add', '--quiet', '-B', name, dir, from);
  for (const [file, edit] of Object.entries(edits)) {
    const p = path.join(dir, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, edit(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''));
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '--quiet', '-m', name);
  git(repo, 'worktree', 'remove', '--force', dir);
}

async function main(repo: string) {
  const main = git(repo, 'rev-parse', 'main').trim();
  // The parent of the commit that added services/crud/repository.py: c branches before main gained it.
  const older = git(repo, 'rev-parse', `${git(repo, 'log', '-1', '--format=%H', '--diff-filter=A', 'main', '--', 'services/crud/repository.py').trim()}^`).trim();
  branch(repo, 'overlay-eval/a', main, {
    'services/auth/api.py': (s) => s.replace('def health():', 'def health():  # a: touched'),
    'services/crud/repository.py': (s) => s.replace('def normalize_title(value: str) -> str:', 'def normalize_title(value: str) -> str:  # a'),
    'services/auth/feature_a.py': () => 'def feature_a():\n    return 1\n',
    'README.md': (s) => s + '\nA\n',
  });
  branch(repo, 'overlay-eval/b', main, {
    'services/auth/api.py': (s) => '# b: shift every line\n' + s.replace('def register(data: RegisterInput):', 'def register(data: RegisterInput):  # b'),
    'frontend/src/api.js': (s) => s.replace('export async function request(path, body) {', 'export async function request(path, body, opts) {'),
  });
  branch(repo, 'overlay-eval/c', older, {
    'services/auth/api.py': (s) => s + '\n# c: unchanged-on-main file\n',
    'services/crud/repository.py': () => 'def own_repository():\n    return 0\n', // main added this path since c's merge-base
  });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-conflicts-'));
  try {
    const base = await buildBase(repo, main, path.join(work, 'base'));
    const overlays: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      const p = path.join(work, `wt-${name}`, 'overlay.db');
      // The worktree's checkout at its head: the resolver reads module config from it.
      const checkout = path.join(work, `wt-${name}`, 'checkout');
      git(repo, 'worktree', 'add', '--detach', '--quiet', checkout, `overlay-eval/${name}`);
      const built = await buildOverlay(repo, base.dbPath, main, `overlay-eval/${name}`, p, `wt-${name}`, checkout);
      built.overlay.close();
      overlays.push(p);
    }
    const t = process.hrtime.bigint();
    const conflicts = findConflicts(base.dbPath, overlays);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const owners = (o: Array<{ worktreeId: string }>) => o.map((x) => x.worktreeId).join(',');
    console.log(`findConflicts over ${overlays.length} overlays: ${ms.toFixed(1)} ms`);
    console.log('file conflicts:', conflicts.fileConflicts.map((c: any) => `${c.path} [${owners(c.owners)}]`));
    console.log('symbol conflicts:', conflicts.symbolConflicts.map((c: any) => `${c.stableKey} [${owners(c.owners)}]`));
    console.log('main moved:', conflicts.mainMoved.map((c: any) => `${c.path} [${c.owner.worktreeId}] ${c.baseBlobId?.slice(0, 7)} -> ${c.currentBlobId?.slice(0, 7)}`));
    console.log('unverifiable:', conflicts.unverifiable.map((c: any) => `${c.path} [${c.owner.worktreeId}]`));
    for (const key of ['services/auth/api.py#function#create_app::health', 'services/auth/api.py#function#create_app::register',
      'services/auth/api.py', 'frontend/src/api.js#function#request', 'services/auth/session_store.py']) {
      console.log(`whoOwns(${key}) = [${owners(whoOwns(base.dbPath, overlays, key))}]`);
    }
  } finally {
    cleanup(repo, work);
    git(repo, 'worktree', 'prune');
  }
}

main(path.resolve(process.argv[2] ?? '/tmp/travella-eval')).catch((error) => { console.error(error); process.exit(1); });
