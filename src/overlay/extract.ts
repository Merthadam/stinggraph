import { engine } from '../lazy-engine';
import type { ExtractionResult, Language } from '../types';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import type { ResolutionResult } from '../resolution/types';

/**
 * Parse supplied bytes, without a database or filesystem reads for source
 * content. Pass `frameworkNames` (from detectOverlayFrameworks) to run the
 * framework extractors a full index runs on this file (route nodes and their
 * references); without them none run.
 */
export async function extractFile(filePath: string, content: string, language?: Language, frameworkNames?: string[]): Promise<ExtractionResult> {
  return engine().extractOverlayFile(filePath, content, language, frameworkNames);
}

/**
 * The frameworks a full index of `projectRoot` (the worktree checked out at
 * the overlay's head) extracts each file with, as a per-file lookup. Detected
 * once per call from the checkout's manifests and sources, exactly as the
 * indexer does; call it again when the checkout moves to another commit.
 */
export function detectOverlayFrameworks(projectRoot: string): (filePath: string) => string[] {
  return engine().detectOverlayFrameworks(projectRoot);
}

/**
 * Resolve only pending references originating in filePaths; candidates may come
 * from the whole DB. Uses upstream import/name resolution, not whole-graph
 * synthesis, framework post-extract or deferred dispatch passes. projectRoot is
 * used for module configuration; supply the indexed root rather than cwd.
 */
export function resolveScoped(db: SqliteDatabase, filePaths: string[], projectRoot = process.cwd()): ResolutionResult {
  return engine().resolveOverlayScope(db, filePaths, projectRoot);
}
