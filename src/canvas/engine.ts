import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js'
import type { BoardSession } from '../collab/session'
import { listObjects, mutate } from '../collab/session'
import type { Align, BackgroundKind, BoardObject, DraftStroke, EraserMode, ImageObject, Presence, Role, ShapeKind, StylePatch, Tool } from '../types'
import {
  boundsOf,
  centerOf,
  clamp,
  constrainShape,
  expandRect,
  hexToNumber,
  intersects,
  objectTouchesCircle,
  pointInPolygon,
  pointInRect,
  resizeBounds,
  rotatePoint,
  scaleObjectTo,
  splitStroke,
  topObjectAt,
  translateObject,
  unionRects,
  type Rect,
} from '../lib/geometry'
import { asObject, clone, uid } from '../lib/utils'
import { dropStrokeTexture, layoutSprite, paintShape, paintStamp, paintStroke, paintText } from './paint'

export type EngineBridge = {
  tool: Tool
  color: string
  size: number
  opacity: number
  fill: string
  strokeWidth: number
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  align: Align
  canDraw: boolean
  pageId: string
  role: Role
  userName: string
  userColor: string
  follow: boolean
  space: boolean
  eraserSize: number
  eraserMode: EraserMode
  xStep: number
  yStep: number
}

export type EngineHandlers = {
  onSelection: (ids: string[]) => void
  onEditText: (id: string | null) => void
  onEditEquation: (id: string | null) => void
  onEquationAt: (x: number, y: number) => void
  onImageRequest: () => void
  onToast: (message: string) => void
  onFollowPage: (pageId: string) => void
  onFollowStop: () => void
  onContext: (x: number, y: number) => void
}

type SceneNode = {
  id: string
  root: Container
  gfx: Graphics | null
  text: Text | null
  line: Graphics | null
  sprite: Sprite | null
  src: string
}

type InkTool = 'pen' | 'ballpoint' | 'highlighter'
type DrawDrag = { kind: 'draw'; id: string; tool: InkTool; points: number[]; realPressure: boolean; stillSince: number; hold: { x: number; y: number }; snapped: boolean }
type EraseDrag = {
  kind: 'erase'
  circles: Array<{ x: number; y: number; r: number }>
  snapshots: BoardObject[]
  working: BoardObject[]
  applied: number
  temps: string[]
}
type ShapeDrag = { kind: 'shape'; shape: ShapeKind; x: number; y: number }
type PanDrag = { kind: 'pan'; sx: number; sy: number; cx: number; cy: number }
type MoveDrag = { kind: 'move'; x: number; y: number; dx: number; dy: number; snapshots: BoardObject[] }
type ResizeDrag = { kind: 'resize'; handle: string; x: number; y: number; snapshots: BoardObject[]; bounds: Rect; rotation: number; center: { x: number; y: number } }
type RotateDrag = { kind: 'rotate'; snapshots: BoardObject[]; angle: number; rotation: number; cx: number; cy: number }
type MarqueeDrag = { kind: 'marquee'; x: number; y: number; additive: boolean }
type LassoDrag = { kind: 'lasso'; points: number[] }
type PinchDrag = { kind: 'pinch'; dist: number; zoom: number; cx: number; cy: number; camX: number; camY: number }
type LaserDrag = { kind: 'laser' }
type Drag = DrawDrag | EraseDrag | ShapeDrag | PanDrag | MoveDrag | ResizeDrag | RotateDrag | MarqueeDrag | LassoDrag | PinchDrag | LaserDrag

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const LASER_MS = 1100
const STRAIGHTEN_MS = 1000

function isShapeTool(tool: string): tool is ShapeKind {
  return tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse' || tool === 'triangle' || tool === 'cuboid' || tool === 'axes' || tool === 'quad' || tool === 'linear' || tool === 'sine'
}

function isInk(tool: string): tool is InkTool {
  return tool === 'pen' || tool === 'ballpoint' || tool === 'highlighter'
}

export class WhiteboardEngine {
  readonly camera = { x: 72, y: 56, zoom: 1 }
  private readonly host: HTMLElement
  private readonly session: BoardSession
  private readonly bridge: { current: EngineBridge }
  private readonly handlers: { current: EngineHandlers }
  private readonly app = new Application()
  private readonly world = new Container()
  private readonly content = new Container()
  private readonly grid = new Graphics()
  private readonly live = new Graphics()
  private readonly preview = new Graphics()
  private readonly chrome = new Graphics()
  private readonly screen = new Container()
  private readonly laserLayer = new Container()
  private readonly labelLayer = new Container()
  private readonly nodes = new Map<string, SceneNode>()
  private readonly drafts = new Map<number, Graphics>()
  private readonly draftEase = new Map<number, { id: string; pageId: string; tool: DraftStroke['tool']; color: string; size: number; opacity: number; points: number[]; drawn: number; length: number; idle: boolean; ending: boolean }>()
  private readonly remoteLive = new Graphics()
  private readonly remoteRing = new Graphics()
  private readonly cursors = new Map<number, Container>()
  private readonly cursorMotion = new Map<number, { x: number; y: number; tx: number; ty: number; pageId: string }>()
  private readonly cursorLook = new Map<number, string>()
  private readonly cursorPlate = new Map<number, number>()
  private readonly cursorGone = new Map<number, number>()
  private readonly lasers = new Map<number, Graphics>()
  private readonly labels: Text[] = []
  private readonly clipboard: BoardObject[] = []
  private readonly abort = new AbortController()
  private readonly pointers = new Map<number, { x: number; y: number }>()
  private selection: string[] = []
  private handles: Array<{ id: string; x: number; y: number }> = []
  private drag: Drag | null = null
  private disposed = false
  private started = false
  private penDown = false
  private pointerWorld: { x: number; y: number } | null = null
  private pageId = ''
  private editingId: string | null = null
  private background: BackgroundKind = 'grid'
  private bgColor = '#fbf9f4'
  private teacherCam: { x: number; y: number; zoom: number; pageId: string } | null = null
  private lastCursorSent = 0
  private lastCursorFrame = 0
  private lastLaserSent = 0
  private laserLive = false
  private laserPoints: Array<{ x: number; y: number; at: number }> = []
  private lastDraftSent = 0
  private lastDraftFrame = 0
  private lastEraseSent = 0
  private lastEraseFrame = 0
  private eraseShared = false
  private remoteErase: {
    x: number
    y: number
    tx: number
    ty: number
    r: number
    pageId: string
    mode: EraserMode
    active: boolean
    working: BoardObject[]
    stamped: { x: number; y: number } | null
    temps: string[]
    touched: Set<string>
  } | null = null
  private lastCamSent = 0
  private camTimer = 0
  private zoomTimer = 0
  private rightClick: { x: number; y: number; moved: boolean } | null = null

  constructor(
    host: HTMLElement,
    session: BoardSession,
    bridge: { current: EngineBridge },
    handlers: { current: EngineHandlers },
  ) {
    this.host = host
    this.session = session
    this.bridge = bridge
    this.handlers = handlers
  }

  async init() {
    await this.app.init({
      background: this.backgroundCss(),
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
      resizeTo: this.host,
    })
    if (this.disposed) {
      this.app.destroy()
      return
    }
    this.started = true
    this.host.appendChild(this.app.canvas)
    this.app.stage.addChild(this.world)
    this.world.addChild(this.content)
    this.content.addChild(this.grid)
    this.content.addChild(this.labelLayer)
    this.content.addChild(this.live)
    this.content.addChild(this.remoteLive)
    this.content.addChild(this.remoteRing)
    this.content.addChild(this.preview)
    this.content.addChild(this.chrome)
    this.content.addChild(this.laserLayer)
    this.app.stage.addChild(this.screen)
    this.app.stage.eventMode = 'none'
    this.app.ticker.add(this.onTick)
    this.bindInput()
    this.session.objects.observe(this.onObjects)
    this.session.provider.awareness.on('change', this.onAwareness)
    for (const object of listObjects(this.session)) this.upsert(object)
    this.applyCamera(false)
    this.syncCursor()
  }

  destroy() {
    this.disposed = true
    this.abort.abort()
    window.clearTimeout(this.camTimer)
    window.clearTimeout(this.zoomTimer)
    if (!this.started) return
    this.session.objects.unobserve(this.onObjects)
    this.session.provider.awareness.off('change', this.onAwareness)
    this.app.ticker.remove(this.onTick)
    this.app.destroy(true, { children: true })
  }

  setBackground(kind: BackgroundKind) {
    this.background = kind
    if (!this.started) return
    this.applyBackground()
    this.drawGrid()
  }

  setPage(pageId: string) {
    this.pageId = pageId
    this.nodes.forEach((node, id) => {
      const object = this.object(id)
      node.root.visible = Boolean(object && object.pageId === pageId)
    })
    this.drawGrid()
    this.cull()
    const next = this.selection.filter((id) => this.object(id)?.pageId === pageId)
    if (next.length !== this.selection.length) this.setSelection(next)
    else this.drawChrome()
    this.laserPoints = []
    this.laserLive = false
    this.publishLaser()
    this.publishCamera()
  }

  syncCursor() {
    const tool = this.bridge.current.tool
    const dragging = this.drag?.kind === 'pan' || this.drag?.kind === 'pinch'
    const cursors: Partial<Record<Tool, string>> = {
      select: 'default',
      hand: 'grab',
      text: 'text',
      laser: 'crosshair',
      eraser: 'none',
    }
    this.host.style.cursor = dragging ? 'grabbing' : cursors[tool] || 'crosshair'
  }

  undo() {
    this.session.undo.undo()
  }

  redo() {
    this.session.undo.redo()
  }

  zoomBy(factor: number) {
    const size = this.viewSize()
    this.zoomAt(size.w / 2, size.h / 2, factor)
  }

  resetZoom() {
    const size = this.viewSize()
    this.camera.zoom = 1
    this.camera.x = size.w * 0.12
    this.camera.y = size.h * 0.1
    this.applyCamera()
  }

  fit() {
    const bounds = this.contentBounds(this.pageId)
    const size = this.viewSize()
    if (!bounds) {
      this.resetZoom()
      return
    }
    const pad = 96
    const zoom = clamp(Math.min((size.w - pad) / bounds.w, (size.h - pad) / bounds.h), 0.2, 2.4)
    this.camera.zoom = zoom
    this.camera.x = size.w / 2 - (bounds.x + bounds.w / 2) * zoom
    this.camera.y = size.h / 2 - (bounds.y + bounds.h / 2) * zoom
    this.applyCamera()
  }

  selectAll() {
    this.setSelection(this.pageObjects().map((object) => object.id))
  }

  deleteSelection() {
    if (!this.bridge.current.canDraw) return
    const ids = this.selectedObjects().filter((object) => !object.locked).map((object) => object.id)
    if (!ids.length) return
    const drop = new Set(ids)
    this.commit(() => ids.forEach((id) => this.session.objects.delete(id)))
    this.setSelection(this.selection.filter((id) => !drop.has(id)))
  }

  copy() {
    this.clipboard.splice(0, this.clipboard.length, ...this.selectedObjects().map((object) => clone(object)))
  }

