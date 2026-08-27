# Agent Note: Durable images in conversation drafts

Status: implemented

[English](2026-08-28-durable-image-to-conversation-draft.md) | 中文

## Problem

客户端插件可以渲染持久图片附件，但无法把它重新放入会话 composer，以便继续修改。某项能力拥有的图片也可能持久化在目标会话之外，因此让目标会话读取这个外部附件会触发授权失败。要求用户找到生成文件并重新上传，会打断图片修订流程。

## Decision

`IConversation.addAttachmentImageToDraft` 接受显式会话 id 和持久图片引用。conversation 服务解析目标会话绑定，通过该会话读取附件，在浏览器 `File` 中保留媒体类型和名称，通过现有草稿图片所有者注册文件，再经目标会话输入 facade 追加草稿 id。

`IConversation.addImageBytesToDraft` 是针对另一项能力已按自身权限读取图片的配套路径。它接受已验证的字节、图片媒体类型、文件名和可选上下文文本。conversation 服务创建新的浏览器 `File` 和新的目标会话草稿 id；它不会复用或导入外部持久附件 id。可选上下文只在图片准入成功后追加到现有草稿。

该操作不会提交 composer。如果输入准入拒绝图片，服务会在报告失败前释放草稿描述符和 object URL。多次调用按顺序等待时，附件顺序与调用顺序一致。

## Verification

客户端服务测试覆盖两条路径：会话已授权的持久 PNG，以及外部提供的字节。测试确认新图片 id 进入目标输入状态，上下文会追加且不覆盖已有文本，并且不会发送 prompt。现有草稿 dispose 流程继续拥有 object URL 清理责任。

## Alternatives considered

**允许目标会话读取任意持久附件 id。**拒绝，因为这会削弱会话授权规则，并让无关能力绕过附件所有权。

**把外部附件 id 复用为草稿 id。**拒绝，因为浏览器草稿 id 命名临时 `File` 和 object URL 状态，持久附件 id 则命名 Host 拥有的内容。合并两者会混合生命周期和清理所有者。

**让每项能力直接构造 conversation 内部状态。**拒绝，因为 MIME 验证、object URL 所有权、忙碌输入拒绝和清理必须继续由 conversation 服务负责。

## Consequences

能力拥有的图片可以进入目标 composer，而不扩大会话读取权限。调用方必须传输一次图片字节并提供可信元数据；浏览器会暂时保留另一份副本，直到草稿发送或释放。
