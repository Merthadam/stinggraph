import { detectLanguage, loadGrammarsForLanguages } from '../extraction/grammars';
import { extractFromSource } from '../extraction/tree-sitter';
import { ExtractionOrchestrator } from '../extraction';
import { QueryBuilder } from '../db/queries';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../file-limits';
import { createResolver } from '../resolution';
import type { ExtractionResult, Language } from '../types';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import type { ResolutionResult } from '../resolution/types';

/**
 * `frameworkNames` are the frameworks a full index would run on this file
 * (see detectOverlayFrameworks); omitted, no framework extractor runs.
 */
export async function extractOverlayFile(filePath: string, content: string, language?: Language, frameworkNames?: string[]): Promise<ExtractionResult> {
  // Same cap as the indexer, so an oversize file has no rows in either layer.
  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_SOURCE_FILE_SIZE_BYTES) {
    return { nodes: [], edges: [], unresolvedReferences: [], durationMs: 0, errors: [{
      message: `File exceeds max size (${size} > ${MAX_SOURCE_FILE_SIZE_BYTES})`, filePath, severity: 'warning', code: 'size_exceeded',
    }] };
  }
  const detected = language ?? detectLanguage(filePath, content);
  await loadGrammarsForLanguages([detected]);
  const result = extractFromSource(filePath, content, detected, frameworkNames);
  // Same denormalization the orchestrator applies before storing refs.
  result.unresolvedReferences = result.unresolvedReferences.map((ref) => ({
    ...ref, filePath: ref.filePath ?? filePath, language: ref.language ?? detected,
  }));
  return result;
}

/**
 * The frameworks a full index of `projectRoot` extracts each file with: the
 * orchestrator's own detection over the checkout, and its per-app gating
 * (`appDependencies`). Its private members are reached by bracket access, which
 * TypeScript still type-checks, so a rename upstream fails the build here.
 * The orchestrator only reads the checkout for this; it never touches `queries`.
 */
export function detectOverlayFrameworks(projectRoot: string): (filePath: string) => string[] {
  const orchestrator = new ExtractionOrchestrator(projectRoot, null as unknown as QueryBuilder);
  const names = orchestrator['ensureDetectedFrameworks']();
  return (filePath) => orchestrator['frameworksForFile'](filePath, names);
}

export function resolveOverlayScope(db: SqliteDatabase, filePaths: string[], projectRoot: string): ResolutionResult {
  const queries = new QueryBuilder(db);
  const resolver = createResolver(projectRoot, queries);
  return db.transaction(() => resolver.resolveAndPersist(queries.getUnresolvedReferencesByFiles(filePaths)))();
}
