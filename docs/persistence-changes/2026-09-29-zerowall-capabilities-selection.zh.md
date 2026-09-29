---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-zerowall-capabilities-selection

[English](2026-09-29-zerowall-capabilities-selection.md) | 中文

## 概述

将历史 ZeroWall 能力选择事件纳入 Session 持久化目录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

当前读取器保留此仅日志事件，不把它投影为对话历史。旧版读取器仅在未知事件的 envelope 带有 ignorable: true 时忽略它；未标记时会拒绝该日志，避免静默地把不完整历史当作完整记录。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/retired-content-admission.spec.ts：38 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
