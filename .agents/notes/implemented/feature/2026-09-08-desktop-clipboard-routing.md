# Agent Note: Desktop Clipboard Routing

## Context

Message copy controls used the browser Clipboard API first and reached the Electron preload bridge only from one chat component. A denied browser write could also stop before the legacy fallback, and a rejected preload call escaped the component promise chain.

## Decision

`writeClipboard` now owns the complete route for every shared copy control. It tries the injected desktop bridge first, then the browser Clipboard API, then `execCommand('copy')`. Each unavailable or rejected route continues to the next route, and the helper reports success only after one host accepts the exact text.

Message actions consume this single result and retain their existing one-second success indicator. Component and helper tests cover desktop preference, preload rejection, browser rejection, the final fallback, and total failure.

## Consequence

Electron uses its main-process clipboard implementation directly, while ordinary browser deployments retain their existing paths. Other controls that already call `writeClipboard` gain the same desktop behavior without product-specific logic in each component.
