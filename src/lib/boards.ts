import * as Y from 'yjs'
import type { BoardAccess, BoardEntry, BoardMemberInfo, Role } from '../types'
import { httpBase, uid } from './utils'
import { supabase } from '../supabase/client'

const KEY = 'mattablica.boards'

export function readBoards(): BoardEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]') as BoardEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeBoards(boards: BoardEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(boards))
}

export function upsertBoard(entry: BoardEntry) {
  const boards = readBoards().filter((board) => board.id !== entry.id)
  boards.unshift(entry)
  writeBoards(boards)
  return boards
}

export function removeBoard(id: string) {
  writeBoards(readBoards().filter((board) => board.id !== id))
}

export function teacherKeyFor(id: string) {
  return localStorage.getItem(`mattablica.teacher.${id}`) || ''
}

export function rememberTeacherKey(id: string, key: string) {
  if (key) localStorage.setItem(`mattablica.teacher.${id}`, key)
}

export function boardPath(id: string, key?: string) {
  const url = new URL(`/b/${id}`, location.origin)
  if (key) url.searchParams.set('k', key)
  return `${url.pathname}${url.search}`
}

export function boardLink(id: string, key?: string) {
  return new URL(boardPath(id, key), location.origin).toString()
}

export async function registerBoard(id: string, title: string, teacherKey: string, bookingId = '') {
  const response = await fetch(`${httpBase()}/boards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title, teacherKey, bookingId }),
  })
  if (!response.ok && response.status !== 409) {
    throw new Error('Serwer tablicy nie odpowiada. Uruchom npm run dev.')
  }
}

export async function deleteRemoteBoard(id: string, teacherKey: string) {
  await fetch(`${httpBase()}/boards/${id}?key=${encodeURIComponent(teacherKey)}`, { method: 'DELETE' })
}

export function createLocalBoard(title: string, bookingId = '', role: Role = 'teacher', storeLocal = false): BoardEntry {
  const id = uid(10)
  const teacherKey = role === 'teacher' ? uid(22) : undefined
  if (teacherKey) rememberTeacherKey(id, teacherKey)
  const entry: BoardEntry = {
    id,
    title: title.trim() || 'Nowa lekcja',
    role,
    teacherKey,
    bookingId: bookingId.trim() || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  if (storeLocal) upsertBoard(entry)
  return entry
}

export async function syncBoardRecord(entry: BoardEntry, userId?: string) {
  if (!supabase || !userId || entry.role !== 'teacher' || !entry.teacherKey) return
  const { error } = await supabase.from('boards').upsert({
    id: entry.id,
    title: entry.title,
    owner_id: userId,
    booking_id: entry.bookingId || null,
    updated_at: new Date(entry.updatedAt).toISOString(),
  })
  if (error) throw new Error(`Nie udało się zapisać tablicy na koncie. ${error.message}`)
  const member = await supabase.from('board_members').upsert({
    board_id: entry.id,
    user_id: userId,
    role: 'teacher',
    access: 'editor',
  })
  if (member.error) throw new Error(`Nie udało się zapisać tablicy na koncie. ${member.error.message}`)
  const secret = await supabase.from('board_secrets').upsert({
    board_id: entry.id,
    teacher_key: entry.teacherKey,
  })
  if (secret.error) throw new Error(`Nie udało się zapisać tablicy na koncie. ${secret.error.message}`)
}

export async function joinBoardRecord(id: string, userId?: string, access: BoardAccess = 'observer'): Promise<BoardAccess> {
  if (!supabase || !userId) return access
  const existing = await supabase.from('board_members').select('access').eq('board_id', id).eq('user_id', userId).maybeSingle()
  const current = existing.data?.access
  if (current === 'editor' || current === 'observer') return current
  const { error } = await supabase.from('board_members').insert({
    board_id: id,
    user_id: userId,
    role: 'student',
    access,
  })
  if (error) return 'observer'
  return access
}

export async function boardOwnerId(id: string) {
  if (!supabase) return null
  const { data } = await supabase.from('boards').select('owner_id').eq('id', id).maybeSingle()
  if (!data) return null
  return (data.owner_id as string | undefined) || ''
}

export async function setMemberAccess(boardId: string, userId: string, access: BoardAccess) {
  if (!supabase || !userId) return
  const updated = await supabase.from('board_members').update({ access }).eq('board_id', boardId).eq('user_id', userId).select('user_id')
  if (updated.error || (updated.data && updated.data.length > 0)) return
  await supabase.from('board_members').insert({
    board_id: boardId,
    user_id: userId,
    role: 'student',
    access,
  })
}

export async function ownerTeacherKey(id: string) {
  if (!supabase) return ''
  const { data: auth } = await supabase.auth.getSession()
  if (!auth.session) return ''
  const { data } = await supabase.from('board_secrets').select('teacher_key').eq('board_id', id).maybeSingle()
  const key = (data?.teacher_key as string | undefined) || ''
  if (key) rememberTeacherKey(id, key)
  return key
}

export async function leaveBoard(id: string, userId: string) {
  if (!supabase) return
  await supabase.from('board_members').delete().eq('board_id', id).eq('user_id', userId)
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const size = 0x8000
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size))
  }
  return btoa(binary)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function loadBoardSnapshot(id: string) {
  if (!supabase) return null
  const { data: auth } = await supabase.auth.getSession()
  if (!auth.session) return null
  const { data, error } = await supabase.from('board_snapshots').select('snapshot').eq('board_id', id).maybeSingle()
  if (error || !data?.snapshot) return null
  try {
    return base64ToBytes(data.snapshot as string)
  } catch {
    return null
  }
}

export async function saveBoardSnapshot(id: string, doc: Y.Doc) {
  if (!supabase) return false
  const { data: auth } = await supabase.auth.getSession()
  if (!auth.session) return false
  const snapshot = bytesToBase64(Y.encodeStateAsUpdate(doc))
  const { error } = await supabase.from('board_snapshots').upsert({
    board_id: id,
    snapshot,
    updated_at: new Date().toISOString(),
  })
  if (error) return false
  await supabase.from('boards').update({ updated_at: new Date().toISOString() }).eq('id', id)
  return true
}

export async function remoteBoards(userId: string): Promise<BoardEntry[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('boards')
    .select('id,title,booking_id,created_at,updated_at,owner_id')
    .order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  if (!data) return []
  const secrets = await supabase.from('board_secrets').select('board_id,teacher_key')
  const keys = new Map((secrets.data || []).map((row) => [row.board_id as string, row.teacher_key as string]))
  const people = await loadBoardPeople()
  return data.map((row) => {
    const id = row.id as string
    const owned = row.owner_id === userId
    const teacherKey = owned ? keys.get(id) || teacherKeyFor(id) : undefined
    if (teacherKey) rememberTeacherKey(id, teacherKey)
    return {
      id,
      title: row.title as string,
      role: owned ? 'teacher' as const : 'student' as const,
      teacherKey,
      bookingId: (row.booking_id as string | null) || undefined,
      createdAt: new Date(row.created_at as string).getTime(),
      updatedAt: new Date(row.updated_at as string).getTime(),
      members: people ? people.get(id) || [] : undefined,
    }
  })
}

async function loadBoardPeople() {
  if (!supabase) return null
  const { data, error } = await supabase.rpc('my_board_people')
  if (error || !Array.isArray(data)) return null
  const map = new Map<string, BoardMemberInfo[]>()
  for (const row of data as Array<{ board_id?: string; name?: string; access?: string }>) {
    const boardId = row.board_id || ''
    const name = (row.name || '').trim()
    if (!boardId || !name) continue
    const access: BoardAccess = row.access === 'editor' ? 'editor' : 'observer'
    const list = map.get(boardId) || []
    if (list.some((item) => item.name === name && item.access === access)) continue
    list.push({ name, access })
    map.set(boardId, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'pl'))
  return map
}

export async function renameRemoteBoard(id: string, title: string) {
  if (!supabase) return
  await supabase.from('boards').update({ title, updated_at: new Date().toISOString() }).eq('id', id)
}

export async function deleteRemoteRecord(id: string) {
  if (!supabase) return
  await supabase.from('board_snapshots').delete().eq('board_id', id)
  await supabase.from('board_secrets').delete().eq('board_id', id)
  await supabase.from('board_members').delete().eq('board_id', id)
  await supabase.from('boards').delete().eq('id', id)
}
