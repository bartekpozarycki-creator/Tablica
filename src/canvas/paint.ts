import { Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { ShapeObject, StampObject, StrokeObject, TextObject } from '../types'
import { hexToNumber, normalizeRect, type Rect } from '../lib/geometry'
import { outlineFlat, strokeOutline } from '../lib/stroke'

const highlighterTextures = new WeakMap<Graphics, Texture>()

export function dropStrokeTexture(gfx: Graphics) {
  const texture = highlighterTextures.get(gfx)
  if (!texture) return
  texture.destroy(true)
  highlighterTextures.delete(gfx)
}

function paintHighlighter(gfx: Graphics, points: number[], size: number, color: string, alpha: number) {
  dropStrokeTexture(gfx)
  const outline = strokeOutline(points, 'highlighter', Math.max(1, size))
  if (outline.length < 3) return
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of outline) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return
  const pad = 2
  const width = Math.max(1, maxX - minX + pad * 2)
  const height = Math.max(1, maxY - minY + pad * 2)
  const maxEdge = 4096
  let resolution = 2
  if (width * resolution > maxEdge || height * resolution > maxEdge) resolution = Math.max(0.25, maxEdge / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width * resolution))
  canvas.height = Math.max(1, Math.ceil(height * resolution))
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(resolution, resolution)
  context.beginPath()
  context.moveTo(outline[0][0] - minX + pad, outline[0][1] - minY + pad)
  for (let i = 1; i < outline.length; i += 1) context.lineTo(outline[i][0] - minX + pad, outline[i][1] - minY + pad)
  context.closePath()
  context.fillStyle = color
  context.fill()
  const texture = Texture.from(canvas)
  highlighterTextures.set(gfx, texture)
  gfx.rect(minX - pad, minY - pad, width, height).fill({ texture, color: 0xffffff, alpha })
}

export function paintStroke(gfx: Graphics, object: Pick<StrokeObject, 'points' | 'tool' | 'color' | 'size' | 'opacity'>, append = false, lite = false) {
  if (!append) {
    dropStrokeTexture(gfx)
    gfx.clear()
  }
  const pts = object.points
  if (pts.length < 3) return
  const color = hexToNumber(object.color)
  const alpha = object.opacity
  if (object.tool === 'highlighter') {
    if (lite || append) {
      const outline = outlineFlat(strokeOutline(pts, 'highlighter', Math.max(1, object.size)))
      if (outline.length >= 6) gfx.poly(outline, true).fill({ color, alpha })
    } else paintHighlighter(gfx, pts, object.size, object.color, alpha)
    return
  }
  paintSmooth(gfx, pts, object.size, object.tool === 'pen', color, alpha)
}

function paintSmooth(gfx: Graphics, pts: number[], size: number, fountain: boolean, color: number, alpha: number) {
  const samples = relaxStroke(strokePoints(pts, size, fountain))
  if (!samples.length) return
  if (samples.length === 1) {
    gfx.circle(samples[0].x, samples[0].y, samples[0].w / 2).fill({ color, alpha })
    return
  }
  let from = 0
  while (from < samples.length - 1) {
    const width = samples[from].w
    let to = from + 1
    while (to < samples.length - 1 && Math.abs(samples[to].w - width) <= 0.1) to += 1
    gfx.moveTo(samples[from].x, samples[from].y)
    if (to - from === 1) gfx.lineTo(samples[to].x, samples[to].y)
    else {
      for (let i = from + 1; i < to; i += 1) {
        const nx = samples[i + 1].x
        const ny = samples[i + 1].y
        gfx.quadraticCurveTo(samples[i].x, samples[i].y, (samples[i].x + nx) / 2, (samples[i].y + ny) / 2)
      }
      gfx.lineTo(samples[to].x, samples[to].y)
    }
    gfx.stroke({ width, color, alpha, cap: 'round', join: 'round' })
    from = to
  }
}

type StrokeSample = { x: number; y: number; w: number }

function strokePoints(pts: number[], size: number, fountain: boolean) {
  const samples: StrokeSample[] = []
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const w = fountain ? Math.max(0.85, size * (0.42 + (pts[i + 2] || 0.5) * 0.75)) : size
    const last = samples[samples.length - 1]
    if (last && Math.hypot(pts[i] - last.x, pts[i + 1] - last.y) < 0.12) {
      last.w = w
      continue
    }
    samples.push({ x: pts[i], y: pts[i + 1], w })
  }
  return samples
}

