# Agent Note: OmicVerse Agent task route

English | [中文](2026-09-20-omicverse-agent-route.zh.md)

Status: implemented

## Problem

OmicVerse Agent must use the active ZeroWall model without asking the model to reproduce credentials or silently selecting a different endpoint.

## Decision

The trusted rmcp bridge injects the existing task route only for `omicverse.run.agent`. Ordinary OmicVerse Python, native MCP and CPU adapters receive no model credentials. Model, provider, endpoint and API protocol travel together through the current resolver.

## Alternatives considered

Injecting credentials into every OmicVerse call unnecessarily exposes them to scientific code. A second MCP connection would duplicate connection and authentication ownership.

## Consequences

The service must reject unsupported protocols explicitly and keep credentials out of persistent job metadata. The credential bridge test verifies Agent forwarding and ordinary Python exclusion. Product composition and production calls are verified in the ZeroWall integration acceptance.
