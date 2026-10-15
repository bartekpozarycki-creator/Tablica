import type { BoardObject, ImageObject, ShapeObject, StampObject, StrokeObject, TextObject } from '../types'

export type Rect = { x: number; y: number; w: number; h: number }

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function hexToNumber(hex: string) {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((part) => part + part).join('') : clean
  const value = Number.parseInt(full, 16)
  return Number.isFinite(value) ? value : 0x1c1917
}

export function dist(x1: number, y1: number, x2: number, y2: number) {
  return Math.hypot(x2 - x1, y2 - y1)
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = dx * dx + dy * dy
  if (length === 0) return Math.hypot(px - x1, py - y1)
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / length, 0, 1)
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export function normalizeRect(x: number, y: number, w: number, h: number): Rect {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  }
}

export function expandRect(rect: Rect, pad: number): Rect {
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 }
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const rect of rects) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function pointInRect(x: number, y: number, rect: Rect, pad = 0) {
  return x >= rect.x - pad && y >= rect.y - pad && x <= rect.x + rect.w + pad && y <= rect.y + rect.h + pad
}

export function pointInPolygon(x: number, y: number, poly: Array<[number, number]>) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 0.00001) + xi
    if (hit) inside = !inside
  }
  return inside
}

export function rotatePoint(x: number, y: number, cx: number, cy: number, angle: number) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = x - cx
  const dy = y - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

export function centerOf(rect: Rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

function padded(rect: Rect, pad: number): Rect {
  const next = { ...rect }
  if (next.w < pad) {
    next.x -= (pad - next.w) / 2
    next.w = pad
  }
  if (next.h < pad) {
    next.y -= (pad - next.h) / 2
    next.h = pad
  }
  return next
}

export function boundsOf(object: BoardObject): Rect {
  if (object.type === 'stroke') {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < object.points.length; i += 3) {
      minX = Math.min(minX, object.points[i])
      minY = Math.min(minY, object.points[i + 1])
      maxX = Math.max(maxX, object.points[i])
      maxY = Math.max(maxY, object.points[i + 1])
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: object.size, h: object.size }
    return expandRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, object.size / 2 + 2)
  }
  if (object.type === 'stamp') return { x: object.x, y: object.y, w: object.size, h: object.size }
  if (object.type === 'shape' && (object.kind === 'line' || object.kind === 'arrow')) {
    return padded(normalizeRect(object.x, object.y, object.w, object.h), object.strokeWidth + 8)
  }
  return padded(normalizeRect(object.x, object.y, object.w, object.h), 2)
}

export function hitObject(object: BoardObject, x: number, y: number) {
  if (object.type === 'image' && object.rotation) {
    const bounds = boundsOf(object)
    const center = centerOf(bounds)
    const local = rotatePoint(x, y, center.x, center.y, -object.rotation)
    return pointInRect(local.x, local.y, bounds)
  }
  const bounds = boundsOf(object)
  if (!pointInRect(x, y, bounds, 4)) return false
  if (object.type === 'stroke') {
    const reach = object.size / 2 + 8
    for (let i = 0; i < object.points.length; i += 3) {
      const x1 = object.points[i]
      const y1 = object.points[i + 1]
      if (i + 3 >= object.points.length) return dist(x, y, x1, y1) <= reach
      if (distToSegment(x, y, x1, y1, object.points[i + 3], object.points[i + 4]) <= reach) return true
    }
    return false
  }
  if (object.type === 'shape' && (object.kind === 'line' || object.kind === 'arrow')) {
    return distToSegment(x, y, object.x, object.y, object.x + object.w, object.y + object.h) <= object.strokeWidth + 8
  }
  return true
}

export function topObjectAt(objects: BoardObject[], x: number, y: number) {
  const ordered = objects.slice().sort((a, b) => b.z - a.z)
  return ordered.find((object) => hitObject(object, x, y)) || null
}

export function translateObject<T extends BoardObject>(object: T, dx: number, dy: number): T {
  if (object.type === 'stroke') {
    const points = object.points.slice()
    for (let i = 0; i < points.length; i += 3) {
      points[i] += dx
      points[i + 1] += dy
    }
    return { ...object, points }
  }
  return { ...object, x: object.x + dx, y: object.y + dy }
}

