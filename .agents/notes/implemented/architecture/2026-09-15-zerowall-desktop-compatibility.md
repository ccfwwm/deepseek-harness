# Agent Note: ZeroWall desktop compatibility

Status: implemented

English | [中文](2026-09-15-zerowall-desktop-compatibility.zh.md)

## Problem

Released ZeroWall sessions contain file parser metadata, file-review markers and plugin selection events outside the upstream historical inventory. Native upload receipts also bypassed the product parser, while the replacement review renderer displayed file blocks as JSON.

## Decision

Historical readers admit the exact released ZeroWall event names and attachment fields, validate their primitive types and preserve the data through adjacent migration. Unknown fields remain rejected. Opening a history does not rewrite its source generation.

The conversation upload queue awaits the product's optional receipt-authorized parser before marking a file ready. Session prompt admission resolves the receipt, then reads parser metadata from the Host service. Client-supplied parser text cannot replace that authoritative result. Missing extraction leaves the original receipt usable. The shared user bubble is exported so the review plugin retains the native file cards and file actions.

The sidebar footer keeps Settings visible and persists its shortcut expansion independently of sidebar width. The settings shell handles product section-navigation events, including the WeChat status shortcut.

## Alternatives considered

**Rewrite user logs in place.** Rejected because historical files are immutable evidence and failed migrations must remain recoverable.

**Restore inline file submissions.** Rejected because the native Agent-bound receipt proves upload ownership; parser integration belongs after that admission.

## Consequences

The product fork carries explicit historical compatibility and optional ZeroWall integration points. Focused historical, upload and renderer tests cover the changed behavior; packaged GUI checks cover the complete composition.
