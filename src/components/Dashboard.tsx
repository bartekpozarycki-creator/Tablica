import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import * as Y from 'yjs'
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'
import type { BoardEntry, Role } from '../types'
import { currentAccount, setRememberDevice, supabase, type Account } from '../supabase/client'
import {
  boardPath,
  createLocalBoard,
  deleteRemoteBoard,
  deleteRemoteRecord,
  joinBoardRecord,
  leaveBoard,
  loadBoardSnapshot,
  readBoards,
  registerBoard,
  remoteBoards,
  removeBoard,
  saveBoardSnapshot,
  syncBoardRecord,
  teacherKeyFor,
  upsertBoard,
} from '../lib/boards'
import { parseBoardLink, readName, readTheme, writeName, writeTheme, wsBase } from '../lib/utils'
import { Icon, Mark } from './icons'

export function Dashboard({ navigate }: { navigate: (path: string) => void }) {
  const [account, setAccount] = useState<Account | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [boards, setBoards] = useState<BoardEntry[]>(() => (supabase ? [] : readBoards().sort((a, b) => b.updatedAt - a.updatedAt)))
  const [name, setName] = useState(readName())
  const [title, setTitle] = useState('')
  const [booking, setBooking] = useState('')
  const [join, setJoin] = useState('')
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [theme, setTheme] = useState(readTheme())
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [remember, setRemember] = useState(false)
  const [pendingEmail, setPendingEmail] = useState('')
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle')

  useEffect(() => {
    const client = supabase
    if (!client) return
    let alive = true
    void currentAccount().then((value) => {
      if (!alive) return
      setAccount(value)
      if (value?.name) {
        setName(value.name)
        writeName(value.name)
      }
      setAuthReady(true)
    })
    const { data } = client.auth.onAuthStateChange((event, session) => {
      const user = session?.user
      if (user && !user.email_confirmed_at) {
        if (!alive) return
        setPendingEmail(user.email || '')
        setAccount(null)
        setAuthReady(true)
        if (event === 'SIGNED_IN') window.setTimeout(() => void client.auth.signOut(), 0)
        return
      }
      void currentAccount().then((value) => {
        if (!alive) return
        setAccount(value)
        if (value?.name) setName(value.name)
        if (value) setPendingEmail('')
      })
    })
    return () => {
      alive = false
      data.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (account) {
      void (async () => {
        try {
          await moveLocalBoardsToAccount(account.id)
          const remote = await remoteBoards(account.id)
          setBoards(remote.sort((a, b) => b.updatedAt - a.updatedAt))
        } catch (error) {
          setMessage(error instanceof Error ? error.message : 'Nie udało się wczytać tablic z konta.')
        }
      })()
      return
    }
    if (!supabase) setBoards(readBoards().sort((a, b) => b.updatedAt - a.updatedAt))
  }, [account])

  const create = async () => {
    if (!name.trim()) {
      setMessage('Wpisz imię, będzie widoczne przy kursorze.')
      return
    }
    writeName(name)
    const entry = createLocalBoard(title || 'Nowa tablica', booking, 'teacher', !account)
    setBusy(entry.id)
    try {
      if (account) await syncBoardRecord(entry, account.id)
      if (entry.teacherKey) {
        try {
          await registerBoard(entry.id, entry.title, entry.teacherKey, entry.bookingId || '')
        } catch (error) {
          if (!account) throw error
        }
      }
      navigate(boardPath(entry.id, entry.teacherKey))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Nie udało się utworzyć tablicy.')
    } finally {
      setBusy('')
    }
  }

  const openJoin = async () => {
    const parsed = parseBoardLink(join)
    if (!parsed) {
      setMessage('Wklej link albo kod tablicy.')
      return
    }
    if (!name.trim() && !account) {
      setMessage('Wpisz imię przed dołączeniem.')
      return
    }
    if (name.trim()) writeName(name)
    if (parsed.key) localStorage.setItem(`mattablica.teacher.${parsed.id}`, parsed.key)
    const role: Role = parsed.key ? 'teacher' : 'student'
    if (!account) {
      const existing = readBoards().find((board) => board.id === parsed.id)
      upsertBoard({
        id: parsed.id,
        title: existing?.title || 'Tablica',
        role,
        teacherKey: parsed.key,
        bookingId: existing?.bookingId,
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
      })
    }
    try {
      if (account) await joinBoardRecord(parsed.id, account.id, parsed.key ? 'editor' : 'observer')
      navigate(boardPath(parsed.id, parsed.key))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Nie udało się dołączyć do tablicy.')
    }
  }

  const duplicate = async (entry: BoardEntry) => {
    setBusy(entry.id)
    setMessage('')
    try {
      const copy = createLocalBoard(`${entry.title} - kopia`, entry.bookingId || '', 'teacher', !account)
      if (account) await syncBoardRecord(copy, account.id)
      if (copy.teacherKey) {
        try {
          await registerBoard(copy.id, copy.title, copy.teacherKey, copy.bookingId || '')
        } catch (error) {
          if (!account) throw error
        }
      }
      const source = new Y.Doc()
      const snap = await loadBoardSnapshot(entry.id)
      if (snap) Y.applyUpdate(source, snap)
      const sourceSocket = new WebsocketProvider(wsBase(), entry.id, source, {
        connect: true,
        params: entry.teacherKey ? { key: entry.teacherKey } : {},
      })
      await Promise.race([waitFor(sourceSocket), wait(4000)])
      const update = Y.encodeStateAsUpdate(source)
      sourceSocket.destroy()
      source.destroy()
      const target = new Y.Doc()
      Y.applyUpdate(target, update)
      target.getMap('meta').set('title', copy.title)
      const targetSocket = new WebsocketProvider(wsBase(), copy.id, target, {
        connect: true,
        params: copy.teacherKey ? { key: copy.teacherKey } : {},
      })
      await Promise.race([waitFor(targetSocket), wait(2500)])
      await saveBoardSnapshot(copy.id, target)
      targetSocket.destroy()
      target.destroy()
      if (account) setBoards(await remoteBoards(account.id))
      else setBoards(readBoards().sort((a, b) => b.updatedAt - a.updatedAt))
      setMessage('Kopia jest gotowa.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Nie udało się skopiować tablicy.')
    } finally {
      setBusy('')
    }
  }

  const remove = async (entry: BoardEntry) => {
    if (!window.confirm(`Usunąć „${entry.title}”?`)) return
    setBusy(entry.id)
    try {
      if (account && entry.role !== 'teacher') {
        await leaveBoard(entry.id, account.id)
      } else {
        await deleteRemoteBoard(entry.id, entry.teacherKey || teacherKeyFor(entry.id))
        await deleteRemoteRecord(entry.id)
      }
      await clearDocument(`mattablica-${entry.id}`)
      if (account) setBoards(await remoteBoards(account.id))
      else {
        removeBoard(entry.id)
        setBoards(readBoards())
      }
    } finally {
      setBusy('')
    }
  }

  const signIn = async () => {
    if (!supabase || authBusy) return
    setMessage('')
    setRememberDevice(remember)
    setAuthBusy(true)
    const redirect = window.location.origin
    try {
      if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirect,
            data: { name: name.trim() || 'Użytkownik', role: 'teacher' },
          },
        })
        if (error) {
          setMessage(polishAuthError(error.message, error.status))
          return
        }
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          setAuthMode('login')
          setMessage('Ten e-mail ma już konto. Zaloguj się albo otwórz link z wcześniejszej wiadomości.')
          return
        }
        if (!data.session || !data.user?.email_confirmed_at) {
          setPendingEmail(email.trim())
          return
        }
        return
      }
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        if (isUnconfirmed(error.message)) {
          setPendingEmail(email.trim())
          setMessage('')
          return
        }
        setMessage(polishAuthError(error.message, error.status))
        return
      }
      if (data.user && !data.user.email_confirmed_at) {
        setPendingEmail(data.user.email || email.trim())
        await supabase.auth.signOut()
      }
    } finally {
      setAuthBusy(false)
    }
  }

  const resendConfirmation = async () => {
    if (!supabase || !pendingEmail || resendState === 'sending') return
    setResendState('sending')
    setMessage('')
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: pendingEmail,
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) {
      setResendState('idle')
      setMessage(polishAuthError(error.message, error.status))
      return
    }
    setResendState('sent')
    window.setTimeout(() => setResendState('idle'), 4000)
  }

  if (!authReady) {
    return (
      <div className="shell grid h-dvh place-items-center px-4 text-[var(--ink)]">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid justify-items-center gap-4">
          <span className="h-12 w-12 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--accent)]" />
          <p className="font-[Fraunces] text-2xl">Łączę z kontem</p>
        </motion.div>
      </div>
    )
  }

  if (supabase && !account) {
    return (
      <div className="shell flex h-dvh flex-col overflow-y-auto px-4 py-6 text-[var(--ink)]">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="m-auto w-full max-w-md">
          {pendingEmail ? (
            <div className="rounded-[32px] border border-[var(--line)] bg-[var(--panel-solid)] p-6 shadow-[var(--shadow)] sm:p-8">
              <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[var(--accent-2)] text-[var(--accent)]">
                <Icon name="mail" className="h-7 w-7" />
              </span>
              <h1 className="mt-4 font-[Fraunces] text-4xl">Potwierdź e-mail</h1>
              <p className="mt-2 text-sm text-[var(--muted)]">Bez kliknięcia linku konto nie zostanie otwarte. Wiadomość jest na:</p>
              <p className="mt-3 truncate rounded-2xl bg-[var(--accent-2)] px-4 py-3 text-sm font-medium">{pendingEmail}</p>
              <ol className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                <li className="flex gap-2"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-xs text-[var(--accent-ink)]">1</span>Otwórz skrzynkę, także folder spam.</li>
                <li className="flex gap-2"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-xs text-[var(--accent-ink)]">2</span>Kliknij link aktywacyjny.</li>
                <li className="flex gap-2"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-xs text-[var(--accent-ink)]">3</span>Wróć tutaj - zalogujemy Cię sami.</li>
              </ol>
              {message && <p className="mt-3 text-sm text-[var(--danger)]">{message}</p>}
              <button type="button" disabled={resendState === 'sending'} onClick={() => void resendConfirmation()} className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] py-3 text-[var(--accent-ink)] disabled:opacity-70">
                {resendState === 'sending' && <Spinner />}
                {resendState === 'sent' ? 'Link wysłany ponownie' : resendState === 'sending' ? 'Wysyłam…' : 'Wyślij link jeszcze raz'}
              </button>
              <button type="button" className="mt-3 w-full text-sm text-[var(--muted)]" onClick={() => { setPendingEmail(''); setEmail(''); setPassword(''); setName(''); setRemember(false); setMessage(''); setAuthMode('login') }}>
                Wróć do logowania
              </button>
            </div>
          ) : (
            <form key={authMode} className="rounded-[32px] border border-[var(--line)] bg-[var(--panel-solid)] p-6 shadow-[var(--shadow)] sm:p-8" onSubmit={(event) => { event.preventDefault(); void signIn() }}>
              <Mark />
              <h1 className="mt-4 font-[Fraunces] text-4xl">MatTablica</h1>
              <p className="mt-2 text-sm text-[var(--muted)]">{authMode === 'login' ? 'Zaloguj się potwierdzonym adresem e-mail.' : 'Założymy konto i wyślemy link aktywacyjny.'}</p>
              {authMode === 'signup' && (
                <label className="mt-5 block text-xs text-[var(--muted)]">
                  Imię przy kursorze
                  <span className="mt-1 flex items-center gap-2 rounded-2xl border border-[var(--line)] px-3">
                    <Icon name="users" className="h-4 w-4" />
                    <input className="min-w-0 flex-1 bg-transparent py-3 outline-none" placeholder="Anna" value={name} onChange={(event) => setName(event.target.value)} disabled={authBusy} />
                  </span>
                </label>
              )}
              <label className={`${authMode === 'signup' ? 'mt-3' : 'mt-5'} block text-xs text-[var(--muted)]`}>
                E-mail
                <span className="mt-1 flex items-center gap-2 rounded-2xl border border-[var(--line)] px-3">
                  <Icon name="mail" className="h-4 w-4" />
                  <input className="min-w-0 flex-1 bg-transparent py-3 outline-none" type="email" placeholder="anna@szkola.pl" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={authBusy} autoComplete="email" />
                </span>
              </label>
              <label className="mt-3 block text-xs text-[var(--muted)]">
                Hasło
                <span className="mt-1 flex items-center gap-2 rounded-2xl border border-[var(--line)] px-3">
                  <Icon name="lock" className="h-4 w-4" />
                  <input className="min-w-0 flex-1 bg-transparent py-3 outline-none" type="password" placeholder="Co najmniej 6 znaków" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} disabled={authBusy} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} />
                </span>
              </label>
              <label className="mt-4 flex items-center gap-2 text-sm text-[var(--ink)]">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={authBusy} className="h-4 w-4 accent-[var(--accent)]" />
                Zapamiętaj na tym urządzeniu
              </label>
              {message && <p className="mt-3 rounded-2xl bg-[var(--accent-2)] px-3 py-2 text-sm text-[var(--danger)]">{message}</p>}
              <button type="submit" disabled={authBusy} className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] py-3 text-[var(--accent-ink)] disabled:opacity-70">
                {authBusy && <Spinner />}
                {authBusy ? (authMode === 'login' ? 'Logowanie…' : 'Wysyłam link…') : authMode === 'login' ? 'Zaloguj' : 'Utwórz konto'}
              </button>
              <button type="button" className="mt-3 w-full text-sm text-[var(--muted)]" disabled={authBusy} onClick={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setEmail(''); setPassword(''); setName(''); setRemember(false); setMessage('') }}>
                {authMode === 'login' ? 'Nie masz konta? Zarejestruj się' : 'Masz konto? Zaloguj się'}
              </button>
              <p className="mt-4 text-center text-xs leading-relaxed text-[var(--muted)]">Warto sprawdzić, czy mail nie trafił do spamu.</p>
            </form>
          )}
        </motion.div>
      </div>
    )
  }

  return (
    <div className="shell h-dvh overflow-auto text-[var(--ink)]">
      <div className="mx-auto flex min-h-full w-full max-w-[90rem] flex-col px-5 py-6 md:px-10">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Mark />
            <div>
              <p className="font-[Fraunces] text-2xl leading-none">MatTablica</p>
              <p className="mt-1 text-sm text-[var(--muted)]">Tablica do lekcji</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(['sand', 'ink', 'forest'] as const).map((value) => (
              <button key={value} type="button" aria-label={value} onClick={() => { setTheme(value); writeTheme(value) }} className={`h-6 w-6 rounded-full border ${value === 'sand' ? 'bg-[#f3ebdd]' : value === 'ink' ? 'bg-[#1c1917]' : 'bg-[#1f6b45]'} ${theme === value ? 'border-[var(--ink)]' : 'border-transparent'}`} />
            ))}
            {account && (
              <button type="button" className="rounded-full px-3 py-2 text-sm text-[var(--muted)]" onClick={() => supabase && void supabase.auth.signOut()}>
                Wyloguj
              </button>
            )}
          </div>
        </header>

        <div className="mt-8 grid flex-1 items-stretch gap-8 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[auto_minmax(0,1fr)]">
          <div>
            <h1 className="max-w-4xl font-[Fraunces] text-5xl leading-[1.05] md:text-6xl">Cała wiedza na jednej tablicy</h1>
            <TypedPhrase lines={phrases} />
          </div>
          <aside className="h-fit xl:sticky xl:top-6 xl:col-start-2 xl:row-span-2 xl:row-start-1">
            <div className="rounded-[28px] border border-[var(--line)] bg-[var(--panel-solid)] p-5 shadow-[var(--shadow)]">
              <div className="flex items-end gap-2">
                <label className="w-36 shrink-0">
                  <span className="text-xs text-[var(--muted)]">Imię przy kursorze</span>
                  <input className="field mt-1 text-base" value={name} onChange={(event) => setName(event.target.value)} placeholder="Anna" />
                </label>
                <button type="button" className="shrink-0 rounded-full bg-[var(--accent)] px-4 py-3 text-sm text-[var(--accent-ink)]" onClick={() => setCreating((value) => !value)}>
                  Nowa tablica
                </button>
              </div>
              {creating && (
                <div className="mt-3 grid gap-2">
                  <input className="field text-base" placeholder="Nazwa tablicy" value={title} onChange={(event) => setTitle(event.target.value)} />
                  <input className="field text-base" placeholder="Numer rezerwacji, opcjonalnie" value={booking} onChange={(event) => setBooking(event.target.value)} />
                  <button type="button" className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm text-[var(--bg)]" onClick={() => void create()}>Utwórz i otwórz</button>
                </div>
              )}
              <div className="mt-4 flex gap-2">
                <input className="field text-base" placeholder="Kod lub link do tablicy" value={join} onChange={(event) => setJoin(event.target.value)} />
                <button type="button" className="rounded-full bg-[var(--accent-2)] px-4 text-sm" onClick={() => void openJoin()}>Dołącz</button>
              </div>
              {message && <p className="mt-3 text-sm text-[var(--muted)]">{message}</p>}
              {!supabase && <p className="mt-3 text-xs text-[var(--muted)]">Konta szkoły włączysz, dodając klucze Supabase w pliku .env.</p>}
            </div>
          </aside>
          <section className="flex min-h-[18rem] flex-col xl:col-start-1 xl:h-full">
            <h2 className="font-[Fraunces] text-3xl">Twoje tablice</h2>
            {boards.length === 0 ? (
              <div className="mt-4 flex flex-1 items-center justify-center rounded-[28px] border border-dashed border-[var(--line)] bg-[var(--panel)] px-6 py-16 text-center text-[var(--muted)]">
                {account ? 'Nie ma jeszcze tablic na tym koncie.' : 'Nie ma jeszcze zapisanych tablic na tym urządzeniu.'}
              </div>
            ) : (
              <div className="mt-4 grid content-start items-stretch gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                {boards.map((board, index) => (
                  <motion.article key={board.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }} className="flex h-full flex-col rounded-[28px] border border-[var(--line)] bg-[var(--panel-solid)] p-4 shadow-[var(--shadow)]">
                    <button type="button" className="block w-full text-left" onClick={() => navigate(boardPath(board.id, board.teacherKey || teacherKeyFor(board.id)))}>
                      <h3 className="font-[Fraunces] text-2xl leading-tight">{board.title}</h3>
                      <p className="mt-1 text-sm text-[var(--muted)]">{new Date(board.createdAt).toLocaleString('pl-PL')}</p>
                      {board.bookingId && <p className="mt-1 text-sm text-[var(--muted)]">Rezerwacja {board.bookingId}</p>}
                    </button>
                    <BoardPeople board={board} fallbackName={name} />
                    <div className="mt-auto flex gap-2 pt-4">
                      <button type="button" className="rounded-full bg-[var(--accent-2)] px-3 py-1.5 text-sm" disabled={busy === board.id} onClick={() => void duplicate(board)}>Kopia</button>
                      <button type="button" className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-[var(--danger)]" disabled={busy === board.id} onClick={() => void remove(board)}>
                        <Icon name="trash" className="h-4 w-4" /> {board.role === 'teacher' ? 'Usuń' : 'Odejdź'}
                      </button>
                    </div>
                  </motion.article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

async function moveLocalBoardsToAccount(userId: string) {
  const local = readBoards().filter((board) => board.role === 'teacher')
  for (const entry of local) {
    const teacherKey = entry.teacherKey || teacherKeyFor(entry.id)
    if (!teacherKey) continue
    try {
      await syncBoardRecord({ ...entry, teacherKey, role: 'teacher' }, userId)
      const doc = new Y.Doc()
      const store = new IndexeddbPersistence(`mattablica-${entry.id}`, doc)
      await Promise.race([store.whenSynced, wait(2000)])
      const remote = await loadBoardSnapshot(entry.id)
      if (remote) Y.applyUpdate(doc, remote, 'account')
      const saved = doc.getArray('pages').length === 0 || (await saveBoardSnapshot(entry.id, doc))
      await store.destroy()
      doc.destroy()
      if (!saved) continue
      await clearDocument(`mattablica-${entry.id}`)
      removeBoard(entry.id)
    } catch {
      continue
    }
  }
}

function BoardPeople({ board, fallbackName }: { board: BoardEntry; fallbackName: string }) {
  const members = board.members?.length
    ? board.members
    : [{ name: fallbackName.trim() || 'Ty', access: board.role === 'teacher' ? 'editor' as const : 'observer' as const }]
  const editors = members.filter((person) => person.access === 'editor').map((person) => person.name)
  const observers = members.filter((person) => person.access === 'observer').map((person) => person.name)
  return (
    <div className="mt-3 grid gap-0.5 text-sm text-[var(--muted)]">
      <p>Edycja: {editors.join(', ') || 'brak'}</p>
      <p>Podgląd: {observers.join(', ') || 'brak'}</p>
    </div>
  )
}

function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
}

