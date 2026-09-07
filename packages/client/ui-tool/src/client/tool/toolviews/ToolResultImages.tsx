import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolCallOwnerProps } from '../../contract/slots.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './ToolResultImages.module.css'

function imageBlocks(block: ToolCallBlock): readonly ImageAttachmentRef[] {
  if (!('kind' in block)) return []
  return block.content.flatMap(item => item.type === 'image' ? [item.attachment] : [])
}

type FileAttachment = Parameters<NonNullable<ToolCallOwnerProps['openAttachment']>>[0]

function fileAttachment(image: ImageAttachmentRef): FileAttachment {
  return {
    attachmentId: image.attachmentId,
    name: image.name ?? image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
  }
}

/** Render durable image blocks from a Tool result through the Chat gallery. */
export function ToolResultImages({
  block, renderMessageImages, openAttachment,
}: {
  block: ToolCallBlock
  renderMessageImages?: ToolCallOwnerProps['renderMessageImages']
  openAttachment?: ToolCallOwnerProps['openAttachment']
}) {
  const images = imageBlocks(block)
  if (images.length === 0 || renderMessageImages === undefined) return null
  return (
    <div className={css.root} data-tool-result-images>
      {renderMessageImages({ images: images.map(attachment => ({ attachment })), align: 'start' })}
      <div className={css.files} role="list">
        {images.map((image) => {
          const attachment = fileAttachment(image)
          const label = image.name ?? image.attachmentId
          return <div key={image.attachmentId} role="listitem">
            <button
              type="button"
              className={css.file}
              disabled={openAttachment === undefined}
              onClick={() => openAttachment?.(attachment)}
            >
              {label}
            </button>
          </div>
        })}
      </div>
    </div>
  )
}