  cut() {
    if (!this.bridge.current.canDraw) return
    this.copy()
    this.deleteSelection()
  }

  paste() {
    if (!this.bridge.current.canDraw || !this.clipboard.length) return
    this.commitCopies(this.clipboard.map((object) => ({ ...clone(object), pageId: this.pageId })))
  }

  duplicateSelection() {
    if (!this.bridge.current.canDraw) return
    this.commitCopies(this.selectedObjects())
  }

  groupSelection() {
    if (!this.bridge.current.canDraw || this.selection.length < 2) return
    const groupId = uid()
    this.commit(() => {
      for (const object of this.selectedObjects()) this.session.objects.set(object.id, { ...object, groupId })
    })
  }

  ungroupSelection() {
    if (!this.bridge.current.canDraw) return
    this.commit(() => {
      for (const object of this.selectedObjects()) {
        const { groupId, ...rest } = object
        void groupId
        this.session.objects.set(object.id, rest)
      }
    })
  }

  lockSelection(locked: boolean) {
    if (!this.bridge.current.canDraw) return
    this.commit(() => {
      for (const object of this.selectedObjects()) this.session.objects.set(object.id, { ...object, locked })
    })
  }

  orderSelection(front: boolean) {
    if (!this.bridge.current.canDraw) return
    let z = front ? this.nextZ() : 0
    this.commit(() => {
      const items = this.selectedObjects()
      if (!front) {
        const min = listObjects(this.session).reduce((value, object) => Math.min(value, object.z), 0) - items.length
        z = min
      }
      for (const object of items) {
        this.session.objects.set(object.id, { ...object, z })
        z += 1
      }
    })
  }

  patchSelection(patch: StylePatch) {
    if (!this.bridge.current.canDraw) return
    this.commit(() => {
      for (const object of this.selectedObjects()) {
        if (object.locked) continue
        if (object.type === 'stroke') {
          this.session.objects.set(object.id, {
            ...object,
            color: patch.color || object.color,
            size: patch.size || object.size,
            opacity: patch.opacity ?? object.opacity,
          })
        } else if (object.type === 'shape') {
          this.session.objects.set(object.id, {
            ...object,
            stroke: patch.color || object.stroke,
            fill: patch.fill ?? object.fill,
            strokeWidth: patch.strokeWidth || object.strokeWidth,
            ...(object.kind === 'axes' && patch.xStep !== undefined && patch.xStep > 0 ? { xStep: patch.xStep } : {}),
            ...(object.kind === 'axes' && patch.yStep !== undefined && patch.yStep > 0 ? { yStep: patch.yStep } : {}),
          })
        } else if (object.type === 'text') {
          this.session.objects.set(object.id, {
            ...object,
            color: patch.color || object.color,
            fontSize: patch.fontSize || object.fontSize,
            bold: patch.bold ?? object.bold,
            italic: patch.italic ?? object.italic,
            underline: patch.underline ?? object.underline,
            align: patch.align || object.align,
          })
        } else if (object.type === 'equation') {
          this.session.objects.set(object.id, { ...object, color: patch.color || object.color, fontSize: patch.fontSize || object.fontSize })
        } else if (object.type === 'stamp') {
          this.session.objects.set(object.id, { ...object, color: patch.color || object.color, size: patch.size || object.size })
        }
      }
    })
  }

  nudge(dx: number, dy: number) {
    if (!this.bridge.current.canDraw) return
    this.commit(() => {
      for (const object of this.selectedObjects()) {
        if (!object.locked) this.session.objects.set(object.id, translateObject(object, dx, dy))
      }
    })
  }

  setEditing(id: string | null) {
    const previous = this.editingId
    this.editingId = id
    const paint = (target: string | null) => {
      if (!target) return
      const object = this.object(target)
      const node = this.nodes.get(target)
      if (object && node) this.paintNode(node, object)
    }
    if (previous !== id) paint(previous)
    paint(id)
  }

  clearSelection() {
    if (this.selection.length) this.setSelection([])
  }

  updateText(id: string, text: string, height: number) {
    const object = this.object(id)
    if (!object || object.type !== 'text') return
    this.commit(() => {
      this.session.objects.set(id, { ...object, text, h: Math.max(36, height) })
    })
  }

  deleteObject(id: string) {
    this.commit(() => this.session.objects.delete(id))
    if (this.selection.includes(id)) this.setSelection(this.selection.filter((item) => item !== id))
  }

  screenCenter() {
    const host = this.host.getBoundingClientRect()
    const width = host.width || this.viewSize().w
    const height = host.height || this.viewSize().h
    let left = 20
    let right = width - 20
    let top = 84
    let bottom = height - 96
    const root = this.host.parentElement
    const dock = root?.querySelector('.dock')
    if (dock instanceof HTMLElement) {
      const rect = dock.getBoundingClientRect()
      if (rect.width > 0 && rect.height > rect.width) left = Math.max(left, rect.right - host.left + 16)
      if (rect.width > rect.height && rect.top > host.top) bottom = Math.min(bottom, rect.top - host.top - 16)
    } else if (width > 720) left = Math.max(left, 76)
    const aside = root?.querySelector('aside')
    const presentation = this.session.meta.get('presentation') === true
    if (aside instanceof HTMLElement && aside.getBoundingClientRect().width > 40) {
      const rect = aside.getBoundingClientRect()
      right = Math.min(right, rect.left - host.left - 16)
    } else if (!presentation && width > 720) right -= 268
    if (right - left < 120) {
      left = 20
      right = width - 20
    }
    if (bottom - top < 120) {
      top = 20
      bottom = height - 20
    }
    return this.screenToWorld((left + right) / 2, (top + bottom) / 2)
  }

  clientToWorld(clientX: number, clientY: number) {
    const point = this.localPoint({ clientX, clientY })
    return this.screenToWorld(point.x, point.y)
  }

  addImage(src: string, width: number, height: number, name?: string, center?: { x: number; y: number }) {
    if (!this.pageId || !this.bridge.current.canDraw) return
    const maxWidth = 680
    const scale = Math.min(1, maxWidth / Math.max(1, width))
    const w = width * scale
    const h = height * scale
    const at = center ?? this.screenCenter()
    const object: ImageObject = {
      id: uid(),
      type: 'image',
      pageId: this.pageId,
      x: at.x - w / 2,
      y: at.y - h / 2,
      w,
      h,
      rotation: 0,
      src,
      name,
      z: this.nextZ(),
    }
    this.commit(() => this.session.objects.set(object.id, object))
    this.setSelection([object.id])
  }

  addPdfPages(pages: Array<{ src: string; width: number; height: number }>, center?: { x: number; y: number }) {
    if (!this.pageId || !this.bridge.current.canDraw || !pages.length) return
    let z = this.nextZ()
    const created: string[] = []
    const at = center ?? this.screenCenter()
    this.commit(() => {
      pages.forEach((page, index) => {
        let pageId = this.pageId
        if (index > 0) {
          pageId = uid()
          created.push(pageId)
          this.session.pages.push([pageId])
          this.session.pageNames.set(pageId, `PDF ${index + 1}`)
        }
        const scale = Math.min(1, 860 / page.width)
        const w = page.width * scale
        const h = page.height * scale
        const object: ImageObject = {
          id: uid(),
          type: 'image',
          pageId,
          x: at.x - w / 2,
          y: at.y - h / 2,
          w,
          h,
          rotation: 0,
          src: page.src,
          name: 'pdf',
          z,
        }
        z += 1
        this.session.objects.set(object.id, object)
      })
    })
    if (created[0]) this.handlers.current.onFollowPage(this.pageId)
  }

  addEquation(tex: string, src: string, width: number, height: number, x: number, y: number, id?: string) {
    if (!this.pageId || !this.bridge.current.canDraw) return
    const existing = id ? this.object(id) : null
    const object = {
      id: existing?.id || uid(),
      type: 'equation' as const,
      pageId: existing?.pageId || this.pageId,
      x: existing && existing.type === 'equation' ? existing.x : x,
      y: existing && existing.type === 'equation' ? existing.y : y,
      w: width,
      h: height,
      tex,
      src,
      color: this.bridge.current.color,
      fontSize: this.bridge.current.fontSize,
      z: existing?.z || this.nextZ(),
      locked: existing?.locked,
      groupId: existing?.groupId,
    }
    this.commit(() => this.session.objects.set(object.id, object))
    this.setSelection([object.id])
  }

  clearPage() {
    if (!this.bridge.current.canDraw) return
    const ids = this.pageObjects().filter((object) => !object.locked).map((object) => object.id)
    this.commit(() => ids.forEach((id) => this.session.objects.delete(id)))
    this.setSelection([])
  }

  clearBoard() {
    if (!this.bridge.current.canDraw) return
    const ids: string[] = []
    this.session.objects.forEach((_, key) => ids.push(key))
    this.commit(() => ids.forEach((id) => this.session.objects.delete(id)))
    this.setSelection([])
  }

  contentBounds(pageId = this.pageId) {
    return unionRects(this.objectsOn(pageId).map((object) => boundsOf(object)))
  }

  capture(pageId = this.pageId) {
    const previous = this.pageId
    this.chrome.visible = false
    this.preview.visible = false
    this.showPage(pageId)
    const bounds = this.contentBounds(pageId) ?? { x: 0, y: 0, w: 1100, h: 1500 }
    const padded = expandRect(bounds, 56)
    padded.w = Math.max(480, padded.w)
    padded.h = Math.max(640, padded.h)
    this.drawGrid(padded)
    const canvas = this.app.renderer.extract.canvas({
      target: this.content,
      frame: new Rectangle(padded.x, padded.y, padded.w, padded.h),
      resolution: 2,
      clearColor: this.backgroundCss(),
    })
    this.showPage(previous)
    this.pageId = previous
    this.drawGrid()
    this.chrome.visible = true
    this.preview.visible = true
    return canvas
  }

  objectById(id: string) {
    return this.object(id)
  }

  worldToScreen(x: number, y: number) {
    return { x: x * this.camera.zoom + this.camera.x, y: y * this.camera.zoom + this.camera.y }
  }