function relaxStroke(samples: StrokeSample[]) {
  let current = samples
  const passes = current.length > 900 ? 1 : 2
  for (let pass = 0; pass < passes; pass += 1) {
    if (current.length < 3) break
    const next: StrokeSample[] = [current[0]]
    for (let i = 0; i < current.length - 1; i += 1) {
      const a = current[i]
      const b = current[i + 1]
      next.push(mixSample(a, b, 0.25), mixSample(a, b, 0.75))
    }
    next.push(current[current.length - 1])
    current = next
  }
  return current
}

function mixSample(a: StrokeSample, b: StrokeSample, t: number): StrokeSample {
  const u = 1 - t
  return { x: a.x * u + b.x * t, y: a.y * u + b.y * t, w: a.w * u + b.w * t }
}

type AxisStroke = { width: number; color: number; cap: 'round'; join: 'round' }

const marks = new WeakMap<Graphics, Text[]>()

function clearMarks(gfx: Graphics) {
  const list = marks.get(gfx)
  if (!list) return
  for (const text of list) {
    text.removeFromParent()
    text.destroy()
  }
  marks.delete(gfx)
}

function addMark(gfx: Graphics, value: string, x: number, y: number, size: number, color: number, ax: number, ay: number) {
  const text = new Text({
    text: value,
    resolution: 2,
    style: { fontFamily: 'Outfit, sans-serif', fontSize: size, fill: color, fontWeight: '500' },
  })
  text.anchor.set(ax, ay)
  text.position.set(x, y)
  gfx.addChild(text)
  const list = marks.get(gfx) || []
  list.push(text)
  marks.set(gfx, list)
}

function axisArrow(gfx: Graphics, fromX: number, fromY: number, tipX: number, tipY: number, stroke: AxisStroke) {
  const angle = Math.atan2(tipY - fromY, tipX - fromX)
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const head = Math.min(22, Math.max(14, Math.hypot(tipX - fromX, tipY - fromY) * 0.18))
  const half = Math.max(head * 0.5, stroke.width * 1.7)
  const neck = head * 0.88
  const cover = head * 0.42
  gfx.moveTo(fromX, fromY).lineTo(tipX - ux * cover, tipY - uy * cover).stroke({ width: stroke.width, color: stroke.color, cap: 'butt', join: 'round' })
  const nx = tipX - ux * neck
  const ny = tipY - uy * neck
  const px = -uy
  const py = ux
  gfx.poly([tipX, tipY, nx + px * half, ny + py * half, nx - px * half, ny - py * half], true).fill({ color: stroke.color })
  return head
}

function dashLine(gfx: Graphics, x1: number, y1: number, x2: number, y2: number, stroke: { width: number; color: number }) {
  const length = Math.hypot(x2 - x1, y2 - y1)
  if (length < 2) return
  const dash = Math.max(6, stroke.width * 2.4)
  const gap = dash * 0.72
  const ux = (x2 - x1) / length
  const uy = (y2 - y1) / length
  let distance = 0
  while (distance < length - 0.5) {
    const end = Math.min(length, distance + dash)
    gfx.moveTo(x1 + ux * distance, y1 + uy * distance).lineTo(x1 + ux * end, y1 + uy * end)
    distance = end + gap
  }
  gfx.stroke({ width: stroke.width, color: stroke.color, cap: 'butt', join: 'round' })
}

