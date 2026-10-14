/** Local preference and viewport limits for the settings dialog. */
export interface SettingsPanelSize { width: number; height: number }

/** @param preferred - saved dimensions. @param viewport - current viewport. @returns dimensions that fit the viewport. */
export function fitSettingsPanel(preferred: SettingsPanelSize | undefined, viewport: SettingsPanelSize): SettingsPanelSize {
  const maxWidth = Math.max(0, viewport.width - 48)
  const maxHeight = Math.max(0, viewport.height - 48)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(640, maxWidth), preferred?.width ?? 1040)),
    height: Math.min(maxHeight, Math.max(Math.min(360, maxHeight), preferred?.height ?? 820)),
  }
}

/** @param raw - localStorage text. @returns valid saved dimensions or the default preference. */
export function parseSettingsPanelSize(raw: string | null): SettingsPanelSize | undefined {
  if (raw === null) return
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || !('width' in value) || !('height' in value)) return
    const { width, height } = value
    if (typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height)
      && width >= 100 && height >= 100 && width <= 10000 && height <= 10000) return { width, height }
  } catch (_error) { /* An invalid local preference uses the default size. */ }
  return
}
