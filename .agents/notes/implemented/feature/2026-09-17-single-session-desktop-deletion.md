# Agent Note: Single-session desktop deletion

Status: implemented

English | [中文](2026-09-17-single-session-desktop-deletion.zh.md)

## Problem

ZeroWall previously stopped and restarted the entire Host to release Windows session log handles before moving one session to the Recycle Bin. This reloaded the renderer and interrupted independent work.

## Decision

The session controller retains the Agent factory's disposal capability. A deletion preparation blocks new operations on the target, waits for admitted operations, rejects running target/descendant agents, closes history observations, releases the owned Agent, and invalidates derived projection state. The JSONL backend resolves the actual directory for current or historical logs.

The desktop confirms once, validates the resolved path within its session storage, moves that directory to the OS trash, and commits using the preparation token. Only a successful commit publishes removal. Duplicate commits are idempotent; an abort unlocks the identity and notifies the Client to reopen its history. If storage is already absent, abort reconciles the committed removal instead of resurrecting the row.

The Client selects the latest surviving ordinary session when the active row is removed, or clears the selection for the last row. Removing another row retains the active Session instance. Workspace files and historical scientific artifacts remain untouched.

This complements [workspace registration deletion](2026-07-27-workspace-registration-deletion.md); that operation still removes only a workspace registration and is not superseded.

## Alternatives considered

**Restart the Host.** Rejected because independent sessions lose their connections and the renderer reloads.

**Mutate private registries.** Rejected because registry removal does not release scoped services or persistence handles in their required order.

**Delete a fixed log filename.** Rejected because supported historical and compressed generations share a directory and may have different filenames.

## Consequences

Only file-backed storage with a directory resolver supports this desktop operation. Agents owned by another service cannot be disposed by the session controller. Prepared deletions remain process-local capabilities; a Host restart drops preparation state and the filesystem remains authoritative. Idle descendant histories are preserved, while running descendants block parent deletion.

Focused Host and Client tests cover target-only release, running-target rejection, cold storage, token validation, duplicate commits, selection fallback, and delayed projection writes. Desktop tests exercise cancel, trash failure, and path containment. No tools, prompts, or model tokens are added.
