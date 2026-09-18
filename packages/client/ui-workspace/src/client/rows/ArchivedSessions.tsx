/** Searchable archive browser; restoring changes only the Host archive set. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/**
 * List archived Sessions using the same live metadata as the sidebar.
 * @param props - framework hooks, Host commands, navigation, and close callback.
 * @returns the archive dialog.
 */
export function ArchivedSessions({ useSessions, useWorkspaces, restoreSession, open, onClose, t }: Pick<
  WorkspaceBrowserProps, 'useSessions' | 'useWorkspaces' | 'restoreSession' | 'open' | 't'
> & { onClose: () => void }) {
  const list = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<SessionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const normalized = query.trim().toLocaleLowerCase()
  const rows = workspaces.archivedSessionIds.flatMap((id) => {
    const session = list.byId[id]
    if (session === undefined || session.origin === 'subagent') return []
    const title = session.blank ? t('session.new') : session.displayTitle
    const workspace = workspaces.items.find(item => item.sessionIds.includes(id))?.title ?? t('group.ungrouped')
    return [{ id, title, workspace, updatedAt: session.updatedAt }]
  }).filter(row => `${row.title}\n${row.workspace}`.toLocaleLowerCase().includes(normalized))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  const loading = list.phase !== 'ready' || workspaces.phase !== 'ready'
  const restore = async (id: SessionId): Promise<void> => {
    setBusy(id)
    setError(null)
    setRestored(false)
    try {
      await restoreSession(id)
      setRestored(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal open onClose={busy === null ? onClose : () => {}} closeLabel={t('close')} title={t('archive.title')} description={t('archive.description')}>
      <input className={css.renameInput} aria-label={t('archive.search')} placeholder={t('archive.search')} value={query} onChange={(event) => { setQuery(event.target.value) }} autoFocus />
      {error !== null && <div role="alert" className={css.renameError}>{error}</div>}
      {restored && <div role="status" className={css.archiveStatus}>{t('archive.restored')}</div>}
      <div className={css.archiveList} aria-busy={loading}>
        {loading ? <p role="status">{t('archive.loading')}</p> : rows.length === 0 ? <p>{t(normalized ? 'empty.noMatches' : 'archive.empty')}</p> : rows.map(row => (
          <div key={row.id} className={css.archiveRow}>
            <button type="button" className={css.archiveOpen} onClick={() => { open(row.id); onClose() }} disabled={busy !== null}>
              <span>{row.title}</span><small>{row.workspace}</small>
            </button>
            <Button variant="outline" disabled={busy !== null} onClick={() => { void restore(row.id) }}>
              {t(busy === row.id ? 'archive.restoring' : 'archive.restore')}
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
