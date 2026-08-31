# Agent Note: Original-file attachment admission

Status: implemented

## Problem

Ordinary file intake coupled browser admission to document extraction. The Composer waited for PDF and Office parsers, displayed parser lifecycle state, and could not show a complete local submission echo before serialization finished. Attachment presentation also exposed extracted text as if it were the original file.

## Decision

**A draft file represents original bytes, not extracted content.** Browser intake registers the file name and media type immediately. Host preparation persists and authorizes the original bytes, while extraction remains a separate operation owned by file tools or an explicit user action.

**Local submission echoes include file descriptors.** `BeginSubmissionInput` and `PendingSubmission` carry ordered file names and media types alongside image previews. The conversation registers the echo before yielding a paint and before it awaits original-byte persistence. A preparation failure abandons only that echo and leaves the draft attachment available for retry.

**Attachment cards do not project parser state.** Composer and message cards show a file icon and file name. Opening a durable attachment means opening the original bytes. Local or remote extraction output uses a separate path and title and never replaces the original attachment reference.

## Verification

Session-controller tests assert prompt-coupled echo retirement. Attachment component tests assert that a pending file renders without local or remote parsing labels. The ZeroWall file plugin tests cover original-byte persistence, lazy first-read extraction, PDF extraction after admission, and workspace materialization.

## Consequences

- File persistence may still fail after the echo first renders; the existing abandon path removes that echo while retaining the draft.
- Agents read an uploaded document through the file tools, which may perform and cache extraction on first use.
- Historical attachment fields remain readable, but new Composer behavior does not depend on parser metadata.
