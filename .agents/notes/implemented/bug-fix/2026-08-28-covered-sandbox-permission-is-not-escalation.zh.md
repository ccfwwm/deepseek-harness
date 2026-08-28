# Agent Note: 已覆盖的沙箱权限不是升级请求

Status: implemented

[English](2026-08-28-covered-sandbox-permission-is-not-escalation.md) | 中文

## Problem

即使会话已经处于目标模式或更宽模式，模型生成的工具调用仍可能重复传入 `sandbox_permissions`。完全访问会话重复传入 `workspace-write` 时，会被当作未拓宽权限的升级请求拒绝；重复理由为空时，还会在操作执行前触发参数校验错误。这使会话的实际权限与工具行为不一致。

## Decision

sandbox 包提供由文件系统、PowerShell 和 Bash 工具共同使用的权限顺序判断。若符合 schema 的升级目标等于或窄于常驻模式，则它只是冗余调用元数据。工具会在普通参数校验前移除两个升级字段，不请求审批，并保持原常驻策略执行。

只有 `workspace-write` 和 `danger-full-access` 会参与该规范化。未知模式和注入的 `read-only` 值仍进入 fail-closed 路径。比常驻模式更宽的目标仍必须携带非空理由，并在执行前获得用户批准。

## Alternatives considered

**只修改系统提示词。** 不采用，因为模型输出不是安全或正确性边界，持久化提示词或第三方提示词仍可能重复已覆盖的目标。

**把所有未拓宽权限的值都视为冗余。** 不采用，因为这会静默接受未知或不符合 schema 的权限值。

**只规范化 shell 工具。** 不采用，因为文件系统 write/edit 暴露相同升级字段，也会产生同样的用户可见错误。

## Verification

共享 sandbox 测试固定权限顺序并拒绝非法目标。文件系统、PowerShell 和 Bash 测试覆盖理由为空的同级与更窄目标，断言不会发起审批，并确认常驻策略保持有效。既有测试继续覆盖获批升级、拒绝、取消、审批基础设施缺失和畸形参数。

## Consequences

已获得完全权限的会话不会再因工具调用请求更窄权限而失败。真正的权限升级仍保持显式并受审批控制。各工具消费者现在依赖共享权限顺序函数，不再各自维护相等判断。
