import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
const rememberKey = 'mattablica.remember'

let rememberDevice = localStorage.getItem(rememberKey) !== '0'

export function setRememberDevice(value: boolean) {
  rememberDevice = value
  localStorage.setItem(rememberKey, value ? '1' : '0')
}

const authStorage = {
  getItem(key: string) {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key)
  },
  setItem(key: string, value: string) {
    if (rememberDevice) {
      sessionStorage.removeItem(key)
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
      sessionStorage.setItem(key, value)
    }
  },
  removeItem(key: string) {
    localStorage.removeItem(key)
    sessionStorage.removeItem(key)
  },
}

export const supabase: SupabaseClient | null = url && key ? createClient(url, key, {
  auth: {
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
}) : null

export type Account = {
  id: string
  email: string
  name: string
  role: 'teacher' | 'student'
}

export async function currentAccount(): Promise<Account | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  const user = data.session?.user
  if (!user || !user.email_confirmed_at) return null
  const { data: profile } = await supabase.from('profiles').select('name,role').eq('id', user.id).maybeSingle()
  const role = profile?.role === 'teacher' || user.user_metadata?.role === 'teacher' ? 'teacher' : 'student'
  const name = profile?.name || user.user_metadata?.name || 'Użytkownik'
  if (!profile) {
    await supabase.from('profiles').upsert({ id: user.id, name, role })
  }
  return {
    id: user.id,
    email: user.email || '',
    name,
    role,
  }
}
