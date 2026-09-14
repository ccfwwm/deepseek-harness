/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'footer.expand': '展开快捷入口',
  'footer.collapse': '收起快捷入口',
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'footer.expand': 'Show shortcuts',
  'footer.collapse': 'Hide shortcuts',
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
} satisfies Record<SidebarKey, string>
