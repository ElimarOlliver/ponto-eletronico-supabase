import { createClient } from '@supabase/supabase-js'

// *CLIENT TYPES*
// Implementação intencional: o cliente Supabase é criado somente após
// /api/config (URL + chave anon pública) — mesma config do backend.
// Opções explícitas: sessão persistida + refresh automático do token (evita
// requests com access token expirado, causa de erros 401/403 intermitentes).

let client: Awaited<ReturnType<typeof createClient>> | null = null

let cachedConfig: { supabase_url: string; supabase_anon_key: string } | null = null

export async function getConfig(): Promise<{ supabase_url: string; supabase_anon_key: string }> {
  if (cachedConfig) return cachedConfig
  const res = await fetch('/api/config')
  if (!res.ok) {
    throw new Error('Falha ao carregar a configuração do servidor. Recarregue a página.')
  }
  cachedConfig = (await res.json()) as { supabase_url: string; supabase_anon_key: string }
  return cachedConfig
}

export async function getSupabase() {
  if (client) return client
  const cfg = await getConfig()
  client = createClient(cfg.supabase_url, cfg.supabase_anon_key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Necessário para o fluxo de redefinição por link (hash na URL).
      detectSessionInUrl: true,
    },
  })
  return client
}