function isUnconfirmed(message: string) {
  const text = message.toLowerCase()
  return text.includes('email not confirmed') || text.includes('not confirmed')
}

function polishAuthError(message: string, status = 0) {
  const text = message.toLowerCase()
  if (status === 429 || text.includes('rate limit') || text.includes('too many') || text.includes('only request this')) return 'Za dużo maili aktywacyjnych. Sprawdź skrzynkę i spam. Supabase puści kolejny dopiero za jakiś czas.'
  if (text.includes('invalid login') || text.includes('invalid credentials')) return 'Nieprawidłowy e-mail albo hasło.'
  if (text.includes('already registered') || text.includes('already been registered')) return 'Ten e-mail ma już konto. Zaloguj się.'
  if (text.includes('password') && text.includes('least')) return 'Hasło musi mieć co najmniej 6 znaków.'
  if (text.includes('unable to validate email') || text.includes('invalid email')) return 'Ten adres e-mail wygląda na niepoprawny.'
  return message
}

const phrases = [
  'Wszystko, czego potrzebujesz, w jednym miejscu.',
  'Pisz swobodnie. Wracaj, kiedy chcesz.',
  'Wspólna przestrzeń, która niczego nie gubi.',
  'Od pomysłu do efektu, bez zbędnego bałaganu.',
  'Zawsze tam, gdzie skończyłeś.',
]