function paintCuboid(gfx: Graphics, box: Rect, stroke: { width: number; color: number; cap: 'round'; join: 'round' }, object: ShapeObject) {
  const depth = Math.min(box.w, box.h) * 0.34
  const x = box.x
  const y = box.y + depth
  const w = Math.max(1, box.w - depth)
  const h = Math.max(1, box.h - depth)
  const frontA = [x, y]
  const frontB = [x + w, y]
  const frontC = [x + w, y + h]
  const frontD = [x, y + h]
  const backE = [x + depth, y - depth]
  const backF = [x + w + depth, y - depth]
  const backG = [x + w + depth, y + h - depth]
  const backH = [x + depth, y + h - depth]
  if (object.fill && object.fill !== 'transparent') {
    const color = hexToNumber(object.fill)
    gfx.poly([...backE, ...backF, ...backG, ...backH], true).fill({ color, alpha: 0.28 })
    gfx.poly([...frontA, ...backE, ...backF, ...frontB], true).fill({ color, alpha: 0.5 })
    gfx.poly([...frontB, ...backF, ...backG, ...frontC], true).fill({ color, alpha: 0.72 })
    gfx.poly([...frontA, ...frontB, ...frontC, ...frontD], true).fill({ color })
  }
  const visible = [
    [frontA, frontB],
    [frontB, frontC],
    [frontC, frontD],
    [frontD, frontA],
    [frontA, backE],
    [backE, backF],
    [backF, frontB],
    [backF, backG],
    [backG, frontC],
  ]
  for (const [from, to] of visible) gfx.moveTo(from[0], from[1]).lineTo(to[0], to[1])
  gfx.stroke(stroke)
  dashLine(gfx, frontD[0], frontD[1], backH[0], backH[1], stroke)
  dashLine(gfx, backH[0], backH[1], backE[0], backE[1], stroke)
  dashLine(gfx, backH[0], backH[1], backG[0], backG[1], stroke)
}

type PlotWindow = { xMin: number; xMax: number; yMin: number; yMax: number }

function positiveStep(step: number | undefined) {
  return step !== undefined && Number.isFinite(step) && step > 0 ? step : 1
}

function tickValues(min: number, max: number, step: number) {
  const safe = positiveStep(step)
  const first = Math.ceil(min / safe - 1e-8)
  const last = Math.floor(max / safe + 1e-8)
  const span = last - first + 1
  const stride = span > 48 ? Math.ceil(span / 32) : 1
  const values: number[] = []
  for (let index = first; index <= last; index += stride) {
    const value = Math.round(index * safe * 1e6) / 1e6
    if (Math.abs(value) <= safe * 1e-4) continue
    values.push(value)
  }
  return values
}

function tickText(value: number) {
  return String(Math.round(value * 1e6) / 1e6)
}

function paintGraph(gfx: Graphics, box: Rect, stroke: AxisStroke, win: PlotWindow, curve?: (x: number) => number, formula?: string, stepX = 1, stepY = 1, independent = false) {
  const area = {
    x: box.x + 28,
    y: box.y + 16,
    w: Math.max(24, box.w - 44),
    h: Math.max(24, box.h - 52),
  }
  const spanX = win.xMax - win.xMin
  const spanY = win.yMax - win.yMin
  const shared = Math.min(area.w / spanX, area.h / spanY)
  const scaleX = independent ? area.w / spanX : shared
  const scaleY = independent ? area.h / spanY : shared
  const drawnW = spanX * scaleX
  const drawnH = spanY * scaleY
  const ox = area.x + (area.w - drawnW) / 2
  const oy = area.y + (area.h - drawnH) / 2
  const toX = (x: number) => ox + (x - win.xMin) * scaleX
  const toY = (y: number) => oy + (win.yMax - y) * scaleY
  const originX = toX(0)
  const originY = toY(0)
  const tipX = toX(win.xMax)
  const tipY = toY(win.yMax)
  const tailX = toX(win.xMin)
  const tailY = toY(win.yMin)
  const xHead = axisArrow(gfx, tailX, originY, tipX, originY, stroke)
  const yHead = axisArrow(gfx, originX, tailY, originX, tipY, stroke)
  const xValues = tickValues(win.xMin, win.xMax, stepX)
  const yValues = tickValues(win.yMin, win.yMax, stepY)
  const xGap = scaleX * positiveStep(stepX)
  const yGap = scaleY * positiveStep(stepY)
  const gap = Math.max(12, Math.min(xGap, yGap))
  const tick = Math.max(4, Math.min(8, gap * 0.16))
  const font = Math.max(12, Math.min(16, gap * 0.32))
  const xLabelStride = xGap < 28 ? Math.max(1, Math.round(28 / Math.max(8, xGap))) : 1
  const yLabelStride = yGap < 22 ? Math.max(1, Math.round(22 / Math.max(8, yGap))) : 1
  xValues.forEach((value, index) => {
    const x = toX(value)
    if (x > tipX - xHead - 8 || x < tailX + 4) return
    gfx.moveTo(x, originY - tick).lineTo(x, originY + tick).stroke(stroke)
    if (index % xLabelStride === 0) addMark(gfx, tickText(value), x, originY + tick + 3, font, stroke.color, 0.5, 0)
  })
  yValues.forEach((value, index) => {
    const y = toY(value)
    if (y < tipY + yHead + 4 || y > tailY - 4) return
    gfx.moveTo(originX - tick, y).lineTo(originX + tick, y).stroke(stroke)
    if (index % yLabelStride === 0) addMark(gfx, tickText(value), originX - tick - 3, y, font, stroke.color, 1, 0.5)
  })
  addMark(gfx, 'Ox', tipX + 4, originY, font + 1, stroke.color, 0, 0.5)
  addMark(gfx, 'Oy', originX, tipY - 3, font + 1, stroke.color, 0.5, 1)
  if (curve) {
    const steps = 180
    let drawing = false
    for (let i = 0; i <= steps; i += 1) {
      const x = win.xMin + (spanX * i) / steps
      const y = curve(x)
      const inside = Number.isFinite(y) && y >= win.yMin && y <= win.yMax
      if (!inside) {
        if (drawing) gfx.stroke({ ...stroke, width: stroke.width + 1.25 })
        drawing = false
        continue
      }
      const px = toX(x)
      const py = toY(y)
      if (!drawing) gfx.moveTo(px, py)
      else gfx.lineTo(px, py)
      drawing = true
    }
    if (drawing) gfx.stroke({ ...stroke, width: stroke.width + 1.25 })
  }
  if (formula) addMark(gfx, formula, ox + drawnW / 2, oy + drawnH + 6, font, stroke.color, 0.5, 0)
}

