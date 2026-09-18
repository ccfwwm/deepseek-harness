# Agent Note: Browse and restore archived Sessions

Status: implemented

English | [中文](2026-09-18-browse-and-restore-archived-sessions.zh.md)

## Problem

Archiving removes a Session from ordinary lists and search without offering a way to find it again. Desktop title-area styling can also hide history when it targets the sidebar container instead of the header.

## Decision

The Workspace browser exposes an archive dialog in both sidebar widths. It reads existing Session and Workspace snapshots, filters by title or Workspace name, and opens archived conversations without restoring them implicitly. Restore uses the existing archive command with optional `archived: false`; omitted values preserve the archive operation. Registry serialization and the existing archived-set stream keep restoration durable and membership unchanged. Failures remain visible and retryable.

The sidebar marks its root, rail state, and header explicitly for desktop chrome styling. Header spacing must not change the column height or the flexible history region.

## Alternatives considered

**Show archives in ordinary history.** This removes the purpose of archiving. A separate, always reachable entry preserves ordinary browsing and makes recovery discoverable.

**Restore when opening.** Viewing a conversation should not silently change its organization; restoration is an explicit action.

## Consequences

Existing archive data needs no migration. Archive search covers titles and Workspace names; ordinary history retains content search. Unit tests exercise durable restore, serialized mutations, idempotence, filtering, navigation, and retry. Packaged desktop regression covers history after restart, settings geometry, and archive restoration through the real RPC route.
