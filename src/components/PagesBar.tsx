import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { BackgroundKind } from '../types'
import { Icon } from './icons'

const backgrounds: Array<{ id: BackgroundKind; label: string }> = [
  { id: 'white', label: 'Biała' },
  { id: 'grid', label: 'Kratka' },
  { id: 'dotted', label: 'Kropki' },
]

export function PagesBar({
  pages,
  names,
  current,
  background,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onBackground,
  canEdit = true,
}: {
  pages: string[]
  names: Record<string, string>
  current: string
  background: BackgroundKind
  onSelect: (id: string) => void
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onBackground: (background: BackgroundKind) => void
  canEdit?: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 flex w-[min(720px,calc(100%-6.5rem))] -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence mode="wait">
        {open ? (
          <motion.div
            key="open"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="pointer-events-auto flex min-w-0 max-w-full items-center gap-2 overflow-x-auto rounded-full border border-[var(--line)] bg-[var(--panel)] px-2 py-2 shadow-[var(--shadow)] backdrop-blur-md"
          >
        {pages.map((id, index) => (
          <div key={id} className={`flex items-center rounded-full ${current === id ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink)]'}`}>
            <button type="button" className="px-3 py-1.5 text-sm" onClick={() => onSelect(id)}>
              {index + 1}
            </button>
            {current === id && canEdit && (
              <input
                className="w-28 bg-transparent pr-2 text-sm outline-none placeholder:text-current/60"
                value={names[id] || ''}
                aria-label="Nazwa strony"
                onChange={(event) => onRename(id, event.target.value)}
              />
            )}
            {current === id && canEdit && pages.length > 1 && (
              <button type="button" className="pr-2" aria-label="Usuń stronę" onClick={() => onDelete(id)}>
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <button type="button" className="tip grid h-9 w-9 place-items-center rounded-full text-[var(--ink)] hover:bg-[var(--accent-2)]" data-tip="Nowa strona" onClick={onAdd}>
            <Icon name="plus" />
          </button>
        )}
        {canEdit && <span className="mx-1 h-6 w-px bg-[var(--line)]" />}
        {canEdit && backgrounds.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onBackground(item.id)}
            className={`rounded-full px-3 py-1.5 text-sm ${background === item.id ? 'bg-[var(--accent-2)] text-[var(--ink)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
          >
            {item.label}
          </button>
        ))}
            <button type="button" aria-label="Zwiń strony" onClick={() => setOpen(false)} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--muted)] hover:bg-[var(--accent-2)] hover:text-[var(--ink)]">
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        ) : (
          <motion.button
            key="closed"
            type="button"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            aria-label="Pokaż strony"
            onClick={() => setOpen(true)}
            className="pointer-events-auto grid h-12 w-12 place-items-center rounded-full border border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] shadow-[var(--shadow)] backdrop-blur-md"
          >
            <Icon name="grid" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
