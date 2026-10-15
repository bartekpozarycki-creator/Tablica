import { getStroke } from 'perfect-freehand'
import type { StrokeObject } from '../types'

export function hasRealPressure(points: number[]) {
  for (let i = 2; i < points.length; i += 3) {
    const pressure = points[i]
    if (pressure > 0 && Math.abs(pressure - 0.5) > 0.04) return true
  }
  return false
}

export function strokeOutline(points: number[], tool: StrokeObject['tool'], size: number) {
  const input: number[][] = []
  for (let i = 0; i < points.length; i += 3) input.push([points[i], points[i + 1], points[i + 2]])
  if (input.length === 0) return []
  if (input.length === 1) {
    const [x, y] = input[0]
    const radius = Math.max(0.8, size / 2)
    return [
      [x - radius, y],
      [x, y - radius],
      [x + radius, y],
      [x, y + radius],
    ]
  }
  const real = hasRealPressure(points)
  const fountain = tool === 'pen'
  return getStroke(input, {
    size,
    thinning: fountain ? 0.55 : 0,
    smoothing: tool === 'highlighter' ? 0.9 : fountain ? 0.88 : 0.74,
    streamline: tool === 'highlighter' ? 0.86 : fountain ? 0.82 : 0.68,
    simulatePressure: fountain && !real,
    easing: (value) => Math.sin((value * Math.PI) / 2),
    start: { cap: true, taper: fountain ? size * 0.12 : 0 },
    end: { cap: true, taper: fountain ? size * 0.45 : 0 },
    last: true,
  })
}

export function outlineFlat(outline: number[][]) {
  const flat: number[] = []
  for (const [x, y] of outline) flat.push(x, y)
  return flat
}
