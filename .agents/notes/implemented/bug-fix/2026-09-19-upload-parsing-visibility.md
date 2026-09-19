# Agent Note: Upload parsing visibility

Status: implemented

English | [中文](2026-09-19-upload-parsing-visibility.zh.md)

## Problem

Receipt-authorized document extraction can take minutes. Holding the upload in its uploading state hides the completed transfer and prevents users from sending a prompt while extraction runs.

## Decision

The conversation controller publishes a ready receipt as soon as byte upload succeeds. A separately observable preparation state keeps the composer card honest. Submission creates its local echo before awaiting extraction, then sends the existing receipt through the existing Session prompt contract. Preparation failures abandon the echo and restore the editable draft. Removal, retries, and disposal abort the operation owner so late parser responses cannot replace newer results. Cancellation releases a waiting submission without cancelling a reusable parsed draft.

The settings shell uses compact grouped chrome and does not register the configuration-document action. Web boot exposes loading, ready, and failed document states so the desktop can keep its branded splash visible until plugin activation and renderer mounting complete.

## Alternatives considered

**Wait for extraction before publishing upload completion.** This conflates transfer and parsing and prevents the requested immediate card and queued submission behavior.

**Send a prompt before extraction completes.** The Host could admit an unenriched receipt before document text is available. Waiting after the local echo preserves receipt validation and extraction enrichment.

## Consequences

Parser percentage is indeterminate unless the parser supplies progress. Pending submission status is client-only and does not alter durable Session formats or model inputs. The original file and existing receipt authorization remain the source of truth.
