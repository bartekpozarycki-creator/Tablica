import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import type { BoardPerson } from '../types'
import { bookingUrl } from '../lib/utils'
import { Icon } from './icons'

export function TopBar({
  title,
  onTitle,
  onTitleFocus,
  onTitleBlur,
  save,
  cloud = false,
  people,
  canEdit,
  canManage,
  onGrant,
  onRevoke,
  timerLabel,
  presentation,
  bookingId,
  onBack,
  onShare,
  onExportPng,
  onExportPdf,
  onTimer,
  onStopTimer,
  onPresentation,
  onFullscreen,
  onFit,
  onShortcuts,
  onTheme,
  theme,
}: {
  title: string
  onTitle: (value: string) => void
  onTitleFocus: () => void
  onTitleBlur: (value: string) => void
  save: 'saved' | 'saving' | 'local'
  cloud?: boolean
  people: BoardPerson[]
  canEdit: boolean
  canManage: boolean
  onGrant: (person: BoardPerson) => void
  onRevoke: (person: BoardPerson) => void
  timerLabel: string
  presentation: boolean
  bookingId: string
  onBack: () => void
  onShare: () => void
  onExportPng: () => void
  onExportPdf: () => void
  onTimer: () => void
  onStopTimer: () => void
  onPresentation: () => void
  onFullscreen: () => void
  onFit: () => void
  onShortcuts: () => void
  onTheme: (theme: string) => void
  theme: string
}) {
  const [exportOpen, setExportOpen] = useState(false)
  const [open, setOpen] = useState(true)
  const [barHover, setBarHover] = useState(false)
  const saveLabel = save === 'saving' ? 'Zapisywanie' : save === 'local' ? (cloud ? 'Brak zapisu' : 'Zapis lokalny') : 'Zapisano'
  const lesson = bookingUrl(bookingId)
  return (
    <header className="pointer-events-none absolute left-3 right-3 top-3 z-30 flex items-center justify-between gap-2">
      <div className="pointer-events-auto flex w-36 shrink-0 items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--panel)] px-1.5 py-1.5 shadow-[var(--shadow)] backdrop-blur-md min-[960px]:w-72 min-[960px]:gap-2 min-[960px]:px-2">
        <button type="button" className="tip grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-[var(--accent-2)]" data-tip="Tablice" onClick={onBack}>
          <Icon name="back" />
        </button>
        <input
          value={title}
          onChange={(event) => onTitle(event.target.value)}
          onFocus={onTitleFocus}
          onBlur={(event) => onTitleBlur(event.target.value)}
          readOnly={!canEdit}
          aria-label="Nazwa lekcji"
          className="min-w-0 flex-1 bg-transparent font-[Fraunces] text-lg outline-none"
        />
      </div>
      {!presentation && (
        <AnimatePresence mode="wait">
          {open ? (
            <motion.div
              key="open"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              onHoverStart={() => setBarHover(true)}
              onHoverEnd={() => setBarHover(false)}
              className="pointer-events-auto ml-auto h-14 min-w-0 max-w-[calc(100%-9.5rem)] overflow-x-auto rounded-full border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)] backdrop-blur-md [scrollbar-width:none] min-[960px]:max-w-[calc(100%-19rem)] [&::-webkit-scrollbar]:hidden"
            >
              <div className="flex h-full w-max min-w-full items-center justify-end gap-0.5 p-1.5">
                <motion.span
                  initial={false}
                  animate={{ width: barHover ? 144 : 0, opacity: barHover ? 1 : 0 }}
                  transition={{ duration: 0.16 }}
                  className="hidden h-10 shrink-0 items-center justify-center overflow-hidden whitespace-nowrap text-xs text-[var(--muted)] min-[960px]:flex"
                >
                  {saveLabel}
                </motion.span>
                <PeopleMenu people={people} canEdit={canEdit} canManage={canManage} onGrant={onGrant} onRevoke={onRevoke} />
                {lesson && (
                  <a className="hidden rounded-full px-3 py-2 text-sm hover:bg-[var(--accent-2)] min-[960px]:inline" href={lesson} target="_blank" rel="noreferrer">
                    Rezerwacja
                  </a>
                )}
                {(canEdit || timerLabel) && <TimerControl label={timerLabel} canEdit={canEdit} onTimer={onTimer} onStop={onStopTimer} />}
                <IconButton icon="fit" tip="Dopasuj" onClick={onFit} />
                <IconButton icon="fullscreen" tip="Pełny ekran" onClick={onFullscreen} />
                <IconButton icon="share" tip="Udostępnij" onClick={onShare} />
                <ExportMenu open={exportOpen} setOpen={setExportOpen} onExportPng={onExportPng} onExportPdf={onExportPdf} />
                {canEdit && <IconButton icon="presentation" tip="Prezentacja" onClick={onPresentation} />}
                <button type="button" className="shrink-0 rounded-full px-3 py-2 text-sm" onClick={onShortcuts}>?</button>
                <ThemeSwitch theme={theme} onTheme={onTheme} />
                <IconButton icon="close" tip="Zwiń" onClick={() => setOpen(false)} />
              </div>
            </motion.div>
          ) : (
            <motion.button
              key="closed"
              type="button"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              aria-label="Pokaż pasek"
              onClick={() => setOpen(true)}
              className="pointer-events-auto ml-auto grid h-12 w-12 place-items-center rounded-full border border-[var(--line)] bg-[var(--panel)] text-[var(--ink)] shadow-[var(--shadow)] backdrop-blur-md"
            >
              <Icon name="menu" />
            </motion.button>
          )}
        </AnimatePresence>
      )}
      {presentation && (
        <button type="button" className="pointer-events-auto ml-auto rounded-full bg-[var(--accent)] px-4 py-2 text-sm text-[var(--accent-ink)] shadow-[var(--shadow)]" onClick={onPresentation}>
          Zakończ prezentację
        </button>
      )}
    </header>
  )
}