function TypedPhrase({ lines }: { lines: string[] }) {
  const [reduce] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(reduce ? lines[0].length : 0)
  const [deleting, setDeleting] = useState(false)
  const line = lines[index] ?? ''

  useEffect(() => {
    if (reduce) return
    const done = count === line.length
    const empty = count === 0
    const delay = !deleting && done ? 2000 : deleting && empty ? 280 : deleting ? 22 : 46
    const timer = window.setTimeout(() => {
      if (!deleting && !done) setCount((value) => value + 1)
      else if (!deleting && done) setDeleting(true)
      else if (deleting && !empty) setCount((value) => value - 1)
      else {
        setDeleting(false)
        setIndex((value) => (value + 1) % lines.length)
      }
    }, delay)
    return () => window.clearTimeout(timer)
  }, [count, deleting, index, line.length, lines.length, reduce])

  return (
    <p className="mt-4 min-h-12 max-w-2xl text-lg text-[var(--muted)]">
      <span className="sr-only">{line}</span>
      <span aria-hidden="true">{line.slice(0, count)}</span>
      <motion.span
        aria-hidden
        className="ml-[3px] inline-block h-[0.85em] w-[2px] translate-y-[0.08em] rounded-full bg-current"
        animate={reduce ? { opacity: 1 } : { opacity: [1, 0] }}
        transition={reduce ? { duration: 0 } : { duration: 0.7, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
      />
    </p>
  )
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function waitFor(provider: WebsocketProvider) {
  return new Promise<void>((resolve) => {
    if (provider.synced) {
      resolve()
      return
    }
    const done = (state: boolean) => {
      if (!state) return
      provider.off('sync', done)
      resolve()
    }
    provider.on('sync', done)
  })
}
