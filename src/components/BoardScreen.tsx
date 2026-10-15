import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import type { Align, BackgroundKind, BoardAccess, BoardObject, BoardPerson, EraserMode, Presence, PresenceUser, Role, StylePatch, Tool } from '../types'
import { acquireSession, ensureReady, listObjects, mutate, releaseSession, type BoardSession } from '../collab/session'
import { WhiteboardEngine, type EngineBridge, type EngineHandlers } from '../canvas/engine'
import { joinBoardRecord, boardOwnerId, ownerTeacherKey, rememberTeacherKey, renameRemoteBoard, saveBoardSnapshot, setMemberAccess, teacherKeyFor } from '../lib/boards'
import { currentAccount, supabase } from '../supabase/client'
import { downloadCanvas, downloadPdf } from '../lib/export'
import { rasterizeEquation } from '../lib/equation'
import { prepareImage, renderPdf } from '../lib/files'
import { asObject, clientToken, colorFor, readName, readPalette, readTheme, uid, writePalette, writeTheme } from '../lib/utils'
import { PagesBar } from './PagesBar'
import { Toolbar } from './Toolbar'
import { TopBar } from './TopBar'
import { ConfirmDialog, ContextMenu, EquationDialog, ShareDialog, ShortcutsDialog, TextOverlay, TimerDialog, Toasts } from './overlays'

function filesFromClipboard(data: DataTransfer | null) {
  if (!data) return []
  const files: File[] = []
  const seen = new Set<string>()
  const push = (file: File | null, typeHint = '') => {
    if (!file) return
    const type = file.type || typeHint
    const name = file.name.toLowerCase()
    const image = type.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(name)
    const pdf = type === 'application/pdf' || name.endsWith('.pdf')
    if (!image && !pdf) return
    const key = `${file.size}:${name}:${type}`
    if (seen.has(key)) return
    seen.add(key)
    files.push(file.type ? file : new File([file], file.name || (pdf ? 'plik.pdf' : 'obraz.png'), { type: type || (pdf ? 'application/pdf' : 'image/png'), lastModified: file.lastModified }))
  }
  for (const item of data.items) {
    if (item.kind === 'file') push(item.getAsFile(), item.type)
  }
  for (const file of data.files) push(file)
  return files
}

const toolKeys: Record<string, Tool> = {
  v: 'select',
  l: 'lasso',
  p: 'pen',
  h: 'highlighter',
  e: 'eraser',
  t: 'text',
  r: 'rect',
  o: 'ellipse',
  k: 'laser',
}

