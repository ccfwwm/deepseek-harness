# Agent Note: Durable images in conversation drafts

Status: implemented

English | [中文](2026-08-28-durable-image-to-conversation-draft.zh.md)

## Problem

Client plugins can render durable image attachments, but they could not place one back into a session composer for a follow-up edit. A capability-owned image may also be durable outside the target session, so asking that session to read the foreign attachment fails its authorization check. Requiring a user to locate the generated file and upload it again interrupts image revision workflows.

## Decision

`IConversation.addAttachmentImageToDraft` accepts an explicit session id and durable image reference. The conversation service resolves the target session binding, reads the attachment through that session, preserves its media type and name in a browser `File`, registers the file through the existing draft-image owner, and appends its draft id through the target session input facade.

`IConversation.addImageBytesToDraft` is the companion path for images that another capability already read under its own authority. It accepts validated bytes, image media type, file name, and optional context text. The conversation service creates a new browser `File` and a new target-session draft id; it never reuses or imports the foreign durable attachment id. Optional context is appended to the existing draft only after image admission succeeds.

The operation never submits the composer. If input admission refuses the image, the service releases the draft descriptor and its object URL before reporting the failure. Attachment order remains the caller's operation order when several calls are awaited sequentially.

## Verification

The client service tests cover both paths: a session-authorized durable PNG and externally supplied bytes. They confirm a new image id enters the target input state, context appends without replacing existing text, and no prompt is sent. Existing draft disposal continues to own object URL cleanup.

## Alternatives considered

**Allow the target session to read any durable attachment id.** Rejected because it weakens the session authorization rule and lets unrelated capabilities bypass attachment ownership.

**Reuse the foreign attachment id as a draft id.** Rejected because browser draft ids name temporary `File` and object-URL state, while durable attachment ids name Host-owned content. Combining them would mix lifetimes and cleanup owners.

**Have every capability construct conversation internals directly.** Rejected because MIME validation, object-URL ownership, busy-input refusal, and cleanup must remain in the conversation service.

## Consequences

Capability-owned images can enter a target composer without broadening session read authority. The caller must transfer the image bytes once and provide trusted metadata; the browser temporarily holds another copy until the draft is sent or released.
