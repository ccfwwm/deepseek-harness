/** Historical ZeroWall records retained after the capability-menu UI is removed. */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Retired capability-menu selection metadata. Readers preserve the record
     * without projecting a message or reapplying its tool policy. Continuing
     * the session uses the currently configured tools and MCP policy.
     */
    'zerowall/capabilities/selection': { tools: string[]; disabled: string[]; onDemand?: string[] }
  }
}

export {}
