# Agent Note: ZeroWall RC.2 compatibility

Status: implemented

## Problem

The RC.2 integration combines changed attachment receipts, system-message history, and agent-loop phases with ZeroWall retry and attachment controls. Inconsistent consumers prevent compilation and duplicate composer and activity controls.

## Decision

Host and Client use the RC.2 typed contracts. File retries obtain a fresh Session-scoped receipt through `fileUploads.restage`; the Host verifies a user-message reference before reusing stored bytes. Prompt section deduplication preserves empty sections and stable identity when no duplicate exists. Loop metrics read the running phase's numeric turn and step. Chat retains local file actions alongside ordered mixed attachments, and uses the upstream history-jump state transitions with pinned-scroll delivery handling.

## Alternatives considered

Skipping type checking hides consumer incompatibilities. Retrying a file by arbitrary attachment identity bypasses Session authorization. Uploading the bytes again duplicates storage and adds a new failure point.

## Consequences

Settings renders its modal through a body portal. A nested modal inherits the collapsed sidebar footer's opacity and stacking context, allowing the conversation to cover it. The portal retains React slot ownership while isolating modal painting; tests assert its body parent and removal on close.

Retries preserve authorization and attachment identity without copying file bytes. Explicit request-series boundaries retain their prompt cards. Local tests cover Host requests, file restaging, attachment intake, history navigation, and browser controls.
