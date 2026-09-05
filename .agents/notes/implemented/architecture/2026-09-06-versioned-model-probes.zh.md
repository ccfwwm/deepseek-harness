# Agent Note: 版本化模型探测完成状态

Status: implemented

[English](2026-09-06-versioned-model-probes.md) | 中文

## Problem

元数据刷新和探测完成可能竞争。后台批次只返回元数据时，客户端依赖进度事件送达，已经完成的模型可能仍显示未知。

## Decision

Session Controller 的后台批次直接返回各模型最终健康状态，事件用于进度更新。Host 记录目录 generation 和各路由请求版本，丢弃过期结果。元数据请求从不探测模型，包括已声明 reasoning 的模型。健康状态合并保留终态，客户端兜底只重试未完成行。

## Alternatives considered

仅依赖事件无法恢复丢失的进度消息。全局请求版本会错误丢弃不同模型的独立结果。兜底时重新检查整个目录会对已完成模型重复消耗网络容量。

## Consequences

后台批次 RPC 持续到有时限的探测完成，并发数为二。元数据读取保持独立。模型目录不添加工具 schema 或会话内容。探测错误进入 unavailable 或 requires-login 终态。真实提供商可用性仍取决于网络和凭据。

## Testing

Host 和客户端目录测试覆盖终态响应写回、reasoning 元数据刷新、旧 generation 完成、并发限制以及仅重试未完成模型的兜底。
