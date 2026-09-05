# Agent Note: Preserve MCP arguments during schema compression

Status: implemented

English | [中文](2026-09-05-mcp-schema-compression.zh.md)

## Problem

Recursive metadata stripping removed the required `title` argument from reproduction-record tools while leaving `required` unchanged. It also changed literal objects containing annotation-like keys.

## Decision

The MCP bridge traverses schema keywords and schema maps separately. Map keys remain verbatim; defaults, enums, constants, and unknown extensions remain data. Only schema annotations are compressed. Regression tests compare registered schemas and forwarded arguments; an opt-in remote test checks every listed tool without executing writes.

## Alternatives considered

**Remove missing names from required.** This changes the server contract and permits invalid calls, so the bridge preserves the missing property instead.

**Disable compression entirely.** Schema-aware traversal preserves the existing description budget while retaining all validation constraints.

## Consequences

Remote schemas remain authoritative. This fix does not flatten root unions or guarantee compatibility with every provider-specific schema subset.
