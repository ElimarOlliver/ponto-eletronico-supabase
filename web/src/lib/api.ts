import type {
  AdminCompany,
  AdminTeamResponse,
  AuditLog,
  Closing,
  Holiday,
  Me,
  Punch,
  TeamMember,
  Timesheet,
} from '../types'
import { getSupabase } from './supabase'

// *COMPANY SWITCH*
// Empresa ativa controlada pelo AuthContext; aplicada como header X-Company-ID
// (mesmo contrato do backend multi-empresa).

let activeCompanyId: string | null = null

export function setActiveCompanyId(id: string | null) {
  activeCompanyId = id
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

type AuthInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
}

async function authFetch(path: string, init: AuthInit = {}): Promise<Response> {
  const supabase = await getSupabase()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new ApiError('Sessão expirada. Faça login novamente.', 401)
  }
  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + session.access_token,
  }
  if (activeCompanyId) headers['X-Company-ID'] = activeCompanyId
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  return res
}

export async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as Record<string, unknown>
    const m = (j.detail ?? j.message ?? j.error ?? j.msg ?? j.error_description) as string | undefined
    if (m) return String(m)
    return `Erro (${res.status})`
  } catch {
    return `Erro (${res.status})`
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) throw new ApiError(await readError(res), res.status)
  return (await res.json()) as T
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const u = new URL(path, window.location.origin)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== '') u.searchParams.set(k, String(v))
  }
  return u.pathname + u.search
}

export const api = {
  me: () => authFetch('/api/me').then(handle<Me>),

  myPunches: (limit = 100) =>
    authFetch(withQuery('/api/my-punches', { limit })).then(handle<Punch[]>),

  clock: (body: { type: string; lat: number | null; lon: number | null; accuracy: number | null }) =>
    authFetch('/api/clock', { method: 'POST', body }).then(handle<{ ok: boolean; punch?: Punch }>),

  team: () => authFetch('/api/team').then(handle<TeamMember[]>),

  teamPunches: (userId: string, start?: string, end?: string, limit = 200) =>
    authFetch(
      withQuery('/api/team-punches', { user_id: userId, start, end, limit }),
    ).then(handle<Punch[]>),

  punchApprove: (id: number, decision: string, justificativa?: string) =>
    authFetch('/api/punch-approve', {
      method: 'POST',
      body: { id, decision, justificativa: justificativa ?? null },
    }).then(handle<{ ok: boolean }>),

  punchUpdate: (
    id: number,
    patch: { note?: string | null; occurred_at?: string },
    justificativa?: string,
  ) =>
    authFetch('/api/punch-update', {
      method: 'POST',
      body: { id, ...patch, justificativa: justificativa ?? null },
    }).then(handle<{ ok: boolean }>),

  // --- Painel Admin (Programador/Suporte) ---
  adminCompanies: () => authFetch('/api/admin/companies').then(handle<AdminCompany[]>),

  adminTeam: (companyId: string) =>
    authFetch(`/api/admin/companies/${companyId}/team`).then(handle<AdminTeamResponse>),

  adminPunches: (
    companyId: string,
    opts: { user_id?: string; start?: string; end?: string; limit?: number },
  ) =>
    authFetch(
      withQuery(`/api/admin/companies/${companyId}/punches`, {
        user_id: opts.user_id,
        start: opts.start,
        end: opts.end,
        limit: opts.limit ?? 50,
      }),
    ).then(handle<Punch[]>),

  adminLogs: (companyId: string) =>
    authFetch(`/api/admin/companies/${companyId}/logs`).then(handle<AuditLog[]>),

  timesheet: (opts: { user_id?: string; start: string; end: string; expected_daily_min?: number }) =>
    authFetch(
      withQuery('/api/timesheet', {
        user_id: opts.user_id,
        start: opts.start,
        end: opts.end,
        expected_daily_min: opts.expected_daily_min ?? 480,
      }),
    ).then(handle<Timesheet>),

  holidays: (year: number) =>
    authFetch(withQuery('/api/holidays', { year })).then(handle<Holiday[]>),

  holidaysSync: (year: number) =>
    authFetch(withQuery('/api/holidays/sync', { year }), { method: 'POST' }).then(
      handle<{ created?: number; updated?: number }>,
    ),

  holidayCreate: (body: { date: string; name: string; kind: 'company' }) =>
    authFetch('/api/holidays', { method: 'POST', body }).then(handle<Holiday>),

  closings: () => authFetch('/api/payroll/closings').then(handle<Closing[]>),

  payrollClose: (body: { period_start: string; period_end: string }) =>
    authFetch('/api/payroll/close', { method: 'POST', body }).then(handle<{ ok: boolean }>),

  forgotPassword: async (email: string): Promise<string | null> => {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return j.detail ? String(j.detail) : null
  },
}