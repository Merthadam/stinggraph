export { extractFile, detectOverlayFrameworks, resolveScoped } from './extract';
export { recomputeStableKeys, setGitBlobIds, getBaseInfo, setBaseInfo } from './stable-keys';
export type { BaseInfo } from './stable-keys';
export { Overlay, createOverlay, openOverlay, upsertOverlayFile, removeOverlayFile } from './database';
export type { OverlayMeta, OverlayFile, MergedNode, MergedEdge, NodeFilter, EdgeFilter, OverlayUpdateOptions } from './database';
export type { OverlayUpdateStats } from './merged-resolver';
export { findConflicts, whoOwns } from './conflicts';
export type { OverlayOwner, OverlayConflicts } from './conflicts';