function paintAxes(gfx: Graphics, box: Rect, stroke: AxisStroke, xStep?: number, yStep?: number) {
  const stepX = positiveStep(xStep)
  const stepY = positiveStep(yStep)
  const unit = 48
  const xSlots = Math.max(4, Math.round(Math.max(24, box.w - 44) / unit))
  const ySlots = Math.max(4, Math.round(Math.max(24, box.h - 52) / unit))
  paintGraph(
    gfx,
    box,
    stroke,
    {
      xMin: -(xSlots / 2) * stepX,
      xMax: (xSlots / 2) * stepX,
      yMin: -(ySlots / 2) * stepY,
      yMax: (ySlots / 2) * stepY,
    },
    undefined,
    undefined,
    stepX,
    stepY,
    true,
  )
}

export function paintShape(gfx: Graphics, object: ShapeObject) {
  gfx.clear()
  clearMarks(gfx)
  const stroke = {
    width: Math.max(1.25, object.strokeWidth),
    color: hexToNumber(object.stroke),
    cap: 'round' as const,
    join: 'round' as const,
  }
  if (object.kind === 'line') {
    gfx.moveTo(object.x, object.y).lineTo(object.x + object.w, object.y + object.h).stroke(stroke)
    return
  }
  if (object.kind === 'arrow') {
    const x1 = object.x
    const y1 = object.y
    const x2 = object.x + object.w
    const y2 = object.y + object.h
    const length = Math.max(1, Math.hypot(object.w, object.h))
    const angle = Math.atan2(object.h, object.w)
    const ux = Math.cos(angle)
    const uy = Math.sin(angle)
    const px = -uy
    const py = ux
    const head = Math.min(Math.max(22, object.strokeWidth * 5.5), length * 0.42)
    const half = Math.max(head * 0.46, object.strokeWidth * 1.15)
    const neck = head * 0.78
    const bx = x2 - ux * head * 0.52
    const by = y2 - uy * head * 0.52
    const nx = x2 - ux * neck
    const ny = y2 - uy * neck
    gfx.moveTo(x1, y1).lineTo(bx, by).stroke({ ...stroke, cap: 'butt' })
    gfx.poly([x2, y2, nx + px * half, ny + py * half, nx - px * half, ny - py * half], true).fill({ color: hexToNumber(object.stroke) })
    return
  }
  const box = normalizeRect(object.x, object.y, object.w, object.h)
  if (object.kind === 'cuboid') {
    paintCuboid(gfx, box, stroke, object)
    return
  }
  if (object.kind === 'axes') {
    paintAxes(gfx, box, stroke, object.xStep, object.yStep)
    return
  }
  if (object.kind === 'quad' || object.kind === 'linear' || object.kind === 'sine') {
    const plot = object.kind === 'quad'
      ? { curve: (x: number) => x * x + x - 2, win: { xMin: -3.2, xMax: 2.2, yMin: -3.6, yMax: 6.4 }, formula: 'y = x² + x − 2' }
      : object.kind === 'linear'
        ? { curve: (x: number) => x + 1, win: { xMin: -5, xMax: 5, yMin: -4, yMax: 6 }, formula: 'y = x + 1' }
        : { curve: (x: number) => Math.sin(x), win: { xMin: -6.6, xMax: 6.6, yMin: -1.8, yMax: 1.8 }, formula: 'y = sin x' }
    paintGraph(gfx, box, stroke, plot.win, plot.curve, plot.formula)
    return
  }
  if (object.kind === 'rect') gfx.roundRect(box.x, box.y, Math.max(1, box.w), Math.max(1, box.h), 3)
  else if (object.kind === 'ellipse') gfx.ellipse(box.x + box.w / 2, box.y + box.h / 2, Math.max(1, box.w / 2), Math.max(1, box.h / 2))
  else gfx.poly([box.x + box.w / 2, box.y, box.x + box.w, box.y + box.h, box.x, box.y + box.h], true)
  if (object.fill && object.fill !== 'transparent') gfx.fill({ color: hexToNumber(object.fill) })
  gfx.stroke(stroke)
}

