import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { Tool } from '../types'
import { Icon } from './icons'

type ToolItem = { id: Tool; icon: string; tip: string; draw?: boolean }

const selectTools: ToolItem[] = [
  { id: 'select', icon: 'select', tip: 'Zaznaczenie (V)' },
  { id: 'laser', icon: 'laser', tip: 'Wskaźnik (K)' },
  { id: 'hand', icon: 'hand', tip: 'Przesuwanie (Spacja)' },
]

const drawTools: ToolItem[] = [
  { id: 'pen', icon: 'pen', tip: 'Pióro (P)', draw: true },
  { id: 'highlighter', icon: 'highlighter', tip: 'Zakreślacz (H)', draw: true },
  { id: 'eraser', icon: 'eraser', tip: 'Gumka (E)', draw: true },
]

const figureTools: ToolItem[] = [
  { id: 'line', icon: 'line', tip: 'Linia', draw: true },
  { id: 'arrow', icon: 'arrow', tip: 'Strzałka', draw: true },
  { id: 'rect', icon: 'rect', tip: 'Prostokąt (R)', draw: true },
  { id: 'ellipse', icon: 'ellipse', tip: 'Elipsa (O)', draw: true },
  { id: 'triangle', icon: 'triangle', tip: 'Trójkąt', draw: true },
  { id: 'cuboid', icon: 'cuboid', tip: 'Prostopadłościan', draw: true },
  { id: 'axes', icon: 'axes', tip: 'Układ kartezjański', draw: true },
]

const stampTools: ToolItem[] = [
  { id: 'check', icon: 'check', tip: 'Ptaszek', draw: true },
  { id: 'cross', icon: 'cross', tip: 'Krzyżyk', draw: true },
]

const elementSections = [
  { title: 'Figury geometryczne', items: figureTools },
  { title: 'Znaczki', items: stampTools },
]

const elementTools = elementSections.flatMap((section) => section.items)

const groups: Array<{ id: string; tip: string; items: ToolItem[]; sections?: Array<{ title: string; items: ToolItem[] }> }> = [
  { id: 'select', tip: 'Zaznaczanie', items: selectTools },
  { id: 'draw', tip: 'Pisanie', items: drawTools },
  { id: 'shapes', tip: 'Elementy', items: elementTools, sections: elementSections },
]

