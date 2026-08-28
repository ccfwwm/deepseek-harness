# Agent Note: Treat covered sandbox permissions as redundant metadata

Status: implemented

English | [中文](2026-08-28-covered-sandbox-permission-is-not-escalation.zh.md)

## Problem

Model-generated tool calls can repeat `sandbox_permissions` even when the session already runs at that mode or a wider one. A full-access session that repeated `workspace-write` was rejected as a non-widening escalation, and a blank repeated justification failed validation before the requested operation ran. This made the effective session permission disagree with tool behavior.

## Decision

The sandbox package owns one permission-order check shared by filesystem, PowerShell, and Bash tools. A schema-valid escalation target that is equal to or narrower than the standing mode is redundant call metadata. The tool removes both escalation fields before ordinary argument validation and executes under the unchanged standing policy without requesting approval.

Only `workspace-write` and `danger-full-access` are valid targets for this normalization. Unknown modes and injected `read-only` values continue through the fail-closed path. A target wider than the standing mode still requires a non-empty justification and user approval before execution.

## Alternatives considered

**Change the system prompt only.** Rejected because model output is not a security or correctness boundary, and persisted or third-party prompts can still repeat an already covered target.

**Treat every non-widening value as redundant.** Rejected because it would silently accept unknown or schema-invalid permission values.

**Normalize only shell tools.** Rejected because filesystem write/edit exposed the same escalation fields and produced the same user-visible failure.

## Verification

Shared sandbox tests pin the permission order and reject invalid targets. Filesystem, PowerShell, and Bash tests exercise equal and narrower targets with blank justifications, assert that no approval is requested, and confirm that the standing policy remains active. Existing tests continue to cover approved widening, rejection, cancellation, missing approval infrastructure, and malformed arguments.

## Consequences

Fully authorized sessions no longer fail because a tool call asks for less permission than it already has. Genuine escalation remains explicit and approval-gated. Tool consumers now depend on the shared permission-order helper rather than maintaining separate equality checks.
