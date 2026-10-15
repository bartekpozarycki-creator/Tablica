import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { BoardObject, Role } from '../types'
import { loadBoardSnapshot } from '../lib/boards'
import { asObject, uid, wsBase } from '../lib/utils'

export type BoardSession = {
  id: string
  role: Role
  teacherKey: string
  doc: Y.Doc
  provider: WebsocketProvider
  objects: Y.Map<BoardObject>
  pages: Y.Array<string>
  pageNames: Y.Map<string>
  meta: Y.Map<string | number | boolean>
  grants: Y.Map<string>
  undo: Y.UndoManager
  refs: number
  hydrate: Promise<void> | null
}

const sessions = new Map<string, BoardSession>()

export function listObjects(session: BoardSession) {
  const objects: BoardObject[] = []
  session.objects.forEach((value) => {
    const object = asObject(value)
    if (object) objects.push(object)
  })
  return objects
}

export function mutate(session: BoardSession, run: () => void) {
  session.doc.transact(run)
}

export function acquireSession(id: string, role: Role, teacherKey: string) {
  const existing = sessions.get(id)
  if (existing) {
    existing.refs += 1
    if (role === 'teacher') existing.role = 'teacher'
    if (teacherKey) existing.teacherKey = teacherKey
    return existing
  }
  const doc = new Y.Doc()
  const objects = doc.getMap<BoardObject>('objects')
  const pages = doc.getArray<string>('pages')
  const pageNames = doc.getMap<string>('pageNames')
  const meta = doc.getMap<string | number | boolean>('meta')
  const grants = doc.getMap<string>('grants')
  const undo = new Y.UndoManager([objects, pages, pageNames, meta], { captureTimeout: 500 })
  const params: Record<string, string> = {}
  if (teacherKey) params.key = teacherKey
  const provider = new WebsocketProvider(wsBase(), id, doc, {
    connect: false,
    params,
    resyncInterval: 12000,
    maxBackoffTime: 4000,
  })
  const session: BoardSession = {
    id,
    role,
    teacherKey,
    doc,
    provider,
    objects,
    pages,
    pageNames,
    meta,
    grants,
    undo,
    refs: 1,
    hydrate: null,
  }
  sessions.set(id, session)
  return session
}

export function releaseSession(id: string) {
  const session = sessions.get(id)
  if (!session) return
  session.refs -= 1
  if (session.refs > 0) return
  window.setTimeout(() => {
    if (session.refs > 0) return
    session.provider.destroy()
    session.doc.destroy()
    sessions.delete(id)
  }, 250)
}

function waitForSync(session: BoardSession) {
  return new Promise<void>((resolve) => {
    if (session.provider.synced) {
      resolve()
      return
    }
    const done = (state: boolean) => {
      if (!state) return
      session.provider.off('sync', done)
      resolve()
    }
    session.provider.on('sync', done)
  })
}

function hydrateAccount(session: BoardSession) {
  if (!session.hydrate) {
    session.hydrate = (async () => {
      try {
        const snapshot = await loadBoardSnapshot(session.id)
        if (snapshot) Y.applyUpdate(session.doc, snapshot, 'account')
      } finally {
        session.provider.connect()
      }
    })()
  }
  return session.hydrate
}

export async function ensureReady(session: BoardSession, title: string, bookingId: string) {
  await hydrateAccount(session)
  await Promise.race([
    waitForSync(session),
    new Promise((resolve) => window.setTimeout(resolve, 2800)),
  ])
  if (session.pages.length === 0) {
    mutate(session, () => {
      if (session.pages.length > 0) return
      const pageId = uid()
      session.pages.push([pageId])
      session.pageNames.set(pageId, 'Strona 1')
      if (!session.meta.has('background')) session.meta.set('background', 'grid')
      if (!session.meta.has('studentsCanDraw')) session.meta.set('studentsCanDraw', true)
      if (!session.meta.has('title')) session.meta.set('title', title || 'Nowa lekcja')
      if (bookingId && !session.meta.has('bookingId')) session.meta.set('bookingId', bookingId)
    })
    session.undo.clear()
  }
}