export function paintStamp(gfx: Graphics, object: StampObject) {
  gfx.clear()
  const color = hexToNumber(object.color)
  const { x, y, size } = object
  gfx.roundRect(x, y, size, size, size * 0.22).fill({ color, alpha: 0.16 })
  gfx.roundRect(x, y, size, size, size * 0.22).stroke({ width: Math.max(2, size * 0.045), color })
  const pad = size * 0.24
  const width = Math.max(3, size * 0.09)
  if (object.kind === 'check') {
    gfx.moveTo(x + pad, y + size * 0.52)
    gfx.lineTo(x + size * 0.42, y + size - pad)
    gfx.lineTo(x + size - pad * 0.8, y + pad)
    gfx.stroke({ width, color, cap: 'round', join: 'round' })
    return
  }
  gfx.moveTo(x + pad, y + pad).lineTo(x + size - pad, y + size - pad).stroke({ width, color, cap: 'round' })
  gfx.moveTo(x + size - pad, y + pad).lineTo(x + pad, y + size - pad).stroke({ width, color, cap: 'round' })
}

export function paintText(text: Text, line: Graphics, object: TextObject, hidden: boolean) {
  text.text = object.text || ''
  text.alpha = hidden ? 0 : 1
  text.style = {
    fontFamily: 'Outfit, sans-serif',
    fontSize: object.fontSize,
    fill: hexToNumber(object.color),
    fontWeight: object.bold ? '700' : '500',
    fontStyle: object.italic ? 'italic' : 'normal',
    align: object.align,
    wordWrap: true,
    wordWrapWidth: Math.max(40, object.w),
    breakWords: true,
  }
  text.position.set(object.x, object.y)
  line.clear()
  if (!hidden && object.underline && object.text) {
    const width = Math.max(object.w, text.width)
    const y = object.y + Math.max(text.height, object.fontSize) - object.fontSize * 0.08
    line.rect(object.x, y, width, Math.max(1.5, object.fontSize * 0.06)).fill({ color: hexToNumber(object.color) })
  }
}

export function layoutSprite(sprite: Sprite, x: number, y: number, w: number, h: number, rotation: number) {
  sprite.anchor.set(0.5)
  sprite.position.set(x + w / 2, y + h / 2)
  sprite.width = Math.max(1, Math.abs(w))
  sprite.height = Math.max(1, Math.abs(h))
  sprite.rotation = rotation
}
