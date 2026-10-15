import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import katex from 'katex'
import type { BoardObject, TextObject } from '../types'
import type { WhiteboardEngine } from '../canvas/engine'
import { EQUATION_PRESETS } from '../lib/equation'
import { Icon } from './icons'

export function Toasts({ items }: { items: Array<{ id: string; text: string }> }) {
  return (
    <div className="pointer-events-none absolute right-4 top-20 z-50 flex w-80 flex-col gap-2">
      <AnimatePresence>
        {items.map((item) => (
          <motion.div key={item.id} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-2xl border border-[var(--line)] bg-[var(--panel-solid)] px-4 py-3 text-sm shadow-[var(--shadow)]">
            {item.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

export function ConfirmDialog({
  title,
  body,
  confirm,
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string
  body: string
  confirm: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <dialog open className="fixed inset-0 z-50 m-0 flex h-full w-full items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-3xl bg-[var(--panel-solid)] p-6 text-[var(--ink)] shadow-[var(--shadow)]" onClick={(event) => event.stopPropagation()}>
        <h2 className="font-[Fraunces] text-2xl">{title}</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">{body}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="rounded-full px-4 py-2 text-sm" onClick={onClose}>Anuluj</button>
          <button type="button" className={`rounded-full px-4 py-2 text-sm ${danger ? 'bg-[var(--danger)] text-white' : 'bg-[var(--accent)] text-[var(--accent-ink)]'}`} onClick={onConfirm}>{confirm}</button>
        </div>
      </div>
    </dialog>
  )
}

export function ShareDialog({
  link,
  onClose,
}: {
  link: string
  onClose: () => void
}) {
  return (
    <dialog open className="fixed inset-0 z-50 m-0 flex h-full w-full items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-3xl bg-[var(--panel-solid)] p-6 text-[var(--ink)] shadow-[var(--shadow)]" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-[Fraunces] text-2xl">Udostępnij tablicę</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Osoby z tym linkiem dołączają jako obserwujący. Edytujący może nadać im edycję na tablicy.</p>
          </div>
          <button type="button" aria-label="Zamknij" onClick={onClose}><Icon name="close" /></button>
        </div>
        <LinkRow label="Link" value={link} />
      </div>
    </dialog>
  )
}

function LinkRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-4">
      <div className="mb-1 text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="flex gap-2">
        <input readOnly value={value} className="min-w-0 flex-1 rounded-2xl border border-[var(--line)] bg-transparent px-3 py-2 text-sm" />
        <button
          type="button"
          className="rounded-2xl bg-[var(--accent)] px-4 text-sm text-[var(--accent-ink)]"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setCopied(true)
          }}
        >
          {copied ? 'Skopiowano' : 'Kopiuj'}
        </button>
      </div>
    </div>
  )
}

export function EquationDialog({
  initial,
  color,
  onClose,
  onInsert,
}: {
  initial: string
  color: string
  onClose: () => void
  onInsert: (tex: string) => void
}) {
  const [tex, setTex] = useState(initial)
  const preview = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!preview.current) return
    katex.render(tex.trim() || '\\,', preview.current, { throwOnError: false, displayMode: true })
  }, [tex])
  return (
    <dialog open className="fixed inset-0 z-50 m-0 flex h-full w-full items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-3xl bg-[var(--panel-solid)] p-6 text-[var(--ink)] shadow-[var(--shadow)]" onClick={(event) => event.stopPropagation()}>
        <h2 className="font-[Fraunces] text-2xl">Wzór</h2>
        <div className="mt-4 flex min-h-24 items-center justify-center overflow-auto rounded-2xl bg-[var(--bg)] p-4" style={{ color }} ref={preview} />
        <textarea value={tex} onChange={(event) => setTex(event.target.value)} className="mt-3 h-24 w-full rounded-2xl border border-[var(--line)] bg-transparent px-3 py-2 font-mono text-sm outline-none" placeholder="\frac{a}{b}" />
        <div className="mt-3 flex flex-wrap gap-2">
          {EQUATION_PRESETS.map((preset) => (
            <button key={preset.tex} type="button" className="rounded-full bg-[var(--accent-2)] px-3 py-1.5 text-sm" onClick={() => setTex((value) => `${value}${value ? ' ' : ''}${preset.tex}`)}>
              {preset.label}
            </button>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rounded-full px-4 py-2 text-sm" onClick={onClose}>Anuluj</button>
          <button type="button" className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm text-[var(--accent-ink)]" onClick={() => onInsert(tex.trim())}>Wstaw</button>
        </div>
      </div>
    </dialog>
  )
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows = [
    ['V', 'Zaznaczenie'],
    ['L', 'Lasso'],
    ['P', 'Pióro'],
    ['H', 'Zakreślacz'],
    ['E', 'Gumka (pikselowa lub obiektowa)'],
    ['T', 'Tekst'],
    ['R / O', 'Prostokąt / elipsa'],
    ['K', 'Wskaźnik'],
    ['Spacja / prawy przycisk', 'Przesuwanie'],
    ['Kółko myszy', 'Powiększenie'],
    ['Ctrl + 0 / 1', 'Reset / dopasuj'],
    ['Ctrl + Z / Y', 'Cofnij / ponów'],
    ['Ctrl + C / X / V / D', 'Kopiuj, wytnij, wklej, duplikuj'],
    ['Delete', 'Usuń'],
    ['?', 'Skróty'],
  ]
  return (
    <dialog open className="fixed inset-0 z-50 m-0 flex h-full w-full items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-3xl bg-[var(--panel-solid)] p-6 text-[var(--ink)] shadow-[var(--shadow)]" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-[Fraunces] text-2xl">Skróty</h2>
          <button type="button" onClick={onClose} aria-label="Zamknij"><Icon name="close" /></button>
        </div>
        <div className="mt-4 grid gap-2">
          {rows.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-4 text-sm">
              <span>{label}</span>
              <kbd className="rounded-lg bg-[var(--accent-2)] px-2 py-1">{key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </dialog>
  )
}

export function TimerDialog({
  onClose,
  onStart,
}: {
  onClose: () => void
  onStart: (minutes: number) => void
}) {
  const [minutes, setMinutes] = useState(5)
  return (
    <dialog open className="fixed inset-0 z-50 m-0 flex h-full w-full items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-3xl bg-[var(--panel-solid)] p-6 text-[var(--ink)]" onClick={(event) => event.stopPropagation()}>
        <h2 className="font-[Fraunces] text-2xl">Minutnik</h2>
        <input type="number" min={1} max={120} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} className="mt-4 w-full rounded-2xl border border-[var(--line)] bg-transparent px-3 py-2" />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-full px-4 py-2 text-sm" onClick={onClose}>Zamknij</button>
          <button type="button" className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm text-[var(--accent-ink)]" onClick={() => onStart(minutes)}>Start</button>
        </div>
      </div>
    </dialog>
  )
}

export function ContextMenu({
  x,
  y,
  canDraw,
  onAction,
  onClose,
}: {
  x: number
  y: number
  canDraw: boolean
  onAction: (action: string) => void
  onClose: () => void
}) {
  const items = [
    ['copy', 'Kopiuj'],
    ['cut', 'Wytnij'],
    ['paste', 'Wklej'],
    ['duplicate', 'Duplikuj'],
    ['front', 'Na wierzch'],
    ['back', 'Pod spód'],
    ['group', 'Grupuj'],
    ['ungroup', 'Rozgrupuj'],
    ['lock', 'Zablokuj'],
    ['unlock', 'Odblokuj'],
    ['delete', 'Usuń'],
  ]
  return (
    <>
      <button type="button" aria-label="Zamknij menu" className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div className="fixed z-50 min-w-44 rounded-2xl border border-[var(--line)] bg-[var(--panel-solid)] p-1 text-sm shadow-[var(--shadow)]" style={{ left: x, top: y }}>
        {items.map(([id, label]) => (
          <button
            key={id}
            type="button"
            disabled={!canDraw && id !== 'copy'}
            className="block w-full rounded-xl px-3 py-2 text-left hover:bg-[var(--accent-2)] disabled:opacity-40"
            onClick={() => { onAction(id); onClose() }}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  )
}

export function TextOverlay({
  engine,
  object,
  onChange,
  onClose,
}: {
  engine: WhiteboardEngine
  object: TextObject
  onChange: (text: string, height: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const objectRef = useRef(object)
  const opened = useRef(0)
  const rescued = useRef(false)
  objectRef.current = object
  useEffect(() => {
    const area = ref.current
    if (!area) return
    opened.current = performance.now()
    area.value = objectRef.current.text
    const place = () => {
      const current = objectRef.current
      const screen = engine.worldToScreen(current.x, current.y)
      const size = current.fontSize * engine.camera.zoom
      area.style.left = `${screen.x}px`
      area.style.top = `${screen.y}px`
      area.style.width = `${Math.max(48, current.w * engine.camera.zoom)}px`
      area.style.minHeight = `${Math.max(size * 1.25, current.h * engine.camera.zoom)}px`
      area.style.fontSize = `${size}px`
      area.style.fontWeight = current.bold ? '700' : '500'
      area.style.fontStyle = current.italic ? 'italic' : 'normal'
      area.style.textAlign = current.align
      area.style.color = current.color
      area.style.caretColor = current.color
      area.style.textDecoration = current.underline ? 'underline' : 'none'
    }
    const focus = () => {
      place()
      area.focus()
      const end = area.value.length
      area.setSelectionRange(end, end)
    }
    focus()
    const timer = window.setTimeout(focus, 30)
    let frame = 0
    const loop = () => {
      place()
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => {
      window.clearTimeout(timer)
      cancelAnimationFrame(frame)
    }
  }, [engine, object.id])
  return (
    <textarea
      ref={ref}
      rows={1}
      className="absolute z-20 resize-none overflow-hidden bg-transparent p-0 outline-none"
      style={{ fontFamily: 'Outfit, sans-serif', lineHeight: 1.25 }}
      onPointerDown={(event) => event.stopPropagation()}
      onChange={(event) => {
        const area = event.currentTarget
        const height = area.scrollHeight / engine.camera.zoom
        onChange(area.value, height)
      }}
      onBlur={(event) => {
        const area = event.currentTarget
        if (!rescued.current && performance.now() - opened.current < 220) {
          rescued.current = true
          window.setTimeout(() => area.focus(), 0)
          return
        }
        onChange(area.value, area.scrollHeight / engine.camera.zoom)
        onClose()
      }}
    />
  )
}

export function selectedText(object: BoardObject | null): TextObject | null {
  return object?.type === 'text' ? object : null
}
