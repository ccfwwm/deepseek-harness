# Agent Note: Versioned model probe completion

Status: implemented

English | [中文](2026-09-06-versioned-model-probes.zh.md)

## Problem

Metadata refresh and probe completion can race. A background batch that returns only metadata leaves clients dependent on progress event delivery and can leave completed models marked unknown.

## Decision

The Session Controller returns final per-model health from background batches. Events carry progress. The Host tracks catalog generation and per-route request versions and rejects superseded completions. Metadata requests never probe models, including models with declared reasoning. Health merging preserves terminal rows and pending-only client fallback avoids probing completed rows again.

## Alternatives considered

Event-only completion cannot recover from lost progress messages. Global request versions incorrectly discard independent model completions. Rechecking the entire catalog during fallback spends network capacity on completed probes.

## Consequences

Background batch RPCs remain open until bounded probes complete, with concurrency two. Metadata reads remain independent. The model catalog adds no tool schema or conversation content. Probe errors have unavailable or requires-login terminal states. Real provider availability still depends on network and credentials.

## Testing

Host and client catalog tests cover terminal response writeback, metadata-only reasoning, stale-generation completion, bounded concurrency, and pending-only fallback.
