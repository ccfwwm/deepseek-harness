# Agent Note: OmicVerse Agent 任务模型路线

Status: implemented

[English](2026-09-20-omicverse-agent-route.md) | 中文

## Problem

OmicVerse Agent 必须使用 ZeroWall 当前模型，不能要求模型填写凭据或静默更换端点。

## Decision

可信 rmcp 桥接仅为 `omicverse.run.agent` 注入现有任务路线。普通 OmicVerse Python、原生 MCP 和 CPU 适配不接收模型凭据。模型、provider、端点和 API 协议通过当前解析器一起转发。

## Alternatives considered

为所有 OmicVerse 调用注入凭据会不必要地暴露给科学代码。第二条 MCP 连接会重复连接和鉴权管理。

## Consequences

服务端必须明确拒绝不支持的协议，持久任务元数据不保存凭据。凭据桥测试验证 Agent 转发及普通 Python 排除；产品组合与生产调用在 ZeroWall 集成验收中验证。
