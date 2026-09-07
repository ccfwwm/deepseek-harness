# Agent Note: 工具结果图片使用对话附件渲染器

Status: implemented

[English](2026-09-07-tool-result-image-rendering.md) | 中文

## Problem

工具结果已经持久化原生图片块，但通用工具行会把所有非文本块展平成 JSON。因此 DeepSeek Harness 只显示图片元数据或文件名，而用户消息和助手消息可以正常显示图片。

## Decision

通用工具渲染器提取带有效附件引用的图片块，并复用已有的 `conversation.message.images` slot。文件名保留为紧凑按钮，点击后派发现有附件打开事件，在工作区侧栏预览。只有携带有效附件引用的图片块才从通用输出文本中省略；未知的类图片数据仍显示为 JSON，避免静默丢失模型可见数据。新增的 `image-base64-render` Skill 指导工具优先使用原生持久化图片块，只有无法生成原生块时才使用规范 data URL。

## Alternatives considered

**把 Base64 放入助手文本：** 放弃，因为这会膨胀对话并绕过持久化附件生命周期。

**在工具包中增加第二套图片加载器：** 放弃，因为 Chat 已有的加载器负责会话授权、缓存和 data URL 回退。

## Consequences

通用工具结果和嵌套工具结果现在会在对话中直接显示原生图片，文件名提供侧栏预览操作。自行负责完整展示的工具专用 keyed card 仍保留自己的图片界面。新增 Skill 会通过现有资源准备步骤进入打包运行时。
