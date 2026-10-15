import type { BoardObject } from '../types'

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function clientToken() {
  const key = 'mattablica.client'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const next = uid(16)
  localStorage.setItem(key, next)
  return next
}

export function uid(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let value = ''
  for (let i = 0; i < length; i += 1) value += ALPHABET[bytes[i] % ALPHABET.length]
  return value
}

export function clone<T>(value: T): T {
  return structuredClone(value)
}

export function wsBase() {
  return (import.meta.env.VITE_WS_URL || `ws://${location.hostname}:1234`).replace(/\/$/, '')
}

export function httpBase() {
  return wsBase().replace(/^ws/i, 'http')
}

export function bookingUrl(bookingId: string) {
  const base = import.meta.env.VITE_BOOKING_BASE_URL || ''
  if (!base || !bookingId) return ''
  return `${base.replace(/\/$/, '')}/${encodeURIComponent(bookingId)}`
}

export function parseBoardLink(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed, location.origin)
    const parts = url.pathname.split('/').filter(Boolean)
    const marker = parts.indexOf('b')
    const id = marker >= 0 ? parts[marker + 1] : ''
    if (id && /^[a-z0-9]{6,32}$/i.test(id)) {
      return { id, key: url.searchParams.get('k') || undefined }
    }
  } catch {
    return null
  }
  if (/^[a-z0-9]{6,32}$/i.test(trimmed)) return { id: trimmed }
  return null
}

const OBJECT_TYPES = new Set(['stroke', 'shape', 'text', 'image', 'equation', 'stamp'])

export function asObject(value: unknown): BoardObject | null {
  if (!value || typeof value !== 'object') return null
  const object = value as BoardObject
  if (!OBJECT_TYPES.has(object.type) || typeof object.id !== 'string' || typeof object.pageId !== 'string') {
    return null
  }
  return object
}

export const PEN_COLORS = ['#1c1917', '#1f6b45', '#c4492c', '#1d4e89', '#8a5a00', '#6b3fa0', '#ffffff']
export const HIGHLIGHTER_COLORS = ['#ffe36b', '#b8f2a2', '#ffc2d4', '#bde0fe', '#ffd6a5']

export function readPalette(kind: 'pen' | 'highlighter') {
  const fallback = kind === 'pen' ? PEN_COLORS : HIGHLIGHTER_COLORS
  try {
    const parsed = JSON.parse(localStorage.getItem(`mattablica.colors.${kind}`) || 'null')
    if (!Array.isArray(parsed)) return [...fallback]
    const colors = parsed.filter((entry) => typeof entry === 'string' && /^#[0-9a-f]{6}$/i.test(entry)).slice(0, 7)
    return colors.length ? colors : [...fallback]
  } catch {
    return [...fallback]
  }
}

export function writePalette(kind: 'pen' | 'highlighter', colors: string[]) {
  localStorage.setItem(`mattablica.colors.${kind}`, JSON.stringify(colors.slice(0, 7)))
}
export const CURSOR_COLORS = ['#1f6b45', '#c4492c', '#1d4e89', '#8a5a00', '#6b3fa0', '#0f766e', '#b4235a']

export function colorFor(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return CURSOR_COLORS[hash % CURSOR_COLORS.length]
}

export function readName() {
  return localStorage.getItem('mattablica.name') || ''
}

export function writeName(name: string) {
  localStorage.setItem('mattablica.name', name.trim())
}

export function readTheme() {
  return localStorage.getItem('mattablica.theme') || 'sand'
}

export function writeTheme(theme: string) {
  localStorage.setItem('mattablica.theme', theme)
  document.documentElement.dataset.theme = theme
}
