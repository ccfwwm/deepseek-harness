// Host clipboard write shared by Web UI copy controls. Success feedback stays
// with each control; this helper only reports whether a host accepted a write.

interface DesktopClipboardBridge {
  copyText?: ((text: string) => Promise<boolean>) | undefined
}

/**
 * Write text to the host clipboard, preferring an injected desktop bridge,
 * then the async Clipboard API, then `execCommand('copy')`.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  const desktop = (globalThis as { zerowallDesktop?: DesktopClipboardBridge }).zerowallDesktop
  if (desktop?.copyText !== undefined) {
    try {
      if (await desktop.copyText(text)) return true
    } catch {
      // A stale or unavailable preload bridge still permits browser fallbacks.
    }
  }
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Denied permissions or iframe policy still permits execCommand.
    }
  }
  // jsdom and older hosts: best-effort execCommand path when present.
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing; deprecated but deliberately retained.
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
  }
}
