# Agent Note: MCP Schema 压缩保留工具参数

Status: implemented

[English](2026-09-05-mcp-schema-compression.md) | 中文

## Problem

递归删除元数据时，复现记录工具的必填参数 `title` 被删除，但 `required` 未改变。包含类似注释键的字面量对象也遭到修改。

## Decision

MCP 桥接分别遍历 Schema 关键字与 Schema 映射。映射键保持原样；默认值、枚举、常量及未知扩展保持为数据。仅压缩 Schema 注释。回归测试比较注册后的 Schema 与转发参数；按需启用的远端测试检查所有工具，不执行写操作。

## Alternatives considered

**从 required 删除缺失的名称。** 这会改变服务端契约并允许无效调用，因此桥接选择保留缺失属性。

**完全关闭压缩。** 识别 Schema 结构的遍历可以保留现有描述预算，同时保留所有验证约束。

## Consequences

远端 Schema 仍是权威来源。此修复不展开顶层联合结构，也不保证兼容每家模型供应商的 Schema 子集。