function PeopleMenu({
  people,
  canEdit,
  canManage,
  onGrant,
  onRevoke,
}: {
  people: BoardPerson[]
  canEdit: boolean
  canManage: boolean
  onGrant: (person: BoardPerson) => void
  onRevoke: (person: BoardPerson) => void
}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState({ top: 0, right: 0 })
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (root.current?.contains(target) || panel.current?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  const ordered = [...people].sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name, 'pl'))
  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        className="flex items-center gap-2 rounded-full px-1 py-1 hover:bg-[var(--accent-2)]"
        aria-expanded={open}
        aria-label="Uczestnicy"
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect()
          if (rect) setPlace({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) })
          setOpen((value) => !value)
        }}
      >
        <span className="flex -space-x-2">
          {people.slice(0, 4).map((person) => (
            <span key={person.id} title={person.name} className="grid h-8 w-8 place-items-center rounded-full border-2 border-[var(--panel-solid)] text-xs font-semibold text-white" style={{ background: person.color }}>
              {person.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
        <span className="hidden pr-2 text-xs text-[var(--muted)] min-[960px]:inline">{canEdit ? 'Edytujący' : 'Obserwujący'}</span>
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div ref={panel} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} style={{ top: place.top, right: place.right }} className="fixed z-[60] w-[min(22rem,calc(100vw-1rem))] rounded-3xl border border-[var(--line)] bg-[var(--panel-solid)] p-3 text-[var(--ink)] shadow-[var(--shadow)]">
              <p className="px-1 font-[Fraunces] text-lg">Na tablicy</p>
              <p className="px-1 pb-2 text-xs text-[var(--muted)]">{peopleLabel(people.length)}</p>
              <div className="grid max-h-72 gap-1 overflow-auto">
                {ordered.map((person) => (
                  <div key={person.id} className="flex items-center gap-2 rounded-2xl px-2 py-2">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: person.color }}>
                      {person.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{person.name}{person.self ? ' (Ty)' : ''}</span>
                      <span className="block text-xs text-[var(--muted)]">{person.role === 'teacher' ? 'Założyciel' : person.access === 'editor' ? 'Edytujący' : 'Obserwujący'}</span>
                    </span>
                    {canEdit && !person.self && person.access === 'observer' && (
                      <button type="button" className="shrink-0 rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs text-[var(--accent-ink)]" onClick={() => { setOpen(false); onGrant(person) }}>
                        Nadaj edycję
                      </button>
                    )}
                    {canManage && !person.self && person.role !== 'teacher' && person.access === 'editor' && (
                      <button type="button" className="shrink-0 rounded-full bg-[var(--danger)] px-3 py-1.5 text-xs text-white" onClick={() => { setOpen(false); onRevoke(person) }}>
                        Odbierz edycję
                      </button>
                    )}
                  </div>
                ))}
                {people.length === 0 && <p className="px-2 py-3 text-sm text-[var(--muted)]">Jeszcze nikogo nie widać.</p>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}

function peopleLabel(count: number) {
  if (count === 1) return '1 osoba na tej tablicy.'
  const mod = count % 10
  const hundred = count % 100
  if (mod >= 2 && mod <= 4 && (hundred < 12 || hundred > 14)) return `${count} osoby na tej tablicy.`
  return `${count} osób na tej tablicy.`
}

function TimerControl({
  label,
  canEdit,
  onTimer,
  onStop,
}: {
  label: string
  canEdit: boolean
  onTimer: () => void
  onStop: () => void
}) {
  const [blink, setBlink] = useState(false)
  const previous = useRef(label)
  useEffect(() => {
    const before = previous.current
    previous.current = label
    if (!before || before === '00:00' || label !== '00:00') return
    setBlink(true)
    const timer = window.setTimeout(() => setBlink(false), 1400)
    return () => window.clearTimeout(timer)
  }, [label])
  return (
    <motion.div
      className="group relative h-10 w-10 shrink-0"
      animate={blink ? { opacity: [1, 0.15, 1, 0.15, 1, 0.15, 1] } : { opacity: 1 }}
      transition={blink ? { duration: 1.35, ease: 'easeInOut' } : { duration: 0.15 }}
    >
      {canEdit ? (
        <IconButton icon="timer" tip={label ? `Minutnik ${label}` : 'Minutnik'} onClick={onTimer} className={label === '00:00' ? 'text-[var(--danger)]' : label ? 'text-[var(--accent)]' : ''} />
      ) : (
        <span className={`grid h-10 w-10 place-items-center rounded-full ${label === '00:00' ? 'text-[var(--danger)]' : label ? 'text-[var(--accent)]' : ''}`}>
          <Icon name="timer" />
        </span>
      )}
      {label && (
        label === '00:00' ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-[var(--panel)] text-[10px] tabular-nums tracking-tight text-[var(--danger)]">
            {label}
          </span>
        ) : (
          <button type="button" onClick={canEdit ? onStop : undefined} className={`absolute inset-0 items-center justify-center rounded-full bg-[var(--panel)] text-[10px] tabular-nums tracking-tight text-[var(--accent)] ${blink ? 'flex' : 'hidden group-hover:flex'}`}>
            {label}
          </button>
        )
      )}
    </motion.div>
  )
}

function ExportMenu({
  open,
  setOpen,
  onExportPng,
  onExportPdf,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  onExportPng: () => void
  onExportPdf: () => void
}) {
  const [place, setPlace] = useState({ top: 0, right: 0 })
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open, setOpen])
  return (
    <div ref={root} className="relative shrink-0">
      <IconButton
        icon="download"
        tip="Eksport"
        onClick={() => {
          const rect = root.current?.getBoundingClientRect()
          if (rect) setPlace({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) })
          setOpen(!open)
        }}
      />
      {open && (
        <div style={{ top: place.top, right: place.right }} className="fixed z-50 w-40 rounded-2xl border border-[var(--line)] bg-[var(--panel-solid)] p-1 text-sm shadow-[var(--shadow)]">
          <button type="button" className="block w-full rounded-xl px-3 py-2 text-left hover:bg-[var(--accent-2)]" onClick={() => { setOpen(false); onExportPng() }}>PNG</button>
          <button type="button" className="block w-full rounded-xl px-3 py-2 text-left hover:bg-[var(--accent-2)]" onClick={() => { setOpen(false); onExportPdf() }}>PDF</button>
        </div>
      )}
    </div>
  )
}

function IconButton({ icon, tip, onClick, className = '' }: { icon: string; tip: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" data-tip={tip} className={`tip grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-[var(--accent-2)] ${className}`} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}

function ThemeSwitch({ theme, onTheme }: { theme: string; onTheme: (theme: string) => void }) {
  const items = [
    { id: 'sand', className: 'bg-[#f3ebdd]' },
    { id: 'ink', className: 'bg-[#1c1917]' },
    { id: 'forest', className: 'bg-[#1f6b45]' },
  ]
  return (
    <div className="flex shrink-0 items-center gap-1 px-1">
      {items.map((item) => (
        <button key={item.id} type="button" aria-label={item.id} onClick={() => onTheme(item.id)} className={`h-5 w-5 rounded-full border ${item.className} ${theme === item.id ? 'border-[var(--ink)]' : 'border-transparent'}`} />
      ))}
    </div>
  )
}
