import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import type { Me } from '../types'
import { readError, setActiveCompanyId as setApiActiveCompany } from '../lib/api'
import { getSupabase } from '../lib/supabase'

// *AUTH / SESSION*
// O tenant é resolvido no backend: o frontend envia e-mail/senha ao Supabase
// (GoTrue) e usa o token para /api/me. Empresas vêm no payload de /api/me e o
// switch grava apenas X-Company-ID + localStorage — sem relogin.

type Status = 'loading' | 'anonymous' | 'authenticated'

interface AuthValue {
  status: Status
  session: Session | null
  me: Me | null
  activeCompanyId: string | null
  authError: string | null
  clearAuthError: () => void
  login: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  switchCompany: (id: string) => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

const STORAGE_KEY = 'pe_active_company'

async function fetchMe(token: string, companyId: string | null): Promise<Me> {
  const headers: Record<string, string> = { Authorization: 'Bearer ' + token }
  if (companyId) headers['X-Company-ID'] = companyId
  const res = await fetch('/api/me', { headers })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as Me
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [session, setSession] = useState<Session | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })

  // Mantém o header X-Company-ID do client de API em sincronia.
  useEffect(() => {
    setApiActiveCompany(activeCompanyId)
  }, [activeCompanyId])

  // Boot: restaura sessão existente.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const supabase = await getSupabase()
        const {
          data: { session: s },
        } = await supabase.auth.getSession()
        if (!active) return
        if (s) {
          setSession(s)
          setStatus('authenticated')
        } else {
          setStatus('anonymous')
        }
        supabase.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_OUT') {
            setStatus('anonymous')
            setSession(null)
            setMe(null)
          }
        })
      } catch {
        if (active) setStatus('anonymous')
      }
    })()
    return () => {
      active = false
    }
  }, [])

  // Quando autenticado: carrega /api/me e valida a empresa ativa salva.
  useEffect(() => {
    if (status !== 'authenticated') return
    let cancelled = false
    ;(async () => {
      try {
        const supabase = await getSupabase()
        const {
          data: { session: s },
        } = await supabase.auth.getSession()
        if (!s || cancelled) return
        setSession(s)
        let companyId: string | null = activeCompanyId
        let profile = await fetchMe(s.access_token, companyId)
        const companies = profile.companies ?? []
        if (companyId && companies.length > 0 && !companies.some((c) => c.id === companyId)) {
          // Empresa salva não pertence mais ao vínculo: volta para a padrão.
          companyId = profile.company_id || companies[0]?.id || null
          setActiveCompanyId(companyId)
          try {
            localStorage.setItem(STORAGE_KEY, companyId ?? '')
          } catch {
            /* ignore */
          }
          if (cancelled) return
          profile = await fetchMe(s.access_token, companyId)
        }
        if (!cancelled) {
          setMe(profile)
          setAuthError(null)
        }
      } catch (e) {
        if (!cancelled) {
          // Perfil não carregado (vínculo removido/fallback): encerra a sessão.
          // scope 'local' evita o 403 do /logout?scope=global com token expirado.
          const supabase = await getSupabase().catch(() => null)
          await supabase?.auth.signOut({ scope: 'local' }).catch(() => null)
          setStatus('anonymous')
          setSession(null)
          setMe(null)
          setAuthError(e instanceof Error ? e.message : 'Falha ao carregar o perfil. Faça login novamente.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [status, activeCompanyId])

  const clearAuthError = useCallback(() => setAuthError(null), [])

  const login = useCallback(async (email: string, password: string) => {
    setAuthError('')
    try {
      const supabase = await getSupabase()
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        const statusCode = Number((error as { status?: number; code?: string }).status ?? 0)
        if (statusCode >= 500) {
          setAuthError('Servidor de autenticação indisponível no momento. Tente novamente em instantes.')
        } else {
          setAuthError('E-mail ou senha inválidos. Verifique e tente novamente.')
        }
        return
      }
      if (!data.session) {
        setAuthError('Falha ao iniciar sessão. Tente novamente.')
        return
      }
      const profile = await fetchMe(data.session.access_token, null)
      setSession(data.session)
      setMe(profile)
      setStatus('authenticated')
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : 'Falha no login. Tente novamente.')
    }
  }, [])

  const signOut = useCallback(async () => {
    // scope: 'local' encerra SOMENTE a sessão deste navegador e não depende de
    // um access token válido no servidor. O padrão do SDK é 'global', que
    // chama /logout?scope=global e responde 403 quando o token expirou ou a
    // sessão já não existe — o que aparecia como erro no console. Limpamos o
    // estado local mesmo que a chamada ao Supabase falhe.
    try {
      const supabase = await getSupabase()
      // Mesmo se o servidor recusar (403), o SDK limpa a sessão local.
      await supabase.auth.signOut({ scope: 'local' })
    } catch {
      /* ignore: a limpeza local abaixo garante o logout */
    }
    setStatus('anonymous')
    setSession(null)
    setMe(null)
    setAuthError(null)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const switchCompany = useCallback(async (id: string) => {
    setActiveCompanyId(id)
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      status,
      session,
      me,
      activeCompanyId,
      authError,
      clearAuthError,
      login,
      signOut,
      switchCompany,
    }),
    [status, session, me, activeCompanyId, authError, clearAuthError, login, signOut, switchCompany],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>')
  return ctx
}