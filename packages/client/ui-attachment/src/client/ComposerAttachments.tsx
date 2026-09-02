import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment, ComposerAttachmentsProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { AttachmentRail } from '../AttachmentRail.tsx'
import type { AttachmentRailItem } from '../AttachmentRail.tsx'
import { DropOverlay } from '../DropOverlay.tsx'
import { ImageLightbox } from '../ImageLightbox.tsx'
import { attachmentRailLabels, dropOverlayLabels, lightboxLabels } from './labels.ts'
import css from './ComposerAttachments.module.css'

/** Rail item retaining its browser-owned attachment for callbacks. */
interface ComposerRailItem extends AttachmentRailItem {
  attachment: Extract<ComposerAttachment, { kind: 'image' }>
}

type ComposerFileAttachment = Extract<ComposerAttachment, { kind: 'file' }>

/** Draft-image rail, document drop target, and original-image preview slot entry. */
export function ComposerAttachments({
  attachments, canAcceptDrop, onAddImages, onAddFiles, onRemoveImage, onRemoveAttachment, dropLimits, t,
}: ComposerAttachmentsProps) {
  const removeAttachment = onRemoveAttachment ?? onRemoveImage
  const imageAttachments = useMemo(
    () => attachments.filter((attachment): attachment is Extract<ComposerAttachment, { kind: 'image' }> => attachment.kind === 'image'),
    [attachments],
  )
  const fileAttachments = useMemo(
    () => attachments.filter((attachment): attachment is ComposerFileAttachment => attachment.kind === 'file'),
    [attachments],
  )
  const [preview, setPreview] = useState<Extract<ComposerAttachment, { kind: 'image' }> | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const closePreview = useCallback(() => { setPreview(null) }, [])

  useEffect(() => {
    if (preview !== null && !imageAttachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [imageAttachments, preview])

  useEffect(() => {
    const fileTransfer = (event: globalThis.DragEvent): DataTransfer | null => {
      const dataTransfer = event.dataTransfer
      if (dataTransfer === null || (!dataTransfer.types.includes('Files') && !dataTransfer.types.includes('text/uri-list') && !dataTransfer.types.includes('text/html'))) return null
      return dataTransfer
    }
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      event.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
      const leftViewport = event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      reset()
      if (!canAcceptDrop) return
      const files = [...dataTransfer.files]
      if (files.length > 0) {
        const images = files.filter(file => file.type.startsWith('image/'))
        const documents = files.filter(file => !file.type.startsWith('image/'))
        if (images.length > 0) onAddImages(images)
        if (documents.length > 0) onAddFiles?.(documents)
        return
      }
      const rawUri = dataTransfer.getData('text/uri-list').split(/\r?\n/u).find(value => value.trim() !== '' && !value.startsWith('#'))?.trim()
        ?? (() => {
          const html = dataTransfer.getData('text/html')
          const match = html.match(/<img[^>]+src=["']([^"']+)["']/iu)
          return match?.[1]
        })()
      if (!rawUri) return
      void fetch(rawUri).then((response) => {
        if (!response.ok) throw new Error(`image drag fetch failed: ${response.status}`)
        return response.blob()
      }).then((blob) => {
        const name = rawUri.split(/[/?#]/u).filter(Boolean).pop() || 'dropped-image'
        const extension = blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/webp' ? '.webp' : '.png'
        onAddImages([new File([blob], name.includes('.') ? name : `${name}${extension}`, { type: blob.type || 'image/png' })])
      }).catch(() => undefined)
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, onAddFiles, onAddImages])

  const railItems = useMemo<ComposerRailItem[]>(() => imageAttachments.map(attachment => ({
    id: attachment.id,
    previewUrl: attachment.previewUrl,
    alt: attachment.file.name || t('image.pending'),
    removeLabel: t('image.remove', { name: attachment.file.name }),
    attachment,
  })), [imageAttachments, t])

  return (
    <>
      {dragActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, dropLimits)}
        />
      )}
      {(railItems.length > 0 || fileAttachments.length > 0) && (
        <div className={css.rail}>
          {railItems.length > 0 && <AttachmentRail
            items={railItems}
            labels={attachmentRailLabels(t)}
            onOpen={(item) => { setPreview(item.attachment) }}
            onRemove={(item) => { removeAttachment(item.attachment.id) }}
          />}
          {fileAttachments.length > 0 && <div className={css.files} role="list" aria-label={t('file.pending')}>
            {fileAttachments.map(file => <div className={css.file} role="listitem" key={file.id}>
              <span className={css.fileIcon} aria-hidden><IconDataOutline16 /></span>
              <span className={css.fileName} title={file.file.name}>{file.file.name || t('file.unnamed')}</span>
              <button type="button" className={css.fileRemove} aria-label={t('file.remove', { name: file.file.name })} onClick={() => { removeAttachment(file.id) }}>×</button>
            </div>)}
          </div>}
        </div>
      )}
      {preview !== null && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
    </>
  )
}
