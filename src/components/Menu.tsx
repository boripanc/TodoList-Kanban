import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

export function Menu({
  label,
  items,
  children,
  triggerClassName = 'icon-button',
}: {
  label: string
  items: MenuItem[]
  children: ReactNode
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu" ref={rootRef}>
      <button
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? 'danger' : undefined}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
