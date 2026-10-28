import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  /** As wide as the screen allows, e.g. to read a document. */
  full?: boolean
}

/** Open modals, newest last: Escape closes only the top one (a file preview over a card, say). */
const openModals: object[] = []

export function Modal({ title, onClose, children, wide, full }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const focusable = panelRef.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, button')
    focusable?.focus()
    const self = {}
    openModals.push(self)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openModals[openModals.length - 1] === self) {
        event.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      openModals.splice(openModals.indexOf(self), 1)
      previous?.focus?.()
    }
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={`modal ${wide ? 'modal-wide' : ''} ${full ? 'modal-full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {children}
      </div>
    </div>
  )
}