export function scaleObjectTo(object: BoardObject, from: Rect, to: Rect): BoardObject {
  const sx = Math.abs(from.w) < 0.001 ? 1 : to.w / from.w
  const sy = Math.abs(from.h) < 0.001 ? 1 : to.h / from.h
  if (object.type === 'stroke') {
    const points: number[] = []
    for (let i = 0; i < object.points.length; i += 3) {
      points.push(to.x + (object.points[i] - from.x) * sx, to.y + (object.points[i + 1] - from.y) * sy, object.points[i + 2])
    }
    return { ...object, points, size: Math.max(0.8, object.size * (Math.abs(sx) + Math.abs(sy)) / 2) }
  }
  if (object.type === 'stamp') {
    return {
      ...object,
      x: to.x + (object.x - from.x) * sx,
      y: to.y + (object.y - from.y) * sy,
      size: Math.max(18, object.size * Math.abs(sx)),
    }
  }
  const x = to.x + (object.x - from.x) * sx
  const y = to.y + (object.y - from.y) * sy
  const w = object.w * sx
  const h = object.h * sy
  if (object.type === 'text') {
    return { ...object, x, y, w: Math.max(48, w), h: Math.max(28, h), fontSize: Math.max(12, Math.round(object.fontSize * Math.abs(sy))) }
  }
  if (object.type === 'shape') return { ...object, x, y, w, h }
  return { ...object, x, y, w: Math.max(16, w), h: Math.max(16, h) }
}

export function resizeBounds(bounds: Rect, handle: string, dx: number, dy: number, keepRatio: boolean): Rect {
  let { x, y, w, h } = bounds
  const aspect = h === 0 ? 1 : w / h
  if (handle.includes('e')) w += dx
  if (handle.includes('s')) h += dy
  if (handle.includes('w')) {
    x += dx
    w -= dx
  }
  if (handle.includes('n')) {
    y += dy
    h -= dy
  }
  if (keepRatio && handle.length === 2) {
    const width = Math.abs(w)
    const height = Math.abs(h)
    if (width / Math.max(height, 1) > Math.abs(aspect)) h = (Math.sign(h) || 1) * (width / Math.abs(aspect || 1))
    else w = (Math.sign(w) || 1) * (height * Math.abs(aspect))
    if (handle.includes('w')) x = bounds.x + bounds.w - w
    if (handle.includes('n')) y = bounds.y + bounds.h - h
  }
  if (Math.abs(w) < 12) w = 12 * (Math.sign(w) || 1)
  if (Math.abs(h) < 12) h = 12 * (Math.sign(h) || 1)
  return { x, y, w, h }
}

export function objectTouchesCircle(object: BoardObject, x: number, y: number, radius: number) {
  if (object.type === 'stroke') {
    for (let i = 0; i < object.points.length; i += 3) {
      const x1 = object.points[i]
      const y1 = object.points[i + 1]
      const next = i + 3 < object.points.length
      const reach = radius + object.size / 2
      if (!next && dist(x, y, x1, y1) <= reach) return true
      if (next && distToSegment(x, y, x1, y1, object.points[i + 3], object.points[i + 4]) <= reach) return true
    }
    return false
  }
  if (object.type === 'shape' && (object.kind === 'line' || object.kind === 'arrow')) {
    return distToSegment(x, y, object.x, object.y, object.x + object.w, object.y + object.h) <= radius + object.strokeWidth
  }
  return pointInRect(x, y, expandRect(boundsOf(object), radius))
}

export function splitStroke(object: StrokeObject, circles: Array<{ x: number; y: number; r: number }>): StrokeObject[] | null {
  const hits = (x1: number, y1: number, x2?: number, y2?: number) =>
    circles.some((circle) => {
      const reach = circle.r + object.size / 2
      if (x2 === undefined || y2 === undefined) return dist(circle.x, circle.y, x1, y1) <= reach
      return distToSegment(circle.x, circle.y, x1, y1, x2, y2) <= reach
    })
  let touched = false
  const pieces: number[][] = []
  let current: number[] = []
  for (let i = 0; i < object.points.length; i += 3) {
    const x = object.points[i]
    const y = object.points[i + 1]
    const pressure = object.points[i + 2]
    const nextX = object.points[i + 3]
    const nextY = object.points[i + 4]
    const hit = hits(x, y, nextX, nextY)
    if (hit) {
      touched = true
      if (current.length >= 3) pieces.push(current)
      current = []
    } else {
      current.push(x, y, pressure)
    }
  }
  if (!touched) return null
  if (current.length >= 3) pieces.push(current)
  return pieces.map((points, index) => ({
    ...object,
    id: index === 0 ? object.id : `${object.id}-${index}-${points.length}`,
    points,
  }))
}

export function constrainShape(kind: ShapeObject['kind'], w: number, h: number, shift: boolean) {
  if (!shift) return { w, h }
  if (kind === 'rect' || kind === 'ellipse' || kind === 'triangle' || kind === 'cuboid' || kind === 'axes' || kind === 'quad' || kind === 'linear' || kind === 'sine') {
    const size = Math.max(Math.abs(w), Math.abs(h))
    return { w: (Math.sign(w) || 1) * size, h: (Math.sign(h) || 1) * size }
  }
  const angle = Math.atan2(h, w)
  const snap = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4)
  const length = Math.hypot(w, h)
  return { w: Math.cos(snap) * length, h: Math.sin(snap) * length }
}

export function isBox(object: BoardObject): object is TextObject | ImageObject | ShapeObject | StampObject {
  return object.type !== 'stroke'
}
