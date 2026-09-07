# Agent Note: Keep scientific capability guidance stable and deduplicate Chat prompts

Status: implemented

English | [中文](2026-09-07-science-prompt-and-chat-dedup.zh.md)

## Problem

ZeroWall Science's model-facing identity still described retired MCP control tools and split R/Bio server names, so the model was directed away from the compact capability catalog. The Chat request header projection also rendered unchanged system text again for new request series, retries, and surface rewrites even though the model still needs the full prompt on every stateless provider request.

## Decision

The ZeroWall base plugin publishes one concise scientific-research identity that names the compact R, FigureYa, GEO, NHANES, and Bio capability families and directs discovery through `capability_search` followed by exact `capability_execute`. It documents artifact references, Manifest/chunked file transfer, and the rule that binary image data stays out of model context unless image inspection is requested.

The Chat request-prompt Definition keeps durable request headers and renders the first available system prompt plus later entries only when the system text changes. Tool-only changes, retries, unchanged series headers, and duplicate headers introduced while prepending a window do not create additional visible rows. Trajectory and request reconstruction continue to consume every durable header.

## Alternatives considered

**Send the system prompt only on the first HTTP request.** Rejected because the supported model APIs are stateless and later requests would lose the current developer instructions unless a provider-specific cache protocol is active.

**Hide every system-prompt row after the first row.** Rejected because a changed system text is model-visible behavior that must remain inspectable in Chat.

**Remove or rewrite request/header events to reduce UI duplication.** Rejected because headers are the durable envelope required for replay, windowed history, resume, and request reconstruction.

## Consequences

Each provider request still receives the complete current system/developer prompt and the session retains its self-contained request snapshots. Chat becomes stable and readable for ordinary multi-step conversations, while genuine prompt changes remain visible. The base prompt is intentionally bounded; detailed capability schemas remain on-demand in the capability catalog.
