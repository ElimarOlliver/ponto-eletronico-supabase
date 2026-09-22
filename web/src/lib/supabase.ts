import { createClient } from '@supabase/supabase-js'

// *CLIENT TYPES*
// Implementação intencional: o cliente Supabase é criado somente após
// /api/config (URL + chave anon pública) — mesma config do backend.

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
  client = createClient(cfg.supabase_url, cfg.supabase_anon_key)
  return client
}