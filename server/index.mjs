import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const file = path.resolve('.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 1) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnv()

const PORT = Number(process.env.PORT || 1234)
const DATA = path.resolve('data/boards')
const messageSync = 0
const messageAwareness = 1
const messageQueryAwareness = 3

await mkdir(DATA, { recursive: true })

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null

const rooms = new Map()
const loading = new Map()

function validId(id) {
  return /^[a-z0-9]{6,32}$/i.test(id)
}

function boardPath(id, ext) {
  return path.join(DATA, `${id}.${ext}`)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 100_000) throw new Error('too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(conn, encoder) {
  if (conn.readyState === 1) conn.send(encoding.toUint8Array(encoder))
}

function broadcast(room, bytes, except) {
  for (const conn of room.conns) {
    if (conn !== except && conn.readyState === 1) conn.send(bytes)
  }
}

async function accountSnapshot(id) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('board_snapshots')
    .select('snapshot')
    .eq('board_id', id)
    .maybeSingle()
  if (error || !data?.snapshot) return null
  try {
    return new Uint8Array(Buffer.from(data.snapshot, 'base64'))
  } catch {
    return null
  }
}

async function loadSnapshot(id) {
  const remote = await accountSnapshot(id)
  const file = boardPath(id, 'bin')
  const local = existsSync(file) ? new Uint8Array(await readFile(file)) : null
  if (remote && local) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, remote)
    Y.applyUpdate(doc, local)
    const merged = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    return merged
  }
  return remote || local
}

async function loadMeta(id) {
  const file = boardPath(id, 'json')
  if (!existsSync(file)) {
    return { teacherKey: '', title: 'Nowa lekcja', bookingId: '', createdAt: Date.now() }
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { teacherKey: '', title: 'Nowa lekcja', bookingId: '', createdAt: Date.now() }
  }
}

function attachRoom(id, doc, meta) {
  const awareness = new awarenessProtocol.Awareness(doc)
  const room = {
    id,
    doc,
    awareness,
    meta,
    conns: new Set(),
    saveTimer: 0,
    remoteTimer: 0,
    dead: false,
    saving: false,
  }

  doc.on('update', (update, origin) => {
    if (room.dead) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeUpdate(encoder, update)
    broadcast(room, encoding.toUint8Array(encoder), origin)
    scheduleSave(room)
  })

  awareness.on('update', ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed)
    if (!changed.length) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    )
    broadcast(room, encoding.toUint8Array(encoder), origin)
  })

  return room
}

function scheduleSave(room) {
  clearTimeout(room.saveTimer)
  room.saveTimer = setTimeout(() => {
    void saveRoom(room, false)
  }, 700)
  clearTimeout(room.remoteTimer)
  room.remoteTimer = setTimeout(() => {
    void saveRoom(room, true)
  }, 4000)
}

async function saveRoom(room, remote) {
  if (room.dead || room.saving) return
  room.saving = true
  try {
    if (remote) {
      const incoming = await accountSnapshot(room.id)
      if (incoming) Y.applyUpdate(room.doc, incoming, 'persist')
    }
    const bytes = Y.encodeStateAsUpdate(room.doc)
    await writeFile(boardPath(room.id, 'bin'), Buffer.from(bytes))
    await writeFile(boardPath(room.id, 'json'), JSON.stringify(room.meta))
    if (!remote || !supabase) return
    const { error } = await supabase.from('board_snapshots').upsert({
      board_id: room.id,
      snapshot: Buffer.from(bytes).toString('base64'),
      updated_at: new Date().toISOString(),
    })
    if (error) console.error('Supabase snapshot:', error.message)
    await supabase.from('boards').update({ updated_at: new Date().toISOString() }).eq('id', room.id)
    if (room.meta.teacherKey) {
      await supabase.from('board_secrets').upsert({
        board_id: room.id,
        teacher_key: room.meta.teacherKey,
      })
    }
  } finally {
    room.saving = false
  }
}

async function createRoom(id) {
  const doc = new Y.Doc()
  const meta = await loadMeta(id)
  const snapshot = await loadSnapshot(id)
  if (snapshot) Y.applyUpdate(doc, snapshot)
  return attachRoom(id, doc, meta)
}

async function getRoom(id) {
  const existing = rooms.get(id)
  if (existing) return existing
  const pending = loading.get(id)
  if (pending) return pending
  const promise = createRoom(id).then((room) => {
    rooms.set(id, room)
    loading.delete(id)
    return room
  })
  loading.set(id, promise)
  return promise
}

