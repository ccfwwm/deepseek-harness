# Agent Note: Versioned model probe completion

Status: implemented

English | [中文](2026-09-06-versioned-model-probes.zh.md)

## Problem

Metadata refresh and probe completion can race. A background batch that returns only metadata leaves clients dependent on progress event delivery and can leave completed models marked unknown.

## Decision

Catalog discovery bounds each provider independently (Host `modelCatalogTimeoutMs`, 15000 ms by default), returning successful groups alongside failures. The Client bounds metadata RPCs with `metadataTimeoutMs` (30000 ms), exposes retry on failure, and refreshes rather than reusing a cached provider error. Choices are available before a cold Session's selection projection arrives; the projection replaces the provisional default when delivered.

The Session Controller returns final per-model health from background batches. Events carry progress. The Host tracks catalog generation and per-route request versions and rejects superseded completions. Metadata requests never probe models, including models with declared reasoning. Health merging preserves terminal rows and pending-only client fallback avoids probing completed rows again.

## Alternatives considered

Waiting for every provider and the Session projection can leave the selector loading indefinitely. A single global failure would hide healthy providers. The adapter list API has no cancellation signal, so the deadline settles the catalog wait but does not claim to cancel adapter-owned network work.

Event-only completion cannot recover from lost progress messages. Global request versions incorrectly discard independent model completions. Rechecking the entire catalog during fallback spends network capacity on completed probes.

## Consequences

Background batch RPCs remain open until bounded probes complete, with concurrency two. Metadata reads remain independent. The model catalog adds no tool schema or conversation content. Probe errors have unavailable or requires-login terminal states. Real provider availability still depends on network and credentials.

## Testing

Host and client catalog tests cover terminal response writeback, metadata-only reasoning, stale-generation completion, bounded concurrency, and pending-only fallback.