  private readonly onTick = () => {
    if (this.bridge.current.follow && this.bridge.current.role === 'student' && this.teacherCam && !this.drag) {
      const target = this.teacherCam
      if (target.pageId && target.pageId !== this.pageId) this.handlers.current.onFollowPage(target.pageId)
      const dx = target.x - this.camera.x
      const dy = target.y - this.camera.y
      const dz = target.zoom - this.camera.zoom
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(dz) > 0.001) {
        this.camera.x += dx * 0.22
        this.camera.y += dy * 0.22
        this.camera.zoom += dz * 0.22
        this.applyCamera(false)
      }
    }
    this.fadeLaser()
    this.straightenBallpoint()
    this.easeCursors()
    this.easeDrafts()
    this.easeErase()
    this.drawLasers()
  }

  private readonly onObjects = (event: { keysChanged: Set<string> }) => {
    event.keysChanged.forEach((key) => {
      const object = asObject(this.session.objects.get(key))
      if (!object) this.removeNode(key)
      else this.upsert(object)
    })
    const next = this.selection.filter((id) => this.session.objects.has(id))
    if (next.length !== this.selection.length) this.setSelection(next)
    else this.drawChrome()
    this.cull()
  }

  private readonly onAwareness = () => {
    this.drawDrafts()
    this.readRemoteErase()
    this.drawCursors()
    this.readTeacher()
  }

  private bindInput() {
    const signal = this.abort.signal
    const opts = { signal, capture: true } as const
    this.host.addEventListener('pointerdown', this.onPointerDown, opts)
    this.host.addEventListener('pointermove', this.onPointerMove, opts)
    this.host.addEventListener('pointerup', this.onPointerUp, opts)
    this.host.addEventListener('pointercancel', this.onPointerUp, opts)
    this.host.addEventListener('pointerleave', this.onPointerLeave, opts)
    this.host.addEventListener('wheel', this.onWheel, { signal, passive: false, capture: true })
    this.host.addEventListener('contextmenu', this.onContextMenu, opts)
    window.addEventListener('keydown', this.onKeyDown, { signal })
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' && this.penDown) return
    if (event.pointerType === 'pen') this.penDown = true
    try {
      this.host.setPointerCapture(event.pointerId)
    } catch {
      /* synthetic and some stylus events cannot capture */
    }
    const point = this.localPoint(event)
    this.pointers.set(event.pointerId, point)
    if (event.button === 2) {
      this.rightClick = { x: point.x, y: point.y, moved: false }
      this.drag = { kind: 'pan', sx: point.x, sy: point.y, cx: this.camera.x, cy: this.camera.y }
      if (this.bridge.current.follow) this.handlers.current.onFollowStop()
      this.syncCursor()
      return
    }
    if (event.button !== 0 && event.button !== 1) return
    if (this.pointers.size >= 2) {
      this.beginPinch()
      return
    }
    const world = this.screenToWorld(point.x, point.y)
    const bridge = this.bridge.current
    if (event.button === 1 || bridge.space || bridge.tool === 'hand') {
      this.drag = { kind: 'pan', sx: point.x, sy: point.y, cx: this.camera.x, cy: this.camera.y }
      if (bridge.follow) this.handlers.current.onFollowStop()
      this.syncCursor()
      return
    }
    if (!bridge.canDraw && this.mutates(bridge.tool)) {
      this.handlers.current.onToast('Obserwujesz tablicę. Edycję może nadać edytujący.')
      return
    }
    const placing = isInk(bridge.tool) || isShapeTool(bridge.tool) || bridge.tool === 'eraser' || bridge.tool === 'laser' || bridge.tool === 'text' || bridge.tool === 'equation' || bridge.tool === 'check' || bridge.tool === 'cross'
    if (placing) this.clearSelection()
    if (isInk(bridge.tool)) {
      const pressure = event.pointerType === 'pen' ? event.pressure || 0.5 : 0.5
      this.drag = {
        kind: 'draw',
        id: uid(),
        tool: bridge.tool,
        points: [world.x, world.y, pressure],
        realPressure: event.pointerType === 'pen',
        stillSince: performance.now(),
        hold: { x: world.x, y: world.y },
        snapped: false,
      }
      this.paintLiveStroke()
      return
    }
    if (bridge.tool === 'eraser') {
      const snapshots = this.pageObjects().map((object) => clone(object))
      this.drag = {
        kind: 'erase',
        circles: [{ x: world.x, y: world.y, r: this.eraserRadius() }],
        snapshots,
        working: snapshots,
        applied: 0,
        temps: [],
      }
      this.applyLiveErase()
      this.publishErase(world.x, world.y)
      return
    }
    if (bridge.tool === 'laser' && event.button === 0) {
      this.drag = { kind: 'laser' }
      this.laserPoints = []
      this.laserLive = true
      this.pushLaser(world)
      return
    }
    if (isShapeTool(bridge.tool)) {
      this.drag = { kind: 'shape', shape: bridge.tool, x: world.x, y: world.y }
      return
    }
    if (bridge.tool === 'text') {
      event.preventDefault()
      this.createText(world.x, world.y)
      return
    }
    if (bridge.tool === 'equation') {
      this.handlers.current.onEquationAt(world.x, world.y)
      return
    }
    if (bridge.tool === 'check' || bridge.tool === 'cross') {
      this.createStamp(bridge.tool, world.x, world.y)
      return
    }
    const hit = topObjectAt(this.pageObjects(), world.x, world.y)
    if ((bridge.tool === 'select' || bridge.tool === 'lasso') && event.detail >= 2 && hit?.type === 'text') {
      this.setSelection([hit.id])
      this.handlers.current.onEditText(hit.id)
      return
    }
    if ((bridge.tool === 'select' || bridge.tool === 'lasso') && event.detail >= 2 && hit?.type === 'equation') {
      this.setSelection([hit.id])
      this.handlers.current.onEditEquation(hit.id)
      return
    }
    const arranging = bridge.tool === 'select' || bridge.tool === 'lasso' || bridge.tool === 'image'
    const handle = arranging ? this.hitHandle(world.x, world.y) : ''
    if (handle && bridge.canDraw) {
      const selected = this.selectedObjects().filter((object) => !object.locked)
      const bounds = unionRects(selected.map((object) => boundsOf(object)))
      if (!bounds || !selected.length) return
      if (handle === 'rot') {
        const only = selected.length === 1 ? selected[0] : null
        const center = centerOf(bounds)
        this.drag = {
          kind: 'rotate',
          snapshots: selected.map((object) => clone(object)),
          angle: Math.atan2(world.y - center.y, world.x - center.x),
          rotation: only && only.type === 'image' ? only.rotation : 0,
          cx: center.x,
          cy: center.y,
        }
        return
      }
      const only = selected.length === 1 && selected[0].type === 'image' ? selected[0] : null
      const center = centerOf(bounds)
      this.drag = {
        kind: 'resize',
        handle,
        x: world.x,
        y: world.y,
        snapshots: selected.map((object) => clone(object)),
        bounds,
        rotation: only?.rotation || 0,
        center,
      }
      return
    }
    if (bridge.tool === 'lasso') {
      if (this.pointInSelection(world.x, world.y) && this.beginMove(world)) return
      this.drag = { kind: 'lasso', points: [world.x, world.y, 0.5] }
      return
    }
    if (bridge.tool === 'image') {
      if (hit?.type === 'image') {
        if (!this.selection.includes(hit.id)) this.setSelection(this.expandGroup(hit.id))
        if (this.beginMove(world)) return
      } else if (this.pointInSelection(world.x, world.y) && this.beginMove(world)) return
      if (this.selection.length) {
        this.setSelection([])
        return
      }
      this.handlers.current.onImageRequest()
      return
    }
    if (hit) {
      const group = this.expandGroup(hit.id)
      const next = event.shiftKey
        ? Array.from(new Set([...this.selection, ...group]))
        : this.selection.length > 1 && this.selection.includes(hit.id)
          ? this.selection
          : group
      this.setSelection(next)
      this.beginMove(world)
      return
    }
    if (this.pointInSelection(world.x, world.y) && this.beginMove(world)) return
    this.drag = { kind: 'marquee', x: world.x, y: world.y, additive: event.shiftKey }
    if (!event.shiftKey) this.setSelection([])
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch' && this.penDown && !this.pointers.has(event.pointerId)) return
    const point = this.localPoint(event)
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, point)
    const world = this.screenToWorld(point.x, point.y)
    this.pointerWorld = world
    this.publishCursor(world)
    if (this.pointers.size >= 2 && this.drag?.kind === 'pinch') {
      this.updatePinch()
      return
    }
    const coalesced = event.getCoalescedEvents?.()
    const samples = coalesced && coalesced.length ? coalesced : [event]
    if (this.drag?.kind === 'draw') {
      if (this.drag.snapped) {
        const sample = samples[samples.length - 1]
        const local = this.localPoint(sample)
        const next = this.screenToWorld(local.x, local.y)
        const pts = this.drag.points
        pts[pts.length - 3] = next.x
        pts[pts.length - 2] = next.y
        this.paintLiveStroke()
        this.publishDraft()
        return
      }
      for (const sample of samples) {
        const local = this.localPoint(sample)
        const next = this.screenToWorld(local.x, local.y)
        this.pushPoint(this.drag.points, next.x, next.y, sample.pointerType === 'pen' ? sample.pressure || 0.5 : 0.5)
      }
      if (this.drag.tool === 'pen' || this.drag.tool === 'ballpoint') {
        const sample = samples[samples.length - 1]
        const local = this.localPoint(sample)
        const next = this.screenToWorld(local.x, local.y)
        const limit = 8 / Math.max(0.5, this.camera.zoom)
        if (Math.hypot(next.x - this.drag.hold.x, next.y - this.drag.hold.y) > limit) {
          this.drag.hold = next
          this.drag.stillSince = performance.now()
        }
      }
      this.paintLiveStroke()
      this.publishDraft()
      return
    }
    if (this.drag?.kind === 'erase') {
      for (const sample of samples) {
        const local = this.localPoint(sample)
        const next = this.screenToWorld(local.x, local.y)
        this.pushErase(next.x, next.y)
      }
      this.applyLiveErase()
      this.publishErase(world.x, world.y)
      return
    }
    if (this.drag?.kind === 'pan') {
      const dx = point.x - this.drag.sx
      const dy = point.y - this.drag.sy
      if (this.rightClick && Math.hypot(dx, dy) > 5) this.rightClick.moved = true
      this.camera.x = this.drag.cx + dx
      this.camera.y = this.drag.cy + dy
      this.applyCamera()
      return
    }
    if (this.drag?.kind === 'shape') {
      const { w, h } = constrainShape(this.drag.shape, world.x - this.drag.x, world.y - this.drag.y, event.shiftKey)
      this.preview.clear()
      paintShape(this.preview, {
        id: 'preview',
        type: 'shape',
        kind: this.drag.shape,
        pageId: this.pageId,
        x: this.drag.x,
        y: this.drag.y,
        w,
        h,
        stroke: this.bridge.current.color,
        fill: this.bridge.current.fill,
        strokeWidth: this.bridge.current.strokeWidth,
        ...(this.drag.shape === 'axes' ? { xStep: this.bridge.current.xStep, yStep: this.bridge.current.yStep } : {}),
        z: 0,
      })
      return
    }
    if (this.drag?.kind === 'move') {
      const dx = world.x - this.drag.x
      const dy = world.y - this.drag.y
      this.drag.dx = dx
      this.drag.dy = dy
      for (const snapshot of this.drag.snapshots) {
        const node = this.nodes.get(snapshot.id)
        if (node) node.root.position.set(dx, dy)
      }
      this.drawChrome()
      return
    }
    if (this.drag?.kind === 'resize') {
      const localNow = rotatePoint(world.x, world.y, this.drag.center.x, this.drag.center.y, -this.drag.rotation)
      const localStart = rotatePoint(this.drag.x, this.drag.y, this.drag.center.x, this.drag.center.y, -this.drag.rotation)
      const next = resizeBounds(this.drag.bounds, this.drag.handle, localNow.x - localStart.x, localNow.y - localStart.y, event.shiftKey)
      for (const snapshot of this.drag.snapshots) this.paintTemporary(scaleObjectTo(snapshot, this.drag.bounds, next))
      this.drawChrome()
      return
    }
    if (this.drag?.kind === 'rotate') {
      const angle = Math.atan2(world.y - this.drag.cy, world.x - this.drag.cx)
      const rotation = this.drag.rotation + (angle - this.drag.angle)
      for (const snapshot of this.drag.snapshots) {
        if (snapshot.type === 'image') this.paintTemporary({ ...snapshot, rotation })
      }
      this.drawChrome()
      return
    }
    if (this.drag?.kind === 'marquee') {
      this.preview.clear()
      const rect = this.normalize(this.drag.x, this.drag.y, world.x - this.drag.x, world.y - this.drag.y)
      this.preview.rect(rect.x, rect.y, rect.w, rect.h).fill({ color: 0x1f6b45, alpha: 0.08 }).stroke({ width: 1 / this.camera.zoom, color: 0x1f6b45 })
      return
    }
    if (this.drag?.kind === 'lasso') {
      this.pushPoint(this.drag.points, world.x, world.y, 0.5, false)
      this.preview.clear()
      if (this.drag.points.length >= 4) {
        const flat: number[] = []
        for (let i = 0; i < this.drag.points.length; i += 3) flat.push(this.drag.points[i], this.drag.points[i + 1])
        this.preview.poly(flat, true).stroke({ width: 1.5 / this.camera.zoom, color: 0x1f6b45 })
      }
      return
    }
    if (this.drag?.kind === 'laser') {
      const trail = samples.length ? samples : [event]
      for (const sample of trail) {
        const local = this.localPoint(sample)
        const next = this.screenToWorld(local.x, local.y)
        this.pushLaser(next)
      }
      return
    }
    if (!this.drag && this.bridge.current.tool === 'eraser') {
      this.paintEraserRing(world.x, world.y)
      this.publishErase(world.x, world.y)
    } else if (this.eraseShared && this.bridge.current.tool !== 'eraser') this.clearSharedErase()
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    const bounds = this.host.getBoundingClientRect()
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom
    if (!inside) this.laserLive = false
    const point = this.localPoint(event)
    const world = this.screenToWorld(point.x, point.y)
    this.pointers.delete(event.pointerId)
    if (this.pointers.size === 0) this.laserLive = false
    if (event.pointerType === 'pen') this.penDown = false
    if (this.pointers.size >= 2) return
    if (this.pointers.size === 1 && this.drag?.kind === 'pinch') {
      this.drag = null
      return
    }
    const drag = this.drag
    this.drag = null
    this.preview.clear()
    this.syncCursor()
    if (event.button === 2) {
      const click = this.rightClick
      this.rightClick = null
      if (click && !click.moved) {
        const hit = topObjectAt(this.pageObjects(), world.x, world.y)
        if (hit && !this.selection.includes(hit.id)) this.setSelection(this.expandGroup(hit.id))
        this.handlers.current.onContext(click.x, click.y)
      }
      return
    }
    if (!drag) return
    if (drag.kind === 'draw') {
      if (drag.snapped && (drag.tool === 'pen' || drag.tool === 'ballpoint')) {
        const pts = drag.points
        pts[pts.length - 3] = world.x
        pts[pts.length - 2] = world.y
      } else this.pushPoint(drag.points, world.x, world.y, event.pressure || 0.5)
      const bridge = this.bridge.current
      const object: BoardObject = {
        id: drag.id,
        type: 'stroke',
        tool: drag.tool,
        pageId: this.pageId,
        points: drag.points,
        color: bridge.color,
        size: drag.tool === 'highlighter' ? Math.max(bridge.size, 16) : bridge.size,
        opacity: drag.tool === 'highlighter' ? bridge.opacity : 1,
        z: this.nextZ(),
      }
      this.commit(() => this.session.objects.set(object.id, object))
      this.session.provider.awareness.setLocalStateField('draft', null)
      return
    }
    if (drag.kind === 'erase') {
      this.drag = drag
      this.pushErase(world.x, world.y)
      this.applyLiveErase()
      this.drag = null
      this.live.clear()
      this.commitErase(drag)
      this.clearSharedErase()
      return
    }
    if (drag.kind === 'shape') {
      const { w, h } = constrainShape(drag.shape, world.x - drag.x, world.y - drag.y, event.shiftKey)
      if (Math.hypot(w, h) < 3) return
      const bridge = this.bridge.current
      const object: BoardObject = {
        id: uid(),
        type: 'shape',
        kind: drag.shape,
        pageId: this.pageId,
        x: drag.x,
        y: drag.y,
        w,
        h,
        stroke: bridge.color,
        fill: bridge.fill,
        strokeWidth: bridge.strokeWidth,
        ...(drag.shape === 'axes' ? { xStep: bridge.xStep, yStep: bridge.yStep } : {}),
        z: this.nextZ(),
      }
      this.commit(() => this.session.objects.set(object.id, object))
      this.setSelection([object.id])
      return
    }
    if (drag.kind === 'move') {
      for (const snapshot of drag.snapshots) {
        const node = this.nodes.get(snapshot.id)
        if (node) node.root.position.set(0, 0)
      }
      const dx = world.x - drag.x
      const dy = world.y - drag.y
      if (Math.hypot(dx, dy) < 0.4) {
        this.drawChrome()
        return
      }
      this.commit(() => {
        for (const snapshot of drag.snapshots) this.session.objects.set(snapshot.id, translateObject(snapshot, dx, dy))
      })
      return
    }
    if (drag.kind === 'resize') {
      const localNow = rotatePoint(world.x, world.y, drag.center.x, drag.center.y, -drag.rotation)
      const localStart = rotatePoint(drag.x, drag.y, drag.center.x, drag.center.y, -drag.rotation)
      const next = resizeBounds(drag.bounds, drag.handle, localNow.x - localStart.x, localNow.y - localStart.y, event.shiftKey)
      this.commit(() => {
        for (const snapshot of drag.snapshots) this.session.objects.set(snapshot.id, scaleObjectTo(snapshot, drag.bounds, next))
      })
      return
    }
    if (drag.kind === 'rotate') {
      const angle = Math.atan2(world.y - drag.cy, world.x - drag.cx)
      const rotation = drag.rotation + (angle - drag.angle)
      this.commit(() => {
        for (const snapshot of drag.snapshots) {
          if (snapshot.type === 'image') this.session.objects.set(snapshot.id, { ...snapshot, rotation })
        }
      })
      return
    }
    if (drag.kind === 'marquee') {
      const rect = this.normalize(drag.x, drag.y, world.x - drag.x, world.y - drag.y)
      const hits = this.pageObjects().filter((object) => intersects(boundsOf(object), rect)).map((object) => object.id)
      const groups = Array.from(new Set(hits.flatMap((id) => this.expandGroup(id))))
      this.setSelection(drag.additive ? Array.from(new Set([...this.selection, ...groups])) : groups)
      return
    }
    if (drag.kind === 'lasso') {
      const poly: Array<[number, number]> = []
      for (let i = 0; i < drag.points.length; i += 3) poly.push([drag.points[i], drag.points[i + 1]])
      const hits = this.pageObjects().filter((object) => {
        const center = centerOf(boundsOf(object))
        return pointInPolygon(center.x, center.y, poly)
      })
      this.setSelection(hits.flatMap((object) => this.expandGroup(object.id)))
    }
  }

  private readonly onPointerLeave = () => {
    this.pointerWorld = null
    if (this.drag?.kind !== 'laser') this.laserLive = false
    if (this.drag) return
    this.preview.clear()
    this.session.provider.awareness.setLocalStateField('cursor', null)
  }

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const point = this.localPoint(event)
    if (this.bridge.current.follow) this.handlers.current.onFollowStop()
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 480 : 1
    const dx = event.deltaX * unit
    const dy = event.deltaY * unit
    if (event.shiftKey || (Math.abs(dx) > Math.abs(dy) * 1.25 && Math.abs(dx) > 0)) {
      this.camera.x -= dx || dy
      this.camera.y -= dx ? dy : 0
      this.applyCamera()
    } else this.zoomAt(point.x, point.y, Math.exp(-dy * 0.0015))
    window.clearTimeout(this.zoomTimer)
    this.zoomTimer = window.setTimeout(() => this.refreshCaches(), 180)
  }

  private readonly onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !this.drag) return
    if (this.drag.kind === 'move') {
      for (const snapshot of this.drag.snapshots) {
        const node = this.nodes.get(snapshot.id)
        if (node) node.root.position.set(0, 0)
      }
    } else if (this.drag.kind === 'erase') {
      this.restoreErase(this.drag.snapshots)
    } else if ('snapshots' in this.drag) {
      for (const snapshot of this.drag.snapshots) {
        const node = this.nodes.get(snapshot.id)
        if (node) this.paintNode(node, snapshot)
      }
    }
    this.drag = null
    this.preview.clear()
    this.live.clear()
    this.drawChrome()
  }

  private beginPinch() {
    const points = [...this.pointers.values()]
    if (points.length < 2) return
    this.preview.clear()
    this.drag = {
      kind: 'pinch',
      dist: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)),
      zoom: this.camera.zoom,
      cx: (points[0].x + points[1].x) / 2,
      cy: (points[0].y + points[1].y) / 2,
      camX: this.camera.x,
      camY: this.camera.y,
    }
    if (this.bridge.current.follow) this.handlers.current.onFollowStop()
  }

  private updatePinch() {
    if (this.drag?.kind !== 'pinch') return
    const points = [...this.pointers.values()]
    if (points.length < 2) return
    const dist = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y))
    const cx = (points[0].x + points[1].x) / 2
    const cy = (points[0].y + points[1].y) / 2
    const world = {
      x: (this.drag.cx - this.drag.camX) / this.drag.zoom,
      y: (this.drag.cy - this.drag.camY) / this.drag.zoom,
    }
    this.camera.zoom = clamp(this.drag.zoom * (dist / this.drag.dist), 0.15, 6)
    this.camera.x = cx - world.x * this.camera.zoom + (cx - this.drag.cx)
    this.camera.y = cy - world.y * this.camera.zoom + (cy - this.drag.cy)
    this.applyCamera()
  }

  private createText(x: number, y: number) {
    const bridge = this.bridge.current
    const object: BoardObject = {
      id: uid(),
      type: 'text',
      pageId: this.pageId,
      x,
      y,
      w: 320,
      h: bridge.fontSize * 1.6,
      text: '',
      fontSize: bridge.fontSize,
      color: bridge.color,
      bold: bridge.bold,
      italic: bridge.italic,
      underline: bridge.underline,
      align: bridge.align,
      z: this.nextZ(),
    }
    this.commit(() => this.session.objects.set(object.id, object))
    this.setSelection([object.id])
    this.handlers.current.onEditText(object.id)
  }

  private createStamp(kind: 'check' | 'cross', x: number, y: number) {
    const size = Math.max(42, this.bridge.current.size * 8)
    const object: BoardObject = {
      id: uid(),
      type: 'stamp',
      kind,
      pageId: this.pageId,
      x: x - size / 2,
      y: y - size / 2,
      size,
      color: kind === 'check' ? '#1f6b45' : '#c4492c',
      z: this.nextZ(),
    }
    this.commit(() => this.session.objects.set(object.id, object))
    this.setSelection([object.id])
  }

  private commitCopies(objects: BoardObject[]) {
    const groups = new Map<string, string>()
    let z = this.nextZ()
    const ids: string[] = []
    this.commit(() => {
      for (const object of objects) {
        const copy = translateObject(clone(object), 28, 28)
        copy.id = uid()
        copy.pageId = this.pageId
        copy.z = z
        z += 1
        if (copy.groupId) {
          const mapped = groups.get(copy.groupId) || uid()
          groups.set(copy.groupId, mapped)
          copy.groupId = mapped
        }
        this.session.objects.set(copy.id, copy)
        ids.push(copy.id)
      }
    })
    this.setSelection(ids)
  }

  private commitErase(drag: EraseDrag) {
    const kept = new Set(drag.working.map((object) => object.id))
    const changed = drag.working.some((object) => !drag.snapshots.includes(object))
    const removed = drag.snapshots.some((object) => !kept.has(object.id))
    if (!changed && !removed) return
    this.commit(() => {
      for (const snapshot of drag.snapshots) {
        if (!kept.has(snapshot.id)) this.session.objects.delete(snapshot.id)
      }
      for (const object of drag.working) {
        if (drag.snapshots.includes(object)) continue
        this.session.objects.set(object.id, object)
      }
    })
  }

  private applyLiveErase() {
    const drag = this.drag
    if (drag?.kind !== 'erase') return
    const fresh = drag.circles.slice(drag.applied)
    drag.applied = drag.circles.length
    if (fresh.length) this.stampErase(fresh)
    const aim = this.pointerWorld
    if (aim) this.paintEraserRing(aim.x, aim.y)
  }

  private stampErase(circles: Array<{ x: number; y: number; r: number }>) {
    const drag = this.drag
    if (drag?.kind !== 'erase') return
    const next = this.eraseObjects(drag.working, circles, this.bridge.current.eraserMode)
    drag.temps = this.paintEraseStep(drag.working, next, drag.temps)
    drag.working = next
  }

  private eraseObjects(objects: BoardObject[], circles: Array<{ x: number; y: number; r: number }>, mode: EraserMode) {
    const pixel = mode === 'pixel'
    const next: BoardObject[] = []
    for (const object of objects) {
      if (object.locked || (pixel && object.type !== 'stroke')) {
        next.push(object)
        continue
      }
      const bounds = boundsOf(object)
      const pad = object.type === 'stroke' ? object.size / 2 : 0
      const near = circles.some((circle) => this.circleHitsRect(bounds, circle.x, circle.y, circle.r + pad))
      if (!near) {
        next.push(object)
        continue
      }
      if (pixel && object.type === 'stroke') {
        const pieces = splitStroke(object, circles)
        if (!pieces) {
          next.push(object)
          continue
        }
        for (const piece of pieces) next.push(piece.id === object.id ? piece : { ...piece, id: uid(), z: object.z })
        continue
      }
      if (circles.some((circle) => objectTouchesCircle(object, circle.x, circle.y, circle.r))) continue
      next.push(object)
    }
    return next
  }

  private paintEraseStep(previous: BoardObject[], next: BoardObject[], temps: string[]) {
    const nextIds = new Set(next.map((object) => object.id))
    const previousById = new Map(previous.map((object) => [object.id, object]))
    for (const object of previous) {
      const updated = next.find((item) => item.id === object.id)
      if (updated === object) continue
      if (updated) continue
      if (temps.includes(object.id)) this.removeNode(object.id)
      else {
        const node = this.nodes.get(object.id)
        if (node) node.root.visible = false
      }
    }
    const kept = temps.filter((id) => nextIds.has(id))
    for (const object of next) {
      if (previousById.get(object.id) === object) continue
      if (!this.nodes.has(object.id)) kept.push(object.id)
      this.upsert(object)
    }
    return kept
  }

  private circleHitsRect(rect: Rect, x: number, y: number, radius: number) {
    const nearestX = clamp(x, rect.x, rect.x + rect.w)
    const nearestY = clamp(y, rect.y, rect.y + rect.h)
    const dx = x - nearestX
    const dy = y - nearestY
    return dx * dx + dy * dy <= radius * radius
  }

  private restoreErase(snapshots: BoardObject[]) {
    const drag = this.drag
    if (drag?.kind === 'erase') {
      for (const id of drag.temps) this.removeNode(id)
    }
    for (const snapshot of snapshots) {
      const node = this.nodes.get(snapshot.id)
      if (!node) continue
      node.root.visible = snapshot.pageId === this.pageId
      this.paintNode(node, snapshot)
    }
    this.live.clear()
  }

  private beginMove(world: { x: number; y: number }) {
    if (!this.bridge.current.canDraw) return false
    const snapshots = this.selectedObjects().filter((object) => !object.locked).map((object) => clone(object))
    if (!snapshots.length) return false
    this.drag = { kind: 'move', x: world.x, y: world.y, dx: 0, dy: 0, snapshots }
    return true
  }

  private pointInSelection(x: number, y: number) {
    const objects = this.selectedObjects()
    if (!objects.length) return false
    const bounds = unionRects(objects.map((object) => boundsOf(object)))
    if (!bounds) return false
    return pointInRect(x, y, expandRect(bounds, 10 / this.camera.zoom))
  }

  private pushErase(x: number, y: number) {
    if (this.drag?.kind !== 'erase') return
    const radius = this.eraserRadius()
    const last = this.drag.circles[this.drag.circles.length - 1]
    if (!last) {
      this.drag.circles.push({ x, y, r: radius })
      return
    }
    const distance = Math.hypot(x - last.x, y - last.y)
    const gap = radius * 0.34
    if (distance < gap) return
    const steps = Math.min(64, Math.ceil(distance / gap))
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      this.drag.circles.push({ x: last.x + (x - last.x) * t, y: last.y + (y - last.y) * t, r: radius })
    }
  }

  private straightenBallpoint() {
    const drag = this.drag
    if (!drag || drag.kind !== 'draw' || drag.snapped || (drag.tool !== 'pen' && drag.tool !== 'ballpoint')) return
    if (performance.now() - drag.stillSince < STRAIGHTEN_MS) return
    const pts = drag.points
    if (pts.length < 6) return
    const x1 = pts[0]
    const y1 = pts[1]
    const x2 = pts[pts.length - 3]
    const y2 = pts[pts.length - 2]
    if (Math.hypot(x2 - x1, y2 - y1) < 16) return
    drag.snapped = true
    drag.points = [x1, y1, pts[2], x2, y2, pts[pts.length - 1]]
    this.paintLiveStroke()
    this.lastDraftSent = 0
    this.publishDraft()
  }

  private paintLiveStroke() {
    if (this.drag?.kind !== 'draw') return
    const bridge = this.bridge.current
    paintStroke(this.preview, {
      points: this.drag.points,
      tool: this.drag.tool,
      color: bridge.color,
      size: this.drag.tool === 'highlighter' ? Math.max(bridge.size, 16) : bridge.size,
      opacity: this.drag.tool === 'highlighter' ? bridge.opacity : 1,
    })
  }

  private paintTemporary(object: BoardObject) {
    const node = this.nodes.get(object.id)
    if (node) this.paintNode(node, object)
  }

  private upsert(object: BoardObject) {
    let node = this.nodes.get(object.id)
    if (!node) {
      node = this.createNode()
      node.id = object.id
      this.nodes.set(object.id, node)
      this.content.addChild(node.root)
      this.content.addChild(this.live)
      this.content.addChild(this.remoteLive)
      this.content.addChild(this.remoteRing)
      this.content.addChild(this.preview)
      this.content.addChild(this.chrome)
    }
    this.paintNode(node, object)
    node.root.visible = object.pageId === this.pageId
    if (object.type === 'stroke' && object.points.length > 900 && !node.root.isCachedAsTexture) {
      node.root.cacheAsTexture({ resolution: 2, antialias: true })
    }
  }

  private createNode(): SceneNode {
    const root = new Container()
    return { id: '', root, gfx: null, text: null, line: null, sprite: null, src: '' }
  }

  private paintNode(node: SceneNode, object: BoardObject) {
    if (object.type === 'stroke' || object.type === 'shape' || object.type === 'stamp') {
      if (!node.gfx) {
        node.gfx = new Graphics()
        node.root.addChild(node.gfx)
      }
      if (object.type === 'stroke') paintStroke(node.gfx, object)
      else if (object.type === 'shape') paintShape(node.gfx, object)
      else paintStamp(node.gfx, object)
      if (node.root.isCachedAsTexture) node.root.updateCacheTexture()
      return
    }
    if (object.type === 'text') {
      if (!node.text) {
        node.text = new Text({ text: '', resolution: 2, style: { fontFamily: 'Outfit, sans-serif', fontSize: 28, fill: 0x1c1917 } })
        node.line = new Graphics()
        node.root.addChild(node.text)
        node.root.addChild(node.line)
      }
      paintText(node.text, node.line || new Graphics(), object, object.id === this.editingId)
      return
    }
    if (!node.sprite) {
      node.sprite = new Sprite(Texture.EMPTY)
      node.root.addChild(node.sprite)
    }
    const rotation = object.type === 'image' ? object.rotation : 0
    layoutSprite(node.sprite, object.x, object.y, object.w, object.h, rotation)
    if (node.src !== object.src) {
      node.src = object.src
      const image = new Image()
      image.onload = () => {
        const current = this.object(node.id)
        if (this.disposed || !current || !node.sprite) return
        if (current.type !== 'image' && current.type !== 'equation') return
        if (node.src !== current.src) return
        const texture = Texture.from(image)
        if (node.sprite.texture !== Texture.EMPTY) node.sprite.texture.destroy(true)
        node.sprite.texture = texture
        layoutSprite(node.sprite, current.x, current.y, current.w, current.h, current.type === 'image' ? current.rotation : 0)
      }
      image.src = object.src
    }
  }

  private removeNode(id: string) {
    const node = this.nodes.get(id)
    if (!node) return
    if (node.gfx) dropStrokeTexture(node.gfx)
    if (node.sprite && node.sprite.texture !== Texture.EMPTY) node.sprite.texture.destroy(true)
    node.root.destroy({ children: true })
    this.nodes.delete(id)
  }

  private showPage(pageId: string) {
    this.nodes.forEach((node, id) => {
      const object = this.object(id)
      node.root.visible = Boolean(object && object.pageId === pageId)
    })
  }

  private drawGrid(area?: Rect) {
    const view = area || this.visibleRect()
    this.grid.clear()
    const kind = this.background
    if (kind !== 'grid' && kind !== 'dotted' && kind !== 'lined' && kind !== 'coord') {
      this.hideLabels()
      return
    }
    let step = kind === 'lined' ? 36 : kind === 'dotted' ? 28 : 48
    let guard = 0
    while (step * this.camera.zoom < 14 && guard < 6) {
      step *= 2
      guard += 1
    }
    while (step * this.camera.zoom > 92 && step > 12 && guard < 12) {
      step /= 2
      guard += 1
    }
    const startX = Math.floor(view.x / step) * step
    const startY = Math.floor(view.y / step) * step
    const dark = this.background === 'black'
    const color = dark ? 0xffffff : 0x1c1917
    const alpha = kind === 'coord' ? 0.1 : dark ? 0.16 : 0.12
    const width = 1 / this.camera.zoom
    if (kind === 'dotted') {
      for (let x = startX; x <= view.x + view.w; x += step) {
        for (let y = startY; y <= view.y + view.h; y += step) {
          this.grid.circle(x, y, 1.35 / this.camera.zoom).fill({ color, alpha: dark ? 0.28 : 0.28 })
        }
      }
    } else if (kind === 'lined') {
      for (let y = startY; y <= view.y + view.h; y += step) {
        this.grid.moveTo(view.x, y).lineTo(view.x + view.w, y)
      }
      this.grid.stroke({ width, color, alpha: 0.18 })
    } else {
      for (let x = startX; x <= view.x + view.w; x += step) this.grid.moveTo(x, view.y).lineTo(x, view.y + view.h)
      for (let y = startY; y <= view.y + view.h; y += step) this.grid.moveTo(view.x, y).lineTo(view.x + view.w, y)
      this.grid.stroke({ width, color, alpha })
    }
    if (kind === 'coord') {
      this.grid.moveTo(0, view.y).lineTo(0, view.y + view.h)
      this.grid.moveTo(view.x, 0).lineTo(view.x + view.w, 0)
      this.grid.stroke({ width: 1.6 / this.camera.zoom, color: dark ? 0xd8f3dc : 0x1f6b45, alpha: 0.85 })
      this.drawCoordLabels(view, step, dark)
      return
    }
    this.hideLabels()
  }

  private drawCoordLabels(view: Rect, step: number, dark: boolean) {
    let index = 0
    const major = step * 2
    const startX = Math.ceil(view.x / major) * major
    const startY = Math.ceil(view.y / major) * major
    for (let x = startX; x <= view.x + view.w; x += major) {
      if (Math.abs(x) < 0.1) continue
      const label = this.ensureLabel(index)
      index += 1
      label.visible = true
      label.text = `${Math.round(x)}`
      label.style.fill = dark ? 0xd5c7b2 : 0x6d645b
      label.scale.set(1 / this.camera.zoom)
      label.position.set(x + 4 / this.camera.zoom, 4 / this.camera.zoom)
    }
    for (let y = startY; y <= view.y + view.h; y += major) {
      if (Math.abs(y) < 0.1) continue
      const label = this.ensureLabel(index)
      index += 1
      label.visible = true
      label.text = `${Math.round(-y)}`
      label.style.fill = dark ? 0xd5c7b2 : 0x6d645b
      label.scale.set(1 / this.camera.zoom)
      label.position.set(4 / this.camera.zoom, y + 4 / this.camera.zoom)
    }
    for (let extra = index; extra < this.labels.length; extra += 1) this.labels[extra].visible = false
  }

  private ensureLabel(index: number) {
    const existing = this.labels[index]
    if (existing) return existing
    const label = new Text({
      text: '',
      resolution: 2,
      style: { fontFamily: 'Outfit, sans-serif', fontSize: 12, fill: 0x6d645b },
    })
    this.labelLayer.addChild(label)
    this.labels.push(label)
    return label
  }

  private hideLabels() {
    for (const label of this.labels) label.visible = false
  }

  private drawChrome() {
    this.chrome.clear()
    this.handles = []
    const objects = this.selectedObjects()
    if (!objects.length) return
    const bounds = unionRects(objects.map((object) => boundsOf(object)))
    if (!bounds) return
    const zoom = this.camera.zoom
    const ox = this.drag?.kind === 'move' ? this.drag.dx : 0
    const oy = this.drag?.kind === 'move' ? this.drag.dy : 0
    const only = objects.length === 1 && objects[0].type === 'image' && objects[0].rotation ? objects[0] : null
    if (only) {
      const corners = [
        [only.x, only.y],
        [only.x + only.w, only.y],
        [only.x + only.w, only.y + only.h],
        [only.x, only.y + only.h],
      ] as const
      const center = { x: only.x + only.w / 2, y: only.y + only.h / 2 }
      const rotated = corners.map(([x, y]) => {
        const point = rotatePoint(x, y, center.x, center.y, only.rotation)
        return { x: point.x + ox, y: point.y + oy }
      })
      this.chrome.poly(rotated.flatMap((point) => [point.x, point.y]), true).stroke({ width: 1.5 / zoom, color: 0x1f6b45 })
      const names = ['nw', 'ne', 'se', 'sw']
      rotated.forEach((point, index) => this.drawHandle(names[index], point.x, point.y))
      const top = rotatePoint(center.x, only.y - 28 / zoom, center.x, center.y, only.rotation)
      this.chrome.circle(top.x + ox, top.y + oy, 6 / zoom).fill({ color: 0xffffff }).stroke({ width: 1.5 / zoom, color: 0x1f6b45 })
      this.handles.push({ id: 'rot', x: top.x + ox, y: top.y + oy })
      return
    }
    const box = { x: bounds.x + ox, y: bounds.y + oy, w: bounds.w, h: bounds.h }
    this.chrome.rect(box.x, box.y, box.w, box.h).stroke({ width: 1.5 / zoom, color: 0x1f6b45 })
    const spots: Record<string, { x: number; y: number }> = {
      nw: { x: box.x, y: box.y },
      n: { x: box.x + box.w / 2, y: box.y },
      ne: { x: box.x + box.w, y: box.y },
      e: { x: box.x + box.w, y: box.y + box.h / 2 },
      se: { x: box.x + box.w, y: box.y + box.h },
      s: { x: box.x + box.w / 2, y: box.y + box.h },
      sw: { x: box.x, y: box.y + box.h },
      w: { x: box.x, y: box.y + box.h / 2 },
    }
    for (const id of HANDLES) this.drawHandle(id, spots[id].x, spots[id].y)
  }

  private drawHandle(id: string, x: number, y: number) {
    const size = 8 / this.camera.zoom
    this.chrome.rect(x - size / 2, y - size / 2, size, size).fill({ color: 0xffffff }).stroke({ width: 1.4 / this.camera.zoom, color: 0x1f6b45 })
    this.handles.push({ id, x, y })
  }

  private hitHandle(x: number, y: number) {
    const reach = 14 / this.camera.zoom
    return this.handles.find((handle) => Math.hypot(handle.x - x, handle.y - y) <= reach)?.id || ''
  }

  private drawDrafts() {
    const seen = new Set<number>()
    this.session.provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.session.doc.clientID) return
      const draft = (state as Presence).draft
      if (!draft || draft.pageId !== this.pageId || draft.points.length < 3) return
      seen.add(clientId)
      let gfx = this.drafts.get(clientId)
      if (!gfx) {
        gfx = new Graphics()
        this.drafts.set(clientId, gfx)
        this.content.addChild(gfx)
        this.content.addChild(this.remoteLive)
        this.content.addChild(this.remoteRing)
        this.content.addChild(this.preview)
        this.content.addChild(this.chrome)
      }
      const ease = this.draftEase.get(clientId)
      if (ease && ease.id === draft.id && this.sameDraft(ease.points, draft.points)) return
      const points = draft.points.slice()
      const length = this.strokeLength(points)
      const continued = ease && ease.id === draft.id && length + 8 >= ease.length
      const drawn = continued ? Math.min(ease.drawn, length) : length > 100 ? Math.max(0, length - 36) : 0
      this.draftEase.set(clientId, {
        id: draft.id,
        pageId: draft.pageId,
        tool: draft.tool,
        color: draft.color,
        size: draft.size,
        opacity: draft.opacity,
        points,
        drawn,
        length,
        idle: false,
        ending: false,
      })
    })
    for (const [clientId, gfx] of this.drafts) {
      if (seen.has(clientId)) continue
      const ease = this.draftEase.get(clientId)
      if (ease && !ease.idle) {
        ease.ending = true
        continue
      }
      gfx.destroy()
      this.drafts.delete(clientId)
      this.draftEase.delete(clientId)
    }
  }

  private easeDrafts() {
    const now = performance.now()
    const dt = Math.min(34, this.lastDraftFrame ? now - this.lastDraftFrame : 16)
    for (const [clientId, ease] of this.draftEase) {
      const gfx = this.drafts.get(clientId)
      if (!gfx) continue
      if (ease.pageId !== this.pageId) {
        gfx.visible = false
        continue
      }
      if (ease.idle) {
        if (ease.ending) this.dropDraft(clientId)
        continue
      }
      this.advanceDraft(ease, dt)
      const points = this.draftPoints(ease)
      if (points.length < 3) {
        gfx.visible = false
        if (ease.ending && ease.idle) this.dropDraft(clientId)
        continue
      }
      gfx.visible = true
      paintStroke(gfx, { points, tool: ease.tool, color: ease.color, size: ease.size, opacity: ease.opacity }, false, true)
      if (ease.ending && ease.idle) this.dropDraft(clientId)
    }
    this.lastDraftFrame = now
  }

  private dropDraft(clientId: number) {
    const gfx = this.drafts.get(clientId)
    gfx?.destroy()
    this.drafts.delete(clientId)
    this.draftEase.delete(clientId)
  }

  private advanceDraft(ease: { drawn: number; length: number; idle: boolean }, dt: number) {
    const remain = ease.length - ease.drawn
    if (remain < 0.35) {
      ease.drawn = ease.length
      ease.idle = true
      return
    }
    const tau = remain > 260 ? 20 : 48
    ease.drawn += remain * (1 - Math.exp(-dt / tau))
    if (ease.length - ease.drawn < 0.35) {
      ease.drawn = ease.length
      ease.idle = true
    }
  }

  private strokeLength(points: number[]) {
    let length = 0
    const count = Math.floor(points.length / 3)
    for (let i = 1; i < count; i += 1) {
      length += Math.hypot(points[i * 3] - points[(i - 1) * 3], points[i * 3 + 1] - points[(i - 1) * 3 + 1])
    }
    return length
  }

  private draftPoints(ease: { points: number[]; drawn: number }) {
    const pts = ease.points
    const count = Math.floor(pts.length / 3)
    if (count < 1) return []
    const out = [pts[0], pts[1], pts[2]]
    let left = ease.drawn
    for (let i = 1; i < count; i += 1) {
      const x0 = pts[(i - 1) * 3]
      const y0 = pts[(i - 1) * 3 + 1]
      const x1 = pts[i * 3]
      const y1 = pts[i * 3 + 1]
      const dist = Math.hypot(x1 - x0, y1 - y0)
      if (dist <= left + 0.01) {
        out.push(x1, y1, pts[i * 3 + 2])
        left -= dist
        continue
      }
      const t = dist < 0.001 ? 1 : left / dist
      out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, pts[(i - 1) * 3 + 2])
      break
    }
    return out
  }

  private drawCursors() {
    const seen = new Set<number>()
    this.session.provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.session.doc.clientID) return
      const presence = state as Presence
      const cursor = presence.cursor
      if (!cursor || cursor.pageId !== this.pageId) return
      seen.add(clientId)
      let view = this.cursors.get(clientId)
      if (!view) {
        view = new Container()
        const mark = new Graphics()
        mark.label = 'mark'
        const name = new Text({
          text: '',
          resolution: 2,
          style: { fontFamily: 'Outfit, sans-serif', fontSize: 13, fill: 0xffffff, fontWeight: '600' },
        })
        name.label = 'name'
        name.anchor.set(0.5, 0.5)
        view.addChild(mark)
        view.addChild(name)
        this.screen.addChild(view)
        this.cursors.set(clientId, view)
      }
      const color = presence.user?.color || '#1f6b45'
      const label = presence.user?.name || 'Gość'
      const name = view.children[1] as Text
      if (name.text !== label) name.text = label
      const height = 22
      const measured = Math.ceil(name.width)
      const cached = this.cursorPlate.get(clientId) || 0
      const plateWidth = measured > 8 && (!cached || Math.abs(measured - cached) > 2) ? measured : cached || measured
      if (plateWidth > 0) this.cursorPlate.set(clientId, plateWidth)
      const plate = Math.max(height, plateWidth + 22)
      const look = `${color}|${label}|${plate}`
      if (this.cursorLook.get(clientId) !== look) {
        this.cursorLook.set(clientId, look)
        const mark = view.children[0] as Graphics
        mark.clear()
        mark.poly([0, 0, 0, 16, 4.5, 12.5, 7, 20, 10, 18.5, 7.4, 11, 13, 11], true).fill({ color: hexToNumber(color) })
        const x = 14
        const y = 15
        mark.roundRect(x, y, plate, height, height / 2).fill({ color: hexToNumber(color) })
        name.position.set(x + plate / 2, y + height / 2)
      }
      this.cursorGone.delete(clientId)
      const motion = this.cursorMotion.get(clientId)
      const jump = !motion || motion.pageId !== cursor.pageId || Math.hypot(cursor.x - motion.tx, cursor.y - motion.ty) > 900
      if (!motion || jump) this.cursorMotion.set(clientId, { x: cursor.x, y: cursor.y, tx: cursor.x, ty: cursor.y, pageId: cursor.pageId })
      else {
        motion.tx = cursor.x
        motion.ty = cursor.y
        motion.pageId = cursor.pageId
      }
    })
    const now = performance.now()
    for (const [clientId, view] of this.cursors) {
      if (seen.has(clientId)) continue
      const since = this.cursorGone.get(clientId)
      if (!since) {
        this.cursorGone.set(clientId, now)
        continue
      }
      if (now - since < 240) continue
      view.destroy({ children: true })
      this.cursors.delete(clientId)
      this.cursorMotion.delete(clientId)
      this.cursorLook.delete(clientId)
      this.cursorPlate.delete(clientId)
      this.cursorGone.delete(clientId)
    }
    this.placeCursors()
  }

  private easeCursors() {
    const now = performance.now()
    const dt = Math.min(40, this.lastCursorFrame ? now - this.lastCursorFrame : 16)
    this.lastCursorFrame = now
    const blend = 1 - Math.exp(-dt / 36)
    for (const motion of this.cursorMotion.values()) {
      const dx = motion.tx - motion.x
      const dy = motion.ty - motion.y
      if (dx * dx + dy * dy < 0.04) {
        motion.x = motion.tx
        motion.y = motion.ty
        continue
      }
      motion.x += dx * blend
      motion.y += dy * blend
    }
    this.placeCursors()
    for (const [clientId, since] of this.cursorGone) {
      if (now - since < 240) continue
      const view = this.cursors.get(clientId)
      view?.destroy({ children: true })
      this.cursors.delete(clientId)
      this.cursorMotion.delete(clientId)
      this.cursorLook.delete(clientId)
      this.cursorPlate.delete(clientId)
      this.cursorGone.delete(clientId)
    }
  }

  private placeCursors() {
    for (const [clientId, view] of this.cursors) {
      const motion = this.cursorMotion.get(clientId)
      if (!motion || motion.pageId !== this.pageId) {
        view.visible = false
        continue
      }
      view.visible = true
      const screen = this.worldToScreen(motion.x, motion.y)
      view.position.set(screen.x, screen.y)
    }
  }

  private drawLasers() {
    const now = Date.now()
    const seen = new Set<number>()
    this.paintLaser(this.session.doc.clientID, this.pageId, this.laserPoints, seen)
    this.session.provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.session.doc.clientID) return
      const laser = (state as Presence).laser
      if (!laser?.points?.length || !laser.pageId) return
      const skew = Math.max(0, now - laser.at)
      const points: Array<{ x: number; y: number; at: number }> = []
      for (let i = 0; i + 2 < laser.points.length; i += 3) points.push({ x: laser.points[i], y: laser.points[i + 1], at: now - (laser.points[i + 2] + skew) })
      this.paintLaser(clientId, laser.pageId, points, seen)
    })
    this.content.addChild(this.laserLayer)
    for (const [clientId, gfx] of this.lasers) {
      if (seen.has(clientId)) continue
      gfx.destroy()
      this.lasers.delete(clientId)
    }
  }

  private paintLaser(clientId: number, pageId: string, points: Array<{ x: number; y: number; at: number }>, seen: Set<number>) {
    const now = Date.now()
    const fresh = points.filter((point) => now - point.at < LASER_MS)
    if (pageId !== this.pageId || !fresh.length) return
    seen.add(clientId)
    let gfx = this.lasers.get(clientId)
    if (!gfx) {
      gfx = new Graphics()
      this.lasers.set(clientId, gfx)
      this.laserLayer.addChild(gfx)
    }
    gfx.clear()
    const zoom = Math.max(0.2, this.camera.zoom)
    for (let i = 1; i < fresh.length; i += 1) {
      const from = fresh[i - 1]
      const to = fresh[i]
      const alpha = Math.max(0, 1 - (now - to.at) / LASER_MS)
      gfx.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 8 / zoom, color: 0xff2a2a, alpha: alpha * 0.28, cap: 'round' })
      gfx.moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ width: 2.2 / zoom, color: 0xfff4f2, alpha: alpha * 0.95, cap: 'round' })
    }
    const head = fresh[fresh.length - 1]
    const alpha = Math.max(0, 1 - (now - head.at) / LASER_MS)
    gfx.circle(head.x, head.y, 8 / zoom).fill({ color: 0xff2a2a, alpha: alpha * 0.3 })
    gfx.circle(head.x, head.y, 2.5 / zoom).fill({ color: 0xfff7f5, alpha })
  }

  private readTeacher() {
    let camera: WhiteboardEngine['teacherCam'] = null
    this.session.provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.session.doc.clientID) return
      const presence = state as Presence
      if (presence.user?.role === 'teacher' && presence.camera) camera = presence.camera
    })
    this.teacherCam = camera
  }

  private publishCursor(world: { x: number; y: number }) {
    const now = performance.now()
    const heavy = this.drag?.kind === 'draw' && this.drag.points.length > 600
    if (now - this.lastCursorSent < (heavy ? 48 : 16)) return
    this.lastCursorSent = now
    this.session.provider.awareness.setLocalStateField('cursor', { x: world.x, y: world.y, pageId: this.pageId })
  }

  private publishDraft() {
    if (this.drag?.kind !== 'draw') return
    const now = performance.now()
    const heavy = this.drag.points.length > 2400
    if (now - this.lastDraftSent < (heavy ? 24 : 10)) return
    this.lastDraftSent = now
    const bridge = this.bridge.current
    const points = heavy ? this.previewPoints(this.drag.points) : this.drag.points.slice()
    this.session.provider.awareness.setLocalStateField('draft', {
      id: this.drag.id,
      pageId: this.pageId,
      tool: this.drag.tool,
      color: bridge.color,
      size: this.drag.tool === 'highlighter' ? Math.max(bridge.size, 16) : bridge.size,
      opacity: this.drag.tool === 'highlighter' ? bridge.opacity : 1,
      points,
    })
  }

  private previewPoints(points: number[]) {
    const count = Math.floor(points.length / 3)
    const tail = 96
    const headLimit = 220
    if (count <= headLimit + tail) return points.slice()
    const head = count - tail
    const out: number[] = []
    const step = (head - 1) / (headLimit - 1)
    let previous = -1
    for (let i = 0; i < headLimit; i += 1) {
      const index = Math.min(head - 1, Math.round(i * step))
      if (index === previous) continue
      previous = index
      out.push(points[index * 3], points[index * 3 + 1], points[index * 3 + 2])
    }
    for (let i = head; i < count; i += 1) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2])
    return out
  }

  private sameDraft(current: number[], next: number[]) {
    if (current.length !== next.length) return false
    if (current.length < 3) return true
    const mid = Math.floor(current.length / 6) * 3
    const end = current.length - 3
    return current[0] === next[0] && current[1] === next[1] && current[mid] === next[mid] && current[end] === next[end] && current[end + 1] === next[end + 1]
  }

  private fadeLaser() {
    if (this.bridge.current.tool !== 'laser') this.laserLive = false
    const now = Date.now()
    if (this.laserLive && this.laserPoints.length) {
      this.laserPoints[this.laserPoints.length - 1].at = now
      if (performance.now() - this.lastLaserSent > 80) this.publishLaser()
    }
    const next = this.laserPoints.filter((point) => now - point.at < LASER_MS)
    const dropped = next.length !== this.laserPoints.length
    this.laserPoints = next
    if (!this.laserPoints.length && dropped) this.publishLaser()
  }

  private pushLaser(world: { x: number; y: number }) {
    const now = Date.now()
    const last = this.laserPoints[this.laserPoints.length - 1]
    const min = 1.5 / Math.max(0.35, this.camera.zoom)
    if (!last || Math.hypot(world.x - last.x, world.y - last.y) >= min) {
      this.laserPoints.push({ x: world.x, y: world.y, at: now })
      if (this.laserPoints.length > 96) this.laserPoints.shift()
    } else {
      last.x = world.x
      last.y = world.y
      last.at = now
    }
    if (performance.now() - this.lastLaserSent > 36) this.publishLaser()
  }

  private publishLaser() {
    this.lastLaserSent = performance.now()
    if (!this.laserPoints.length) {
      this.session.provider.awareness.setLocalStateField('laser', null)
      return
    }
    const now = Date.now()
    const points: number[] = []
    for (const point of this.laserPoints) points.push(point.x, point.y, now - point.at)
    this.session.provider.awareness.setLocalStateField('laser', { pageId: this.pageId, at: now, points })
  }

  private publishCamera() {
    if (this.bridge.current.role !== 'teacher') return
    const now = performance.now()
    if (now - this.lastCamSent < 90) {
      if (!this.camTimer) {
        this.camTimer = window.setTimeout(() => {
          this.camTimer = 0
          this.publishCameraNow()
        }, 90)
      }
      return
    }
    this.publishCameraNow()
  }

  private publishCameraNow() {
    this.lastCamSent = performance.now()
    this.session.provider.awareness.setLocalStateField('camera', {
      x: this.camera.x,
      y: this.camera.y,
      zoom: this.camera.zoom,
      pageId: this.pageId,
    })
  }

  private refreshCaches() {
    for (const node of this.nodes.values()) {
      if (!node.root.isCachedAsTexture) continue
      node.root.cacheAsTexture(false)
      node.root.cacheAsTexture({ resolution: clamp(this.camera.zoom * 2, 1, 3), antialias: true })
    }
  }

  private applyCamera(publish = true) {
    this.world.position.set(this.camera.x, this.camera.y)
    this.world.scale.set(this.camera.zoom)
    this.drawGrid()
    this.cull()
    this.drawChrome()
    this.placeCursors()
    if (publish) this.publishCamera()
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const next = clamp(this.camera.zoom * factor, 0.15, 6)
    const world = this.screenToWorld(sx, sy)
    this.camera.zoom = next
    this.camera.x = sx - world.x * next
    this.camera.y = sy - world.y * next
    this.applyCamera()
  }

  private cull() {
    const view = expandRect(this.visibleRect(), 80)
    this.nodes.forEach((node, id) => {
      const object = this.object(id)
      if (!object) return
      node.root.visible = object.pageId === this.pageId && intersects(boundsOf(object), view)
    })
  }

  private applyBackground() {
    const color = this.backgroundCss()
    this.app.renderer.background.color = color
    this.host.style.background = color
  }

  private backgroundCss() {
    if (this.background === 'black') return '#111111'
    if (this.background === 'beige') return '#f3ebdd'
    if (this.background === 'custom') return this.bgColor
    return '#fbf9f4'
  }

  private visibleRect(): Rect {
    const size = this.viewSize()
    const origin = this.screenToWorld(0, 0)
    const end = this.screenToWorld(size.w, size.h)
    return { x: origin.x, y: origin.y, w: end.x - origin.x, h: end.y - origin.y }
  }

  private viewSize() {
    return { w: this.host.clientWidth || 1, h: this.host.clientHeight || 1 }
  }

  private screenToWorld(x: number, y: number) {
    return { x: (x - this.camera.x) / this.camera.zoom, y: (y - this.camera.y) / this.camera.zoom }
  }

  private localPoint(event: { clientX: number; clientY: number }) {
    const rect = this.host.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private pushPoint(points: number[], x: number, y: number, pressure: number, settle = true) {
    const min = Math.max(0.25, 0.45 / this.camera.zoom)
    if (settle && points.length >= 3) {
      const lastX = points[points.length - 3]
      const lastY = points[points.length - 2]
      const lastP = points[points.length - 1] || 0.5
      const speed = Math.hypot(x - lastX, y - lastY)
      const follow = clamp(speed / (42 / Math.max(0.5, this.camera.zoom)), 0, 1)
      const gain = 0.08 + follow * 0.28
      x = lastX + (x - lastX) * gain
      y = lastY + (y - lastY) * gain
      if (points.length >= 6) {
        const px = points[points.length - 6]
        const py = points[points.length - 5]
        const glide = 0.48 * (1 - follow * 0.55)
        x = x * (1 - glide) + (lastX + (lastX - px)) * glide
        y = y * (1 - glide) + (lastY + (lastY - py)) * glide
      }
      if (points.length >= 9) {
        const ax = points[points.length - 9]
        const ay = points[points.length - 8]
        const bx = points[points.length - 6]
        const by = points[points.length - 5]
        points[points.length - 6] = ax * 0.22 + bx * 0.56 + x * 0.22
        points[points.length - 5] = ay * 0.22 + by * 0.56 + y * 0.22
      }
      pressure = lastP + ((pressure || 0.5) - lastP) * (0.08 + follow * 0.2)
      if (Math.hypot(x - lastX, y - lastY) < min) return
    }
    points.push(x, y, clamp(pressure || 0.5, 0.05, 1))
  }

  private eraserRadius() {
    return Math.max(4, this.bridge.current.eraserSize) / Math.max(0.35, this.camera.zoom)
  }

  private paintEraserRing(x: number, y: number, radius?: number) {
    this.preview.clear()
    this.preview.circle(x, y, radius ?? this.eraserRadius()).stroke({ width: 1.5 / this.camera.zoom, color: 0xc4492c, alpha: 0.9 })
  }

  syncToolPreview() {
    if (this.drag) return
    if (this.bridge.current.tool !== 'eraser' || !this.pointerWorld) {
      this.preview.clear()
      if (this.eraseShared) this.clearSharedErase()
      return
    }
    this.paintEraserRing(this.pointerWorld.x, this.pointerWorld.y)
  }

  private clearSharedErase() {
    this.eraseShared = false
    this.lastEraseSent = 0
    this.session.provider.awareness.setLocalStateField('erase', null)
  }

  private publishErase(x: number, y: number) {
    const now = performance.now()
    if (this.eraseShared && now - this.lastEraseSent < 12) return
    this.lastEraseSent = now
    this.eraseShared = true
    this.session.provider.awareness.setLocalStateField('erase', {
      pageId: this.pageId,
      x,
      y,
      r: this.eraserRadius(),
      mode: this.bridge.current.eraserMode,
      active: this.drag?.kind === 'erase',
    })
  }

  private readRemoteErase() {
    let next: NonNullable<typeof this.remoteErase> | null = null
    this.session.provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.session.doc.clientID) return
      const erase = (state as Presence).erase
      if (!erase || erase.pageId !== this.pageId) return
      const prev = this.remoteErase
      const active = erase.active ?? Boolean(erase.circles?.length)
      const jump = !prev || prev.pageId !== erase.pageId || Math.hypot(erase.x - prev.tx, erase.y - prev.ty) > 900
      const started = active && (!prev || !prev.active || jump || prev.mode !== (erase.mode === 'object' ? 'object' : 'pixel'))
      if (started && prev) this.restoreRemotePreview(prev)
      next = {
        x: jump || !prev ? erase.x : prev.x,
        y: jump || !prev ? erase.y : prev.y,
        tx: erase.x,
        ty: erase.y,
        r: erase.r,
        pageId: erase.pageId,
        mode: erase.mode === 'object' ? 'object' : 'pixel',
        active,
        working: started || !prev ? this.pageObjects().map((object) => clone(object)) : prev.working,
        stamped: started || !prev ? null : prev.stamped,
        temps: started || !prev ? [] : prev.temps,
        touched: started || !prev ? new Set<string>() : prev.touched,
      }
    })
    if (!next) {
      if (this.remoteErase) this.clearRemoteErase()
      return
    }
    this.remoteErase = next
  }

  private easeErase() {
    const erase = this.remoteErase
    if (!erase) return
    const now = performance.now()
    const dt = Math.min(34, this.lastEraseFrame ? now - this.lastEraseFrame : 16)
    this.lastEraseFrame = now
    const blend = 1 - Math.exp(-dt / 18)
    erase.x += (erase.tx - erase.x) * blend
    erase.y += (erase.ty - erase.y) * blend
    if (Math.hypot(erase.tx - erase.x, erase.ty - erase.y) < 0.15) {
      erase.x = erase.tx
      erase.y = erase.ty
    }
    if (erase.active) {
      const fresh = this.remoteEraseSteps(erase)
      if (fresh.length) {
        const next = this.eraseObjects(erase.working, fresh, erase.mode)
        const previous = new Set(erase.working)
        const produced = new Set(next)
        for (const object of erase.working) if (!produced.has(object)) erase.touched.add(object.id)
        for (const object of next) if (!previous.has(object)) erase.touched.add(object.id)
        erase.temps = this.paintEraseStep(erase.working, next, erase.temps)
        erase.working = next
      }
    }
    this.paintRemoteRing()
  }

  private remoteEraseSteps(erase: NonNullable<typeof this.remoteErase>) {
    const radius = erase.r
    const gap = Math.max(0.5, radius * 0.34)
    if (!erase.stamped) {
      erase.stamped = { x: erase.x, y: erase.y }
      return [{ x: erase.x, y: erase.y, r: radius }]
    }
    const lastX = erase.stamped.x
    const lastY = erase.stamped.y
    const distance = Math.hypot(erase.x - lastX, erase.y - lastY)
    if (distance < gap) return []
    const needed = Math.ceil(distance / gap)
    const steps = Math.min(4, needed)
    const circles: Array<{ x: number; y: number; r: number }> = []
    for (let step = 1; step <= steps; step += 1) {
      const t = step / needed
      circles.push({ x: lastX + (erase.x - lastX) * t, y: lastY + (erase.y - lastY) * t, r: radius })
    }
    erase.stamped = { x: lastX + (erase.x - lastX) * (steps / needed), y: lastY + (erase.y - lastY) * (steps / needed) }
    return circles
  }

  private paintRemoteRing() {
    const erase = this.remoteErase
    if (!erase) return
    this.remoteRing.clear()
    this.remoteRing.circle(erase.x, erase.y, erase.r).stroke({ width: 1.5 / this.camera.zoom, color: 0xc4492c, alpha: 0.9 })
  }

  private restoreRemotePreview(erase: NonNullable<typeof this.remoteErase>) {
    for (const id of erase.temps) this.removeNode(id)
    for (const id of erase.touched) {
      const object = this.object(id)
      const node = this.nodes.get(id)
      if (!object || !node) continue
      node.root.visible = object.pageId === this.pageId
      this.paintNode(node, object)
    }
  }

  private clearRemoteErase() {
    const erase = this.remoteErase
    this.remoteErase = null
    this.lastEraseFrame = 0
    this.remoteRing.clear()
    this.remoteLive.clear()
    if (erase) this.restoreRemotePreview(erase)
  }

  private mutates(tool: Tool) {
    return !['select', 'lasso', 'hand', 'laser'].includes(tool)
  }

  private normalize(x: number, y: number, w: number, h: number): Rect {
    return { x: w < 0 ? x + w : x, y: h < 0 ? y + h : y, w: Math.abs(w), h: Math.abs(h) }
  }

  private pageObjects() {
    return this.objectsOn(this.pageId)
  }

  private objectsOn(pageId: string) {
    return listObjects(this.session).filter((object) => object.pageId === pageId)
  }

  private object(id: string) {
    return asObject(this.session.objects.get(id))
  }

  private selectedObjects() {
    return this.selection.map((id) => this.object(id)).filter((object): object is BoardObject => Boolean(object && object.pageId === this.pageId))
  }

  private expandGroup(id: string) {
    const object = this.object(id)
    if (!object?.groupId) return [id]
    return this.pageObjects().filter((item) => item.groupId === object.groupId).map((item) => item.id)
  }

  private setSelection(ids: string[]) {
    const unique = Array.from(new Set(ids))
    this.selection = unique
    this.drawChrome()
    this.handlers.current.onSelection(unique)
  }

  private nextZ() {
    let z = 1
    this.session.objects.forEach((value) => {
      const object = asObject(value)
      if (object && object.z >= z) z = object.z + 1
    })
    return z
  }

  private commit(run: () => void) {
    mutate(this.session, run)
  }
}