async function deleteRoom(id) {
  const room = rooms.get(id)
  if (room) {
    room.dead = true
    clearTimeout(room.saveTimer)
    clearTimeout(room.remoteTimer)
    for (const conn of room.conns) conn.close(4404, 'deleted')
    room.awareness.destroy()
    room.doc.destroy()
    rooms.delete(id)
  }
  await rm(boardPath(id, 'bin'), { force: true })
  await rm(boardPath(id, 'json'), { force: true })
  if (supabase) {
    await supabase.from('board_snapshots').delete().eq('board_id', id)
    await supabase.from('board_secrets').delete().eq('board_id', id)
  }
}

function handleMessage(room, conn, data) {
  const decoder = decoding.createDecoder(new Uint8Array(data))
  const messageType = decoding.readVarUint(decoder)
  if (messageType === messageSync) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    const syncType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
    if (syncType === syncProtocol.messageYjsSyncStep1) {
      send(conn, encoder)
      const follow = encoding.createEncoder()
      encoding.writeVarUint(follow, messageSync)
      syncProtocol.writeSyncStep1(follow, room.doc)
      send(conn, follow)
      return
    }
    if (encoding.length(encoder) > 1) send(conn, encoder)
    return
  }
  if (messageType === messageAwareness) {
    const update = decoding.readVarUint8Array(decoder)
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, conn)
    return
  }
  if (messageType === messageQueryAwareness) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(room.awareness.getStates().keys()),
      ),
    )
    send(conn, encoder)
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url || '/', 'http://localhost')
  try {
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, boards: rooms.size }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/boards') {
      const body = await readJson(req)
      const id = String(body.id || '')
      const teacherKey = String(body.teacherKey || '')
      const title = String(body.title || 'Nowa lekcja').slice(0, 120)
      if (!validId(id) || teacherKey.length < 12) {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      const room = await getRoom(id)
      if (room.meta.teacherKey && room.meta.teacherKey !== teacherKey) {
        res.writeHead(409)
        res.end('exists')
        return
      }
      room.meta.teacherKey = teacherKey
      room.meta.title = title
      room.meta.bookingId = body.bookingId ? String(body.bookingId).slice(0, 80) : room.meta.bookingId || ''
      await saveRoom(room, true)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    const match = url.pathname.match(/^\/boards\/([a-z0-9]+)$/i)
    if (match && req.method === 'DELETE') {
      const id = match[1]
      const key = url.searchParams.get('key') || ''
      const room = rooms.get(id)
      const meta = room?.meta || (existsSync(boardPath(id, 'json')) ? JSON.parse(readFileSync(boardPath(id, 'json'), 'utf8')) : null)
      if (meta?.teacherKey && meta.teacherKey !== key) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await deleteRoom(id)
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  } catch (error) {
    console.error(error)
    res.writeHead(500)
    res.end('error')
  }
})

const wss = new WebSocketServer({ server })

wss.on('connection', async (conn, req) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const id = decodeURIComponent(url.pathname.slice(1).split('/')[0] || '')
  if (!validId(id)) {
    conn.close(4400, 'bad room')
    return
  }
  const room = await getRoom(id)
  const teacherKey = url.searchParams.get('key') || ''
  if (!room.meta.teacherKey && teacherKey.length >= 12) {
    room.meta.teacherKey = teacherKey
    scheduleSave(room)
  }
  conn.controlled = new Set()
  room.conns.add(conn)
  conn.on('message', (data) => {
    try {
      handleMessage(room, conn, data)
    } catch (error) {
      console.error(error)
    }
  })
  const track = ({ added, removed }, origin) => {
    if (origin !== conn) return
    for (const clientId of added) conn.controlled.add(clientId)
    for (const clientId of removed) conn.controlled.delete(clientId)
  }
  room.awareness.on('update', track)
  conn.on('close', () => {
    room.conns.delete(conn)
    room.awareness.off('update', track)
    awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(conn.controlled), null)
    if (!room.conns.size) void saveRoom(room, true)
  })
})

async function flush() {
  await Promise.all([...rooms.values()].map((room) => saveRoom(room, true)))
}

process.on('SIGINT', () => {
  void flush().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void flush().finally(() => process.exit(0))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MatTablica sync on ws://localhost:${PORT}`)
})
