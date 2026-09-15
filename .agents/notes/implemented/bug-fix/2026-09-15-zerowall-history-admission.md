# Agent Note: ZeroWall history admission after capability-menu removal

Status: implemented

English | [中文](2026-09-15-zerowall-history-admission.zh.md)

## Problem

Released ZeroWall sessions contain required `zerowall/capabilities/selection` events. Removing the UI plugin also removes its runtime registration, so persistence refuses the history. Registering the name in the base plugin still fails when a production bundle inlines a separate event catalog.

## Decision

The Session type declaration retains the exact legacy event as log-only metadata. The generated catalog includes it in every bundled reader. Payloads and sequence numbers remain intact, and continuing a session uses current tool configuration. This compatibility adds no producer, UI module, tool executor, model message, or new session generation.

## Alternatives considered

**Runtime registration** cannot reach catalogs inlined into other bundles. **Skipping all unknown events** could lose required future semantics. **Editing user logs** risks changing recorded history and requires a separate migration for every installation.

## Consequences

This ZeroWall fork owns one historical event declaration. Future unknown required events remain errors. Provider tests cover read and append with byte-preserved history; the desktop package smoke verifies admission using the actual bundled persistence module. A private user-history copy can be tested locally without committing its contents.
