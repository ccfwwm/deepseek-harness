# Agent Note: Durable images in conversation drafts

Status: implemented

## Problem

Client plugins can render durable image attachments, but they could not place one back into a session composer for a follow-up edit. Requiring a user to locate the generated file and upload it again loses the durable attachment identity and interrupts image revision workflows.

## Decision

`IConversation.addAttachmentImageToDraft` accepts an explicit session id and durable image reference. The conversation service resolves the target session binding, reads the attachment through that session, preserves its media type and name in a browser `File`, registers the file through the existing draft-image owner, and appends its draft id through the target session input facade.

The operation never submits the composer. If input admission refuses the image, the service releases the draft descriptor and its object URL before reporting the failure. Attachment order remains the caller's operation order when several calls are awaited sequentially.

## Verification

The client service test reads a durable PNG through the session face, confirms one image id enters the target input state, and confirms no prompt is sent. Existing draft disposal continues to own object URL cleanup.
