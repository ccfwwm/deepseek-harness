---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-zerowall-capabilities-selection

English | [中文](2026-09-29-zerowall-capabilities-selection.zh.md)

## Summary

Records the historical ZeroWall capability-selection event in the Session inventory.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-zerowall-capabilities-selection
baseline: false
changes:
  - root: "event:zerowall/capabilities/selection"
    previous: null
    after: "43a99d16fdf3f12df25c2301dd12b7682326874b965c3f156a150f1d8be13470"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Current readers retain this log-only event without projecting it into conversation history. Older readers ignore an unknown event only when its envelope has ignorable: true; otherwise they reject the log instead of silently interpreting incomplete history.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/retired-content-admission.spec.ts: 38 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