export function BoardScreen({ boardId, navigate }: { boardId: string; navigate: (path: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<WhiteboardEngine | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bridge = useRef<EngineBridge>({
    tool: 'pen',
    color: '#1c1917',
    size: 4,
    opacity: 0.45,
    fill: 'transparent',
    strokeWidth: 3,
    fontSize: 28,
    bold: false,
    italic: false,
    underline: false,
    align: 'left',
    canDraw: true,
    pageId: '',
    role: 'teacher',
    userName: 'Użytkownik',
    userColor: '#1f6b45',
    follow: false,
    space: false,
    eraserSize: 28,
    eraserMode: 'pixel',
    xStep: 1,
    yStep: 1,
  })
  const handlers = useRef<EngineHandlers>({
    onSelection: () => undefined,
    onEditText: () => undefined,
    onEditEquation: () => undefined,
    onEquationAt: () => undefined,
    onImageRequest: () => undefined,
    onToast: () => undefined,
    onFollowPage: () => undefined,
    onFollowStop: () => undefined,
    onContext: () => undefined,
  })
  const [session, setSession] = useState<BoardSession | null>(null)
  const [engineReady, setEngineReady] = useState(false)
  const [contentReady, setContentReady] = useState(false)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#1c1917')
  const [size, setSize] = useState(4)
  const [eraserSize, setEraserSize] = useState(28)
  const [eraserMode, setEraserMode] = useState<EraserMode>('pixel')
  const [opacity, setOpacity] = useState(0.45)
  const [fill, setFill] = useState('transparent')
  const [strokeWidth, setStrokeWidth] = useState(3)
  const [fontSize, setFontSize] = useState(28)
  const [bold, setBold] = useState(false)
  const [italic, setItalic] = useState(false)
  const [underline, setUnderline] = useState(false)
  const [align, setAlign] = useState<Align>('left')
  const [xStep, setXStep] = useState(1)
  const [yStep, setYStep] = useState(1)
  const [pageId, setPageId] = useState('')
  const [pages, setPages] = useState<string[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [title, setTitle] = useState('Lekcja')
  const [penColors, setPenColors] = useState(() => readPalette('pen'))
  const [highlighterColors, setHighlighterColors] = useState(() => readPalette('highlighter'))
  const titleEditing = useRef(false)
  const [background, setBackground] = useState<BackgroundKind>(() => readPaper(boardId))
  const [selection, setSelection] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [equation, setEquation] = useState<{ x: number; y: number; id?: string; tex: string } | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [timerOpen, setTimerOpen] = useState(false)
  const [toolbarOpen, setToolbarOpen] = useState(true)
  const [propertiesOpen, setPropertiesOpen] = useState(true)
  const [presentation, setPresentation] = useState(false)
  const [toasts, setToasts] = useState<Array<{ id: string; text: string }>>([])
  const [save, setSave] = useState<'saved' | 'saving' | 'local'>('saved')
  const [people, setPeople] = useState<BoardPerson[]>([])
  const [grants, setGrants] = useState<Record<string, string>>({})
  const [userId, setUserId] = useState('')
  const [owner, setOwner] = useState(false)
  const [remoteAccess, setRemoteAccess] = useState<BoardAccess | null>(null)
  const clientId = useMemo(() => clientToken(), [])
  const [follow, setFollow] = useState(false)
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; confirm: string; danger?: boolean; run: () => void } | null>(null)
  const [timerEnd, setTimerEnd] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [bookingId, setBookingId] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [theme, setTheme] = useState(readTheme())
  const [, setRevision] = useState(0)
  const teacherKey = teacherKeyFor(boardId)
  const role: Role = teacherKey ? 'teacher' : 'student'
  const userColor = useMemo(() => colorFor(`${boardId}:${readName() || role}`), [boardId, role])
  const [name] = useState(readName() || 'Użytkownik')
  const [access, setAccess] = useState<{ id: string; key: string } | null>(null)
  const held = Boolean(access?.key)
  const revoked = !held && (grants[clientId] === 'observer' || Boolean(userId && grants[userId] === 'observer'))
  const canDraw = !revoked && (held || remoteAccess === 'editor' || grants[clientId] === 'editor' || Boolean(userId && grants[userId] === 'editor'))

  const toast = (text: string) => {
    const id = uid()
    setToasts((items) => [...items, { id, text }])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3400)
  }

  bridge.current = {
    ...bridge.current,
    tool,
    color,
    size,
    opacity,
    fill,
    strokeWidth,
    fontSize,
    bold,
    italic,
    underline,
    align,
    canDraw,
    pageId,
    role,
    userName: name,
    userColor,
    follow,
    eraserSize,
    eraserMode,
    xStep,
    yStep,
  }
  handlers.current = {
    onSelection: setSelection,
    onEditText: (id) => {
      setEditingId(id)
      engineRef.current?.setEditing(id)
    },
    onEditEquation: (id) => {
      if (!id || !session) return
      const object = asObject(session.objects.get(id))
      if (!object || object.type !== 'equation') return
      setEquation({ x: object.x, y: object.y, id: object.id, tex: object.tex })
    },
    onEquationAt: (x, y) => setEquation({ x, y, tex: '' }),
    onImageRequest: () => fileRef.current?.click(),
    onToast: toast,
    onFollowPage: setPageId,
    onFollowStop: () => setFollow(false),
    onContext: (x, y) => setContext({ x, y }),
  }

  useEffect(() => {
    let dead = false
    setAccess(null)
    setRemoteAccess(null)
    setGrants({})
    const params = new URLSearchParams(location.search)
    void (async () => {
      let key = params.get('k') || ''
      if (key) rememberTeacherKey(boardId, key)
      if (!key) key = teacherKeyFor(boardId)
      if (!key) key = await ownerTeacherKey(boardId)
      const account = await currentAccount()
      let joined: BoardAccess = 'observer'
      if (account) {
        try {
          joined = await joinBoardRecord(boardId, account.id, key ? 'editor' : 'observer')
        } catch {
          joined = 'observer'
        }
      }
      if (!dead) {
        setUserId(account?.id || '')
        setRemoteAccess(key ? 'editor' : joined)
        setAccess({ id: boardId, key })
        const ownerId = await boardOwnerId(boardId)
        const mine = Boolean(account && ownerId && ownerId === account.id)
        if (!dead) setOwner(mine || (!ownerId && Boolean(key)))
      }
    })()
    return () => {
      dead = true
    }
  }, [boardId])

  useEffect(() => {
    if (!access || access.id !== boardId) return
    const params = new URLSearchParams(location.search)
    const next = acquireSession(boardId, access.key ? 'teacher' : 'student', access.key)
    setSession(next)
    setContentReady(false)
    let dead = false
    void ensureReady(next, 'Nowa lekcja', params.get('booking') || '').then(() => {
      if (!dead) {
        setRevision((value) => value + 1)
        setContentReady(true)
      }
    }).catch(() => {
      if (!dead) setContentReady(true)
    })
    return () => {
      dead = true
      releaseSession(boardId)
      setSession(null)
    }
  }, [access, boardId])

  useEffect(() => {
    const host = hostRef.current
    if (!session || !host) return
    const engine = new WhiteboardEngine(host, session, bridge, handlers)
    engine.setBackground(background)
    engineRef.current = engine
    let dead = false
    void engine.init().then(() => {
      if (!dead) setEngineReady(true)
    })
    return () => {
      dead = true
      engine.destroy()
      engineRef.current = null
      setEngineReady(false)
    }
  }, [session])

  useEffect(() => {
    engineRef.current?.syncToolPreview()
  }, [tool, eraserSize, eraserMode])

  useEffect(() => {
    if (!session) return
    const sync = () => {
      const list = session.pages.toArray()
      setPages(list)
      setPageId((current) => (current && list.includes(current) ? current : list[0] || ''))
      const nextNames: Record<string, string> = {}
      session.pageNames.forEach((value, key) => {
        nextNames[key] = value
      })
      setNames(nextNames)
      if (!titleEditing.current) setTitle(String(session.meta.get('title') || 'Lekcja'))
      setPresentation(session.meta.get('presentation') === true)
      setTimerEnd(Number(session.meta.get('timerEnd') || 0))
      setBookingId(String(session.meta.get('bookingId') || ''))
      setRevision((value) => value + 1)
    }
    sync()
    session.pages.observe(sync)
    session.pageNames.observe(sync)
    session.meta.observe(sync)
    session.objects.observe(sync)
    return () => {
      session.pages.unobserve(sync)
      session.pageNames.unobserve(sync)
      session.meta.unobserve(sync)
      session.objects.unobserve(sync)
    }
  }, [session])

  useEffect(() => {
    if (engineReady && pageId) engineRef.current?.setPage(pageId)
  }, [engineReady, pageId])

  useEffect(() => {
    if (!engineReady) return
    engineRef.current?.setBackground(background)
  }, [engineReady, background])

  useEffect(() => {
    engineRef.current?.syncCursor()
  }, [tool])

  useEffect(() => {
    if (!session) return
    const sync = () => {
      const next: Record<string, string> = {}
      session.grants.forEach((value, key) => {
        next[key] = value
      })
      setGrants(next)
    }
    sync()
    session.grants.observe(sync)
    return () => session.grants.unobserve(sync)
  }, [session])

  useEffect(() => {
    if (!session) return
    const editor = Boolean(access?.key) || remoteAccess === 'editor'
    if (!editor) return
    if (!access?.key && (session.grants.get(clientId) === 'observer' || (userId && session.grants.get(userId) === 'observer'))) return
    if (session.grants.get(clientId) === 'editor' && (!userId || session.grants.get(userId) === 'editor')) return
    mutate(session, () => {
      if (session.grants.get(clientId) !== 'editor') session.grants.set(clientId, 'editor')
      if (userId && session.grants.get(userId) !== 'editor') session.grants.set(userId, 'editor')
    })
  }, [session, access, remoteAccess, userId, clientId])

  useEffect(() => {
    if (!access || access.id !== boardId || canDraw) return
    setTool('hand')
  }, [access, boardId, canDraw])

  useEffect(() => {
    if (!session) return
    session.provider.awareness.setLocalStateField('user', {
      name,
      color: userColor,
      role,
      access: canDraw ? 'editor' : 'observer',
      clientId,
      userId,
    })
  }, [session, name, userColor, role, canDraw, clientId, userId])

  useEffect(() => {
    if (!session) return
    const onPeople = () => {
      const localId = session.provider.awareness.clientID
      const list: BoardPerson[] = []
      session.provider.awareness.getStates().forEach((state, id) => {
        const presence = state as Presence
        if (!presence.user) return
        const self = id === localId
        list.push({
          id,
          name: presence.user.name,
          color: presence.user.color,
          role: presence.user.role,
          access: self ? (canDraw ? 'editor' : 'observer') : accessOf(presence.user, grants),
          clientId: presence.user.clientId || '',
          userId: presence.user.userId || '',
          self,
        })
      })
      setPeople(list)
    }
    session.provider.awareness.on('change', onPeople)
    onPeople()
    return () => {
      session.provider.awareness.off('change', onPeople)
    }
  }, [session, grants, canDraw])

  useEffect(() => {
    if (!session) return
    let timer = 0
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin) return
      setSave('saving')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void saveBoardSnapshot(boardId, session.doc).then((saved) => {
          setSave(saved || session.provider.wsconnected ? 'saved' : 'local')
        })
      }, 1200)
    }
    session.doc.on('update', onUpdate)
    return () => {
      session.doc.off('update', onUpdate)
      window.clearTimeout(timer)
      void saveBoardSnapshot(boardId, session.doc)
    }
  }, [session, boardId])

  useEffect(() => {
    if (!timerEnd) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [timerEnd])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)
      if (event.code === 'Space' && !typing) {
        event.preventDefault()
        bridge.current.space = true
      }
      if (typing) return
      const key = event.key.toLowerCase()
      const command = event.metaKey || event.ctrlKey
      if (command && key === 's') {
        event.preventDefault()
        toast('Tablica zapisuje się automatycznie.')
        return
      }
      if (command && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) engineRef.current?.redo()
        else engineRef.current?.undo()
        return
      }
      if (command && key === 'y') {
        event.preventDefault()
        engineRef.current?.redo()
        return
      }
      if (command && key === 'c') engineRef.current?.copy()
      if (command && key === 'x') engineRef.current?.cut()
      if (command && key === 'v') return
      if (command && key === 'd') {
        event.preventDefault()
        engineRef.current?.duplicateSelection()
      }
      if (command && key === 'a') {
        event.preventDefault()
        engineRef.current?.selectAll()
      }
      if (command && key === 'g') {
        event.preventDefault()
        if (event.shiftKey) engineRef.current?.ungroupSelection()
        else engineRef.current?.groupSelection()
      }
      if (command && (event.key === '0' || event.code === 'Digit0')) {
        event.preventDefault()
        engineRef.current?.resetZoom()
      }
      if (command && (event.key === '1' || event.code === 'Digit1')) {
        event.preventDefault()
        engineRef.current?.fit()
      }
      if (command && (event.key === '=' || event.key === '+')) {
        event.preventDefault()
        engineRef.current?.zoomBy(1.1)
      }
      if (command && event.key === '-') {
        event.preventDefault()
        engineRef.current?.zoomBy(0.9)
      }
      if (!command && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        engineRef.current?.deleteSelection()
      }
      if (!command && event.key === '[') setSize((value) => Math.max(1, value - 1))
      if (!command && event.key === ']') setSize((value) => Math.min(48, value + 1))
      if (!command && event.key === '?') setShortcutsOpen(true)
      if (command && event.shiftKey && key === 'f') {
        event.preventDefault()
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen()
      }
      if (!command && toolKeys[key]) chooseTool(toolKeys[key])
      if (!command && event.key.startsWith('Arrow')) {
        event.preventDefault()
        const step = event.shiftKey ? 10 : 2
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        engineRef.current?.nudge(dx, dy)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') bridge.current.space = false
    }
    const onPaste = (event: ClipboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)
      if (typing) return
      const files = filesFromClipboard(event.clipboardData)
      if (files.length) {
        event.preventDefault()
        void addFiles(files)
        return
      }
      engineRef.current?.paste()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('paste', onPaste)
    }
  })

  const chooseTool = (next: Tool) => {
    const viewing = next === 'hand' || next === 'laser' || next === 'select'
    if (!viewing && !bridge.current.canDraw) {
      toast('Obserwujesz tablicę. Edycję może nadać edytujący.')
      return
    }
    setTool(next)
    if (next !== 'select' && next !== 'lasso' && next !== 'image') engineRef.current?.clearSelection()
    if (next === 'highlighter') {
      if (!highlighterColors.includes(color)) setColor(highlighterColors[0] || '#ffe36b')
      setSize((value) => (value < 12 ? 22 : value))
      return
    }
    if (highlighterColors.includes(color)) setColor(penColors[0] || '#1c1917')
    if (next === 'pen') setSize((value) => (value > 16 ? 4 : value))
  }

  const commitTitle = (value: string) => {
    if (!canDraw) return
    setTitle(value)
    const next = value.trim()
    if (!session || !next || session.meta.get('title') === next) return
    mutate(session, () => session.meta.set('title', next))
    void renameRemoteBoard(boardId, next)
  }

  const blurTitle = (value: string) => {
    titleEditing.current = false
    const next = value.trim()
    if (!next) {
      setTitle(String(session?.meta.get('title') || 'Lekcja'))
      return
    }
    commitTitle(next)
  }

  const revoke = (person: BoardPerson) => {
    if (!session || !owner || person.self || person.role === 'teacher' || person.access !== 'editor') return
    setConfirm({
      title: 'Odebrać edycję?',
      body: `${person.name} będzie mógł tylko oglądać tę tablicę.`,
      confirm: 'Odbierz',
      run: () => {
        mutate(session, () => {
          if (person.clientId) session.grants.set(person.clientId, 'observer')
          if (person.userId) session.grants.set(person.userId, 'observer')
        })
        if (person.userId) void setMemberAccess(boardId, person.userId, 'observer')
        toast(`${person.name} znowu tylko obserwuje.`)
      },
    })
  }

  const grant = (person: BoardPerson) => {
    if (!session || !canDraw || person.self || person.access === 'editor') return
    setConfirm({
      title: 'Nadać edycję?',
      body: `${person.name} będzie mógł zmieniać tę tablicę.`,
      confirm: 'Nadaj',
      danger: false,
      run: () => {
        mutate(session, () => {
          if (person.clientId) session.grants.set(person.clientId, 'editor')
          if (person.userId) session.grants.set(person.userId, 'editor')
        })
        if (person.userId) void setMemberAccess(boardId, person.userId, 'editor')
        toast(`${person.name} może teraz edytować.`)
      },
    })
  }

  const addFiles = async (files: File[], place: 'view' | { clientX: number; clientY: number } = 'view') => {
    if (!bridge.current.canDraw) return
    const engine = engineRef.current
    const origin = !engine ? { x: 0, y: 0 } : place === 'view' ? engine.screenCenter() : engine.clientToWorld(place.clientX, place.clientY)
    let shift = 0
    for (const file of files) {
      try {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          toast('Wczytuję PDF…')
          const result = await renderPdf(file)
          engineRef.current?.addPdfPages(result.pages, { x: origin.x + shift, y: origin.y + shift })
          shift += 28
          if (result.truncated) toast(`Dodano pierwsze 20 z ${result.total} stron.`)
          else toast('PDF jest na tablicy - możesz po nim pisać.')
        } else {
          const image = await prepareImage(file)
          engineRef.current?.addImage(image.src, image.width, image.height, image.name, { x: origin.x + shift, y: origin.y + shift })
          shift += 28
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Nie udało się dodać pliku.')
      }
    }
  }

  const patch = (next: StylePatch) => {
    if (next.color) setColor(next.color)
    if (next.size) setSize(next.size)
    if (next.opacity !== undefined) setOpacity(next.opacity)
    if (next.fill !== undefined) setFill(next.fill)
    if (next.strokeWidth) setStrokeWidth(next.strokeWidth)
    if (next.fontSize) setFontSize(next.fontSize)
    if (next.bold !== undefined) setBold(next.bold)
    if (next.italic !== undefined) setItalic(next.italic)
    if (next.underline !== undefined) setUnderline(next.underline)
    if (next.align) setAlign(next.align)
    if (next.xStep !== undefined && next.xStep > 0) setXStep(next.xStep)
    if (next.yStep !== undefined && next.yStep > 0) setYStep(next.yStep)
    if (selection.length) engineRef.current?.patchSelection(next)
  }

  const selected = session ? selection.map((id) => asObject(session.objects.get(id))).filter((object): object is BoardObject => Boolean(object)) : []
  const selectedAxes = selected.find((object) => object.type === 'shape' && object.kind === 'axes')
  const axisXStep = selectedAxes && selectedAxes.type === 'shape' ? selectedAxes.xStep ?? 1 : xStep
  const axisYStep = selectedAxes && selectedAxes.type === 'shape' ? selectedAxes.yStep ?? 1 : yStep
  const showAxisScale = tool === 'axes' || Boolean(selectedAxes)
  const editing = selected.find((object) => object.id === editingId && object.type === 'text')
  const pageCount = session ? listObjects(session).filter((object) => object.pageId === pageId).length : 0
  const boardReady = engineReady && contentReady
  const boardLink = `${location.origin}/b/${boardId}`
  const timerLabel = timerEnd ? formatTimer(timerEnd, now) : ''
  const showProperties = !presentation && (tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'text' || tool === 'rect' || tool === 'ellipse' || tool === 'triangle' || tool === 'cuboid' || tool === 'axes' || tool === 'quad' || tool === 'linear' || tool === 'sine' || tool === 'line' || tool === 'arrow' || selected.length > 0)

  return (
    <div
      className="relative h-dvh w-screen overflow-hidden text-[var(--ink)]"
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        void addFiles([...event.dataTransfer.files], { clientX: event.clientX, clientY: event.clientY })
      }}
    >
      <div ref={hostRef} className="board-host absolute inset-0" />
      {!boardReady && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-[var(--bg)]">
          <div className="text-center">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--accent)]" />
            <p className="mt-4 font-[Fraunces] text-2xl">Otwieram tablicę</p>
          </div>
        </div>
      )}
      {boardReady && pageCount === 0 && !presentation && (
        <div className="pointer-events-none absolute left-1/2 top-24 z-10 -translate-x-1/2 text-center text-[var(--muted)]">
          <p className="font-[Fraunces] text-3xl text-[var(--ink)]">{canDraw ? 'Zacznij pisać' : 'Obserwujesz tablicę'}</p>
          <p className="mt-1 text-sm">{canDraw ? 'Pióro, elementy i tekst są po lewej. Prawy przycisk albo spacja przesuwa tablicę.' : 'Edycję może nadać osoba, która utworzyła tablicę.'}</p>
        </div>
      )}
      {dragOver && <div className="pointer-events-none absolute inset-4 z-30 grid place-items-center rounded-[32px] border-2 border-dashed border-[var(--accent)] bg-[var(--accent-2)]/80 text-lg">Upuść obraz lub PDF</div>}
      {exporting && <div className="absolute inset-0 z-40 grid place-items-center bg-[var(--bg)]/80 text-lg">Eksportuję…</div>}
      <TopBar
        title={title}
        onTitle={commitTitle}
        onTitleFocus={() => { titleEditing.current = true }}
        onTitleBlur={blurTitle}
        save={save}
        cloud={Boolean(supabase)}
        people={people}
        canEdit={canDraw}
        canManage={owner}
        onGrant={grant}
        onRevoke={revoke}
        timerLabel={timerLabel}
        presentation={presentation}
        bookingId={bookingId}
        theme={theme}
        onBack={() => navigate('/')}
        onShare={() => setShareOpen(true)}
        onExportPng={() => {
          const canvas = asCanvas(engineRef.current?.capture(pageId))
          if (canvas) downloadCanvas(canvas, `${safeName(title)}.png`)
        }}
        onExportPdf={() => {
          setExporting(true)
          window.setTimeout(() => {
            const canvases = pages.map((id) => asCanvas(engineRef.current?.capture(id))).filter((canvas): canvas is HTMLCanvasElement => Boolean(canvas))
            downloadPdf(canvases, `${safeName(title)}.pdf`)
            setExporting(false)
          }, 40)
        }}
        onTimer={() => setTimerOpen(true)}
        onStopTimer={() => setConfirm({
          title: 'Usunąć minutnik?',
          body: 'Odliczanie zostanie przerwane.',
          confirm: 'Usuń',
          run: () => session && mutate(session, () => session.meta.set('timerEnd', 0)),
        })}
        onPresentation={() => session && mutate(session, () => session.meta.set('presentation', !presentation))}
        onFullscreen={() => {
          if (document.fullscreenElement) void document.exitFullscreen()
          else void document.documentElement.requestFullscreen()
        }}
        onFit={() => engineRef.current?.fit()}
        onShortcuts={() => setShortcutsOpen(true)}
        onTheme={(next) => {
          setTheme(next)
          writeTheme(next)
        }}
      />
      {!presentation && (
        <Toolbar
          tool={tool}
          setTool={chooseTool}
          open={toolbarOpen}
          setOpen={setToolbarOpen}
          canDraw={canDraw}
          onUndo={() => engineRef.current?.undo()}
          onRedo={() => engineRef.current?.redo()}
          onImage={() => fileRef.current?.click()}
          onClearPage={() => setConfirm({ title: 'Wyczyścić stronę?', body: 'Z tej strony znikną niezablokowane obiekty.', confirm: 'Wyczyść', run: () => engineRef.current?.clearPage() })}
          onClearBoard={() => setConfirm({ title: 'Wyczyścić całą tablicę?', body: 'Znikną obiekty ze wszystkich stron.', confirm: 'Wyczyść', run: () => engineRef.current?.clearBoard() })}
        />
      )}
      {showProperties && (
        <Properties
          open={propertiesOpen}
          setOpen={setPropertiesOpen}
          tool={tool}
          color={color}
          size={size}
          eraserSize={eraserSize}
          eraserMode={eraserMode}
          onEraserSize={setEraserSize}
          onEraserMode={setEraserMode}
          opacity={opacity}
          fill={fill}
          strokeWidth={strokeWidth}
          fontSize={fontSize}
          bold={bold}
          italic={italic}
          underline={underline}
          align={align}
          showAxisScale={showAxisScale}
          xStep={axisXStep}
          yStep={axisYStep}
          onPatch={patch}
          penColors={penColors}
          highlighterColors={highlighterColors}
          onPalette={(kind, colors) => {
            const next = colors.slice(0, 7)
            if (kind === 'pen') setPenColors(next)
            else setHighlighterColors(next)
            writePalette(kind, next)
          }}
        />
      )}
      {!presentation && session && (
        <PagesBar
          pages={pages}
          names={names}
          current={pageId}
          background={background}
          onSelect={setPageId}
          onAdd={() => {
            const id = uid()
            mutate(session, () => {
              session.pages.push([id])
              session.pageNames.set(id, `Strona ${session.pages.length}`)
            })
            setPageId(id)
          }}
          onRename={(id, value) => mutate(session, () => session.pageNames.set(id, value))}
          onDelete={(id) => {
            if (!session || pages.length < 2) return
            const label = names[id] || 'tę stronę'
            setConfirm({
              title: 'Usunąć stronę?',
              body: `Z tablicy zniknie „${label}” razem z tym, co na niej jest.`,
              confirm: 'Usuń',
              run: () => {
                mutate(session, () => {
                  listObjects(session).filter((object) => object.pageId === id).forEach((object) => session.objects.delete(object.id))
                  const index = session.pages.toArray().indexOf(id)
                  if (index >= 0) session.pages.delete(index, 1)
                  session.pageNames.delete(id)
                })
              },
            })
          }}
          onBackground={(kind) => {
            localStorage.setItem(paperKey(boardId), kind)
            setBackground(kind)
          }}
          canEdit={canDraw}
        />
      )}
      {editing && editing.type === 'text' && engineRef.current && (
        <TextOverlay
          engine={engineRef.current}
          object={editing}
          onChange={(text, height) => engineRef.current?.updateText(editing.id, text, height)}
          onClose={() => {
            const current = session ? asObject(session.objects.get(editing.id)) : null
            if (current?.type === 'text' && !current.text.trim()) engineRef.current?.deleteObject(current.id)
            setEditingId(null)
            engineRef.current?.setEditing(null)
          }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        multiple
        className="hidden"
        onChange={(event) => {
          void addFiles([...(event.target.files || [])])
          event.target.value = ''
        }}
      />
      <Toasts items={toasts} />
      {shareOpen && (
        <ShareDialog link={boardLink} onClose={() => setShareOpen(false)} />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {timerOpen && (
        <TimerDialog
          onClose={() => setTimerOpen(false)}
          onStart={(minutes) => {
            if (session) mutate(session, () => session.meta.set('timerEnd', Date.now() + minutes * 60_000))
            setTimerOpen(false)
          }}
        />
      )}
      {equation && (
        <EquationDialog
          initial={equation.tex}
          color={color}
          onClose={() => setEquation(null)}
          onInsert={(tex) => {
            const target = equation
            setEquation(null)
            void rasterizeEquation(tex, color, fontSize).then((image) => {
              if (!image.src) {
                toast('Nie udało się narysować wzoru.')
                return
              }
              engineRef.current?.addEquation(tex, image.src, image.width, image.height, target.x, target.y, target.id)
            })
          }}
        />
      )}
      {context && (
        <ContextMenu
          x={context.x}
          y={context.y}
          canDraw={canDraw}
          onClose={() => setContext(null)}
          onAction={(action) => {
            const engine = engineRef.current
            if (!engine) return
            if (action === 'copy') engine.copy()
            if (action === 'cut') engine.cut()
            if (action === 'paste') engine.paste()
            if (action === 'duplicate') engine.duplicateSelection()
            if (action === 'front') engine.orderSelection(true)
            if (action === 'back') engine.orderSelection(false)
            if (action === 'group') engine.groupSelection()
            if (action === 'ungroup') engine.ungroupSelection()
            if (action === 'lock') engine.lockSelection(true)
            if (action === 'unlock') engine.lockSelection(false)
            if (action === 'delete') engine.deleteSelection()
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirm={confirm.confirm}
          danger={confirm.danger}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            confirm.run()
            setConfirm(null)
          }}
        />
      )}
    </div>
  )
}

function formatStep(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '1'
  return String(Math.round(value * 1e6) / 1e6)
}

function StepField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(formatStep(value))
  useEffect(() => setDraft(formatStep(value)), [value])
  const commitText = (text: string) => {
    const normalized = text.trim().replace(',', '.')
    if (!/^\d*\.?\d+$/.test(normalized)) return false
    const next = Number(normalized)
    if (!Number.isFinite(next) || next <= 0 || next > 1_000_000) return false
    onCommit(next)
    return true
  }
  return (
    <label className="grid gap-1 text-xs text-[var(--muted)]">
      {label}
      <input
        className="w-full rounded-xl border border-[var(--line)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--ink)] outline-none"
        inputMode="decimal"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          commitText(event.target.value)
        }}
        onBlur={() => {
          if (!commitText(draft)) setDraft(formatStep(value))
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}

function AxisScale({ xStep, yStep, onPatch }: { xStep: number; yStep: number; onPatch: (patch: StylePatch) => void }) {
  return (
    <div className="mt-3 grid w-full gap-2 text-left">
      <StepField label="Podziałka Ox" value={xStep} onCommit={(value) => onPatch({ xStep: value })} />
      <StepField label="Podziałka Oy" value={yStep} onCommit={(value) => onPatch({ yStep: value })} />
    </div>
  )
}

function Properties({
  open,
  setOpen,
  tool,
  color,
  size,
  eraserSize,
  eraserMode,
  onEraserSize,
  onEraserMode,
  opacity,
  fill,
  strokeWidth,
  fontSize,
  bold,
  italic,
  underline,
  align,
  onPatch,
  showAxisScale,
  xStep,
  yStep,
  penColors,
  highlighterColors,
  onPalette,
}: {
  tool: Tool
  color: string
  size: number
  eraserSize: number
  eraserMode: EraserMode
  onEraserSize: (value: number) => void
  onEraserMode: (value: EraserMode) => void
  opacity: number
  fill: string
  strokeWidth: number
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  align: Align
  onPatch: (patch: StylePatch) => void
  showAxisScale: boolean
  xStep: number
  yStep: number
  penColors: string[]
  highlighterColors: string[]
  onPalette: (kind: 'pen' | 'highlighter', colors: string[]) => void
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const paletteKind = tool === 'highlighter' ? 'highlighter' : 'pen'
  const palette = (paletteKind === 'highlighter' ? highlighterColors : penColors).slice(0, 7)
  const pickers = useRef<Array<HTMLInputElement | null>>([])
  const replaceRef = useRef<(index: number, next: string) => void>(() => {})
  const patchRef = useRef(onPatch)
  const [draft, setDraft] = useState<string | null>(null)
  patchRef.current = onPatch
  replaceRef.current = (index, next) => {
    const colors = palette.map((entry, entryIndex) => (entryIndex === index ? next : entry))
    onPalette(paletteKind, colors)
    onPatch({ color: next })
  }
  const watchPicker = (node: HTMLInputElement | null, commit: (value: string) => void) => {
    if (!node || node.dataset.pickerBound) return
    node.dataset.pickerBound = '1'
    let hideTimer = 0
    node.addEventListener('input', () => {
      window.clearTimeout(hideTimer)
      setDraft(node.value)
    })
    node.addEventListener('change', () => {
      window.clearTimeout(hideTimer)
      commit(node.value)
      setDraft(null)
    })
    node.addEventListener('blur', () => {
      hideTimer = window.setTimeout(() => setDraft(null), 180)
    })
  }
  const shape = tool === 'rect' || tool === 'ellipse' || tool === 'triangle' || tool === 'cuboid' || tool === 'axes' || tool === 'quad' || tool === 'linear' || tool === 'sine' || tool === 'line' || tool === 'arrow'
  const eraser = tool === 'eraser'
  const swatch = 'h-6 w-6'
  return (
    <aside className="absolute right-3 top-20 z-20">
      <AnimatePresence mode="wait">
        {open ? (
          <motion.div
            key="open"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="flex max-h-[min(22rem,calc(100dvh-7.5rem))] w-[min(11rem,calc(100vw-6rem))] flex-col items-center overflow-y-auto overscroll-contain rounded-3xl border border-[var(--line)] bg-[var(--panel)] p-3 text-center shadow-[var(--shadow)] backdrop-blur-md [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden!"
          >
      {eraser && (
        <div className="w-full">
          <div className="grid w-full grid-cols-1 gap-1 rounded-2xl bg-[var(--accent-2)] p-1">
            <button type="button" onClick={() => onEraserMode('pixel')} className={`min-w-0 rounded-xl px-2 py-2 text-xs leading-tight ${eraserMode === 'pixel' ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink)]'}`}>
              Pikselowa
            </button>
            <button type="button" onClick={() => onEraserMode('object')} className={`min-w-0 rounded-xl px-2 py-2 text-xs leading-tight ${eraserMode === 'object' ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'text-[var(--ink)]'}`}>
              Obiektowa
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">{eraserMode === 'pixel' ? 'Ściera fragment kreski.' : 'Usuwa cały obiekt.'}</p>
          <label className="mt-3 block w-full text-xs text-[var(--muted)]">
            Grubość {Math.round(eraserSize)}
            <input type="range" min={8} max={120} value={eraserSize} onChange={(event) => onEraserSize(Number(event.target.value))} className="mt-1 w-full" />
          </label>
        </div>
      )}
      {!eraser && <div className="flex w-full flex-wrap justify-center gap-2 [@media(max-width:720px)]:gap-1.5">
        {palette.map((swatchColor, index) => (
          <span key={`${swatchColor}-${index}`} className="relative">
            <button type="button" aria-label={`Kolor ${swatchColor}. Drugie kliknięcie zmienia ten kolor.`} onClick={() => { if (color.toLowerCase() === swatchColor.toLowerCase()) pickers.current[index]?.click(); else onPatch({ color: swatchColor }) }} onContextMenu={(event) => { event.preventDefault(); pickers.current[index]?.click() }} className={`${swatch} rounded-full border ${color.toLowerCase() === swatchColor.toLowerCase() ? 'border-[var(--ink)]' : 'border-black/10'}`} style={{ background: swatchColor }} />
            <input key={swatchColor} ref={(node) => { pickers.current[index] = node; watchPicker(node, (value) => replaceRef.current(index, value)) }} aria-label={`Ustaw kolor ${index + 1}`} type="color" defaultValue={swatchColor} className="sr-only" tabIndex={-1} />
          </span>
        ))}
        <input key={/^#[0-9a-f]{6}$/i.test(color) ? color : '#1c1917'} ref={(node) => watchPicker(node, (value) => patchRef.current({ color: value }))} aria-label="Własny kolor" type="color" defaultValue={/^#[0-9a-f]{6}$/i.test(color) ? color : '#1c1917'} className={`${swatch} cursor-pointer rounded-md border border-black/10 bg-transparent p-0`} />
      </div>}
      {!eraser && (
        <label className="mt-3 block w-full text-xs text-[var(--muted)] [@media(max-height:760px)]:mt-2">
          Grubość {Math.round(size)}
          {tool === 'pen' && (
            <span className="mt-2 flex items-end justify-center gap-1">
              {[2, 4, 8, 12, 16].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-label={`Grubość ${preset}`}
                  onClick={() => onPatch({ size: preset })}
                  className={`grid h-10 min-w-0 flex-1 place-items-center rounded-xl [@media(max-height:760px)]:h-8 [@media(max-width:720px)]:h-8 ${size === preset ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'bg-[var(--accent-2)] text-[var(--ink)]'}`}
                >
                  <span className="rounded-full bg-current" style={{ width: Math.max(4, Math.min(preset, 14)), height: Math.max(4, Math.min(preset, 14)) }} />
                </button>
              ))}
            </span>
          )}
          <input type="range" min={1} max={48} value={size} onChange={(event) => onPatch({ size: Number(event.target.value) })} className="mt-1 w-full" />
        </label>
      )}
      {tool === 'highlighter' && (
        <label className="mt-2 block w-full text-xs text-[var(--muted)]">
          Przezroczystość {Math.round(opacity * 100)}%
          <input type="range" min={0.15} max={0.8} step={0.05} value={opacity} onChange={(event) => onPatch({ opacity: Number(event.target.value) })} className="mt-1 w-full" />
        </label>
      )}
      {shape && (
        <>
          <label className="mt-2 block w-full text-xs text-[var(--muted)]">
            Obrys {strokeWidth}
            <input type="range" min={1} max={16} value={strokeWidth} onChange={(event) => onPatch({ strokeWidth: Number(event.target.value) })} className="mt-1 w-full" />
          </label>
          <div className="mt-2 flex w-full flex-wrap justify-center gap-2 [@media(max-width:720px)]:gap-1.5">
            {['transparent', '#ffffff', '#f3ebdd', '#1f6b45', '#1c1917'].map((fillColor) => (
              <button key={fillColor} type="button" aria-label={`Wypełnienie ${fillColor}`} onClick={() => onPatch({ fill: fillColor })} className={`${swatch} rounded-full border ${fill === fillColor ? 'border-[var(--ink)]' : 'border-black/10'} ${fillColor === 'transparent' ? 'bg-[linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%)]' : ''}`} style={{ background: fillColor === 'transparent' ? undefined : fillColor }} />
            ))}
          </div>
        </>
      )}
      {showAxisScale && <AxisScale xStep={xStep} yStep={yStep} onPatch={onPatch} />}
      {tool === 'text' && (
        <div className="mt-3 flex w-full flex-wrap justify-center gap-1">
          <label className="w-full text-xs text-[var(--muted)]">
            Rozmiar {fontSize}
            <input type="range" min={14} max={96} value={fontSize} onChange={(event) => onPatch({ fontSize: Number(event.target.value) })} className="mt-1 w-full" />
          </label>
          <Toggle on={bold} label="B" onClick={() => onPatch({ bold: !bold })} />
          <Toggle on={italic} label="I" onClick={() => onPatch({ italic: !italic })} />
          <Toggle on={underline} label="U" onClick={() => onPatch({ underline: !underline })} />
          {(['left', 'center', 'right'] as const).map((value) => (
            <Toggle key={value} on={align === value} label={value === 'left' ? 'L' : value === 'center' ? 'C' : 'R'} onClick={() => onPatch({ align: value })} />
          ))}
        </div>
      )}
      <button type="button" onClick={() => setOpen(false)} className="mt-3 rounded-full px-3 py-2 text-xs text-[var(--muted)] hover:bg-[var(--accent-2)] hover:text-[var(--ink)]">
        Zwiń
      </button>
      {draft && <ColorDraft color={draft} />}
          </motion.div>
        ) : (
          <motion.button
            key="closed"
            type="button"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            aria-label="Pokaż kolory"
            onClick={() => setOpen(true)}
            className="grid h-12 w-12 place-items-center rounded-full border border-[var(--line)] bg-[var(--panel)] shadow-[var(--shadow)] backdrop-blur-md"
          >
            <span className="h-5 w-5 rounded-full border border-black/10" style={{ background: color }} />
          </motion.button>
        )}
      </AnimatePresence>
    </aside>
  )
}

function ColorDraft({ color }: { color: string }) {
  return createPortal(
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="pointer-events-none fixed left-1/2 top-1/2 z-[90] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
      <span className="h-28 w-28 rounded-full border-4 border-white shadow-[var(--shadow)]" style={{ background: color }} />
      <span className="mt-3 rounded-full bg-[var(--ink)] px-3 py-1.5 font-mono text-sm uppercase tracking-wide text-[var(--bg)]">{color}</span>
    </motion.div>,
    document.body,
  )
}

function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`grid h-9 w-9 place-items-center rounded-xl text-sm ${on ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'bg-[var(--accent-2)]'}`}>
      {label}
    </button>
  )
}

const paperKinds: BackgroundKind[] = ['white', 'black', 'beige', 'grid', 'dotted', 'lined', 'coord', 'custom']

function paperKey(boardId: string) {
  return `mattablica.paper.${boardId}`
}

function readPaper(boardId: string): BackgroundKind {
  const value = localStorage.getItem(paperKey(boardId))
  if (value && paperKinds.includes(value as BackgroundKind)) return value as BackgroundKind
  return 'grid'
}

function formatTimer(end: number, now: number) {
  const total = Math.max(0, Math.ceil((end - now) / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function safeName(value: string) {
  return value.replace(/[^\w\d\- ]+/g, '').trim() || 'tablica'
}

function accessOf(user: PresenceUser, grants: Record<string, string>): BoardAccess {
  if (user.role === 'teacher') return 'editor'
  if (user.userId && grants[user.userId] === 'editor') return 'editor'
  if (user.clientId && grants[user.clientId] === 'editor') return 'editor'
  return 'observer'
}

function asCanvas(value: unknown) {
  if (value && typeof value === 'object' && 'toDataURL' in value) return value as HTMLCanvasElement
  return null
}
