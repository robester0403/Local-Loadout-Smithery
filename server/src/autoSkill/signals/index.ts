// Barrel for the signal-detection pipeline (LOC-69). Phases land in their
// own modules under this directory across LOC-71..LOC-79.

export * from './types'
export { segmentIntoArcs } from './arcs'
export type { SegmentOptions, LlmBoundaryFn } from './arcs'
export { summarizeArc, buildPrompt, parseSummary, shouldFilter } from './summarize'
export type { SummarizeOptions, LlmSummarizeFn } from './summarize'
export { openSummaryCache, computeCacheKey, defaultCacheFile } from './summaryCache'
export type { SummaryCache } from './summaryCache'
export { embedText, clearEmbedCache, embedCacheSize } from './embed'
export type { EmbedOptions } from './embed'
export { clusterSummaries, intentEmbeddingText, pickCentroid, cosineDistance } from './cluster'
export type { ClusterOptions, EmbedFn } from './cluster'
