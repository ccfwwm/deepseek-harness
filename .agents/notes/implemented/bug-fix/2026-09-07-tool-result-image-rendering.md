# Agent Note: Tool result images use the conversation attachment renderer

Status: implemented

English | [中文](2026-09-07-tool-result-image-rendering.zh.md)

## Problem

Tool results already persisted native image blocks, but the generic tool row flattened every non-text block to JSON. DeepSeek Harness therefore showed only image metadata or a filename while user and assistant messages displayed images correctly.

## Decision

The generic Tool renderer extracts durable image blocks and sends them through the existing `conversation.message.images` slot. The filename remains a compact button that dispatches the existing attachment-open event for the workspace sidebar. Image blocks are omitted from the generic output text only when they carry a valid attachment reference; unknown image-like payloads remain JSON so no model-visible data is silently lost. The bundled `image-base64-render` Skill instructs tools to prefer native durable blocks and use canonical data URLs only when a native block is unavailable.

## Alternatives considered

**Embedding Base64 in assistant text:** rejected because it bloats the transcript and bypasses the durable attachment lifecycle.

**Adding a second image loader in the Tool package:** rejected because the Chat-owned loader already enforces session authorization, caching, and data URL fallback.

## Consequences

Native images now render inline for generic and nested Tool results, and their names provide a sidebar preview action. Tool-specific keyed cards that own their complete presentation remain responsible for their own image UI. The new Skill is copied into packaged runtime resources with the existing Skill preparation step.
