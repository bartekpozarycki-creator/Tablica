interface ImportMetaEnv {
  readonly VITE_WS_URL?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_BOOKING_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