export function Toolbar({
  tool,
  setTool,
  open,
  setOpen,
  canDraw,
  onUndo,
  onRedo,
  onImage,
  onClearPage,
  onClearBoard,
}: {
  tool: Tool
  setTool: (tool: Tool) => void
  open: boolean
  setOpen: (open: boolean) => void
  canDraw: boolean
  onUndo: () => void
  onRedo: () => void
  onImage: () => void
  onClearPage: () => void
  onClearBoard: () => void
}) {
  const [menu, setMenu] = useState<string | null>(null)
  const anchors = useRef<Record<string, HTMLDivElement | null>>({})
  const memory = useRef<Record<string, Tool>>({
    select: 'select',
    draw: 'pen',
    shapes: 'rect',
  })
  const currentIcon = [...selectTools, ...drawTools, ...elementTools, { id: 'lasso' as const, icon: 'lasso', tip: '' }, { id: 'text' as const, icon: 'text', tip: '' }, { id: 'image' as const, icon: 'image', tip: '' }].find((item) => item.id === tool)?.icon || 'pen'

  const pick = (groupId: string, next: Tool) => {
    memory.current[groupId] = next
    setTool(next)
    setMenu(null)
  }

  return (
    <div className="pointer-events-none absolute left-3 top-20 z-30">
      <AnimatePresence mode="wait">
        {open ? (
          <motion.div
            key="open"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="pointer-events-auto dock flex max-h-[calc(100dvh-8.75rem)] flex-col gap-1 overflow-x-hidden overflow-y-auto overscroll-contain rounded-[28px] border border-[var(--line)] bg-[var(--panel)] p-2 shadow-[var(--shadow)] backdrop-blur-md [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden!"
          >
            {groups.map((group) => {
              const active = group.items.find((item) => item.id === tool)
              const remembered = group.items.find((item) => item.id === memory.current[group.id]) || group.items[0]
              const shown = active || remembered
              const blocked = group.items.every((item) => item.draw) && !canDraw
              return (
                <div key={group.id} ref={(node) => { anchors.current[group.id] = node }} className="relative shrink-0">
                  <ToolButton
                    icon={shown.icon}
                    tip={active ? shown.tip : group.tip}
                    active={Boolean(active)}
                    disabled={blocked}
                    onClick={() => {
                      if (menu === group.id) {
                        setMenu(null)
                        return
                      }
                      if (!active) {
                        memory.current[group.id] = shown.id
                        setTool(shown.id)
                      }
                      setMenu(group.id)
                    }}
                  />
                  {menu === group.id && (
                    group.sections ? (
                      <SectionFlyout anchor={anchors.current[group.id]} sections={group.sections} tool={tool} canDraw={canDraw} onPick={(next) => pick(group.id, next)} />
                    ) : (
                      <Flyout anchor={anchors.current[group.id]}>
                        {group.items.map((item) => (
                          <ToolButton
                            key={item.id}
                            icon={item.icon}
                            tip={item.tip}
                            active={tool === item.id}
                            disabled={Boolean(item.draw && !canDraw)}
                            onClick={() => pick(group.id, item.id)}
                          />
                        ))}
                      </Flyout>
                    )
                  )}
                </div>
              )
            })}
            <ToolButton icon="text" tip="Tekst (T)" active={tool === 'text'} disabled={!canDraw} onClick={() => { setTool('text'); setMenu(null) }} />
            <ToolButton icon="image" tip="Obraz lub PDF" active={tool === 'image'} disabled={!canDraw} onClick={() => { setTool('image'); setMenu(null); onImage() }} />
            <ToolButton icon="lasso" tip="Lasso (L)" active={tool === 'lasso'} disabled={!canDraw} onClick={() => { setTool('lasso'); setMenu(null) }} />
            <span className="mx-1 my-1 h-px shrink-0 bg-[var(--line)]" />
            <ToolButton icon="undo" tip="Cofnij (Ctrl+Z)" disabled={!canDraw} onClick={onUndo} />
            <ToolButton icon="redo" tip="Ponów (Ctrl+Y)" disabled={!canDraw} onClick={onRedo} />
            {canDraw && (
              <div ref={(node) => { anchors.current.clear = node }} className="relative shrink-0">
                <ToolButton icon="trash" tip="Czyszczenie" active={menu === 'clear'} onClick={() => setMenu(menu === 'clear' ? null : 'clear')} />
                {menu === 'clear' && (
                  <AnchoredPanel anchor={anchors.current.clear} className="fixed z-40 flex w-44 flex-col gap-1 overflow-y-auto rounded-3xl border border-[var(--line)] bg-[var(--panel-solid)] p-2 shadow-[var(--shadow)] [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden!">
                    <button type="button" className="rounded-2xl px-3 py-2 text-left text-sm text-[var(--ink)] hover:bg-[var(--accent-2)]" onClick={() => { setMenu(null); onClearPage() }}>Wyczyść stronę</button>
                    <button type="button" className="rounded-2xl px-3 py-2 text-left text-sm text-[var(--danger)] hover:bg-[var(--accent-2)]" onClick={() => { setMenu(null); onClearBoard() }}>Całość</button>
                  </AnchoredPanel>
                )}
              </div>
            )}
            <ToolButton icon="close" tip="Zwiń pasek" onClick={() => { setMenu(null); setOpen(false) }} />
          </motion.div>
        ) : (
          <motion.button
            key="closed"
            type="button"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="pointer-events-auto tip grid h-14 w-14 place-items-center rounded-full border border-[var(--line)] bg-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--shadow)]"
            data-tip="Pokaż narzędzia"
            onClick={() => setOpen(true)}
          >
            <Icon name={currentIcon} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

function Flyout({ anchor, children }: { anchor: HTMLElement | null; children: ReactNode }) {
  return (
    <AnchoredPanel anchor={anchor} className="fixed z-40 flex flex-col gap-1 overflow-x-hidden overflow-y-auto rounded-3xl border border-[var(--line)] bg-[var(--panel-solid)] p-2 shadow-[var(--shadow)] [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden!">
      {children}
    </AnchoredPanel>
  )
}

function SectionFlyout({
  anchor,
  sections,
  tool,
  canDraw,
  onPick,
}: {
  anchor: HTMLElement | null
  sections: Array<{ title: string; items: ToolItem[] }>
  tool: Tool
  canDraw: boolean
  onPick: (tool: Tool) => void
}) {
  return (
    <AnchoredPanel anchor={anchor} className="fixed z-40 w-[min(16.5rem,calc(100vw-6.5rem))] overflow-x-hidden overflow-y-auto rounded-3xl border border-[var(--line)] bg-[var(--panel-solid)] p-3 shadow-[var(--shadow)] [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden!">
      {sections.map((section) => (
        <div key={section.title} className="mb-3 last:mb-0">
          <p className="px-1 pb-1.5 text-[11px] font-medium tracking-wide text-[var(--muted)]">{section.title}</p>
          <div className="grid grid-cols-4 gap-1">
            {section.items.map((item) => (
              <ToolButton
                key={item.id}
                icon={item.icon}
                tip={item.tip}
                active={tool === item.id}
                disabled={Boolean(item.draw && !canDraw)}
                onClick={() => onPick(item.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </AnchoredPanel>
  )
}

function AnchoredPanel({ anchor, className, children }: { anchor: HTMLElement | null; className: string; children: ReactNode }) {
  const [box, setBox] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const top = Math.max(12, Math.min(rect.top, window.innerHeight - 80))
      setBox({ top, left: rect.right + 10, maxHeight: Math.max(96, window.innerHeight - top - 12) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])
  if (!box) return null
  return createPortal(
    <div className={className} style={{ top: box.top, left: box.left, maxHeight: box.maxHeight }}>
      {children}
    </div>,
    document.body,
  )
}

function ToolButton({
  icon,
  tip,
  active,
  disabled,
  onClick,
}: {
  icon: string
  tip: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const [tipAt, setTipAt] = useState<{ x: number; y: number; above: boolean } | null>(null)
  const placeTip = (target: HTMLButtonElement) => {
    const rect = target.getBoundingClientRect()
    const above = rect.right + 150 > window.innerWidth
    setTipAt(above
      ? { x: rect.left + rect.width / 2, y: rect.top - 8, above: true }
      : { x: rect.right + 10, y: rect.top + rect.height / 2, above: false })
  }
  return (
    <>
      <button
        type="button"
        aria-label={tip}
        disabled={disabled}
        onClick={() => {
          setTipAt(null)
          onClick()
        }}
        onMouseEnter={(event) => placeTip(event.currentTarget)}
        onMouseLeave={() => setTipAt(null)}
        onFocus={(event) => placeTip(event.currentTarget)}
        onBlur={() => setTipAt(null)}
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl transition disabled:cursor-not-allowed disabled:opacity-35 ${active ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink)] hover:bg-[var(--accent-2)]'}`}
      >
        <Icon name={icon} className="h-[22px] w-[22px]" />
      </button>
      {tipAt && createPortal(
        <span
          className={`pointer-events-none fixed z-[80] whitespace-nowrap rounded-full bg-[var(--ink)] px-2.5 py-1 text-xs text-[var(--bg)] ${tipAt.above ? '-translate-x-1/2 -translate-y-full' : '-translate-y-1/2'}`}
          style={{ left: tipAt.x, top: tipAt.y }}
        >
          {tip}
        </span>,
        document.body,
      )}
    </>
  )
}
