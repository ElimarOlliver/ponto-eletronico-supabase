import type { Me, TimesheetDay } from '../types'

// *FORMATAÇÕES E HELPERS DO DESIGN SYSTEM*
// Mesma lógica do frontend anterior, agora com tipagem estrita.

export const PUNCH_LABELS: Record<string, string> = {
  in: 'Entrada',
  break_start: 'Saída Almoço / Intervalo',
  break_end: 'Retorno Almoço / Intervalo',
  out: 'Saída Final',
}

export const PUNCH_ORDER = ['in', 'break_start', 'break_end', 'out'] as const

export const punchLabel = (t: string): string => PUNCH_LABELS[t] ?? t

export const MANAGER_ROLES = new Set(['manager', 'company_admin', 'system_admin', 'admin'])
export const COMPANY_ADMIN_ROLES = new Set(['company_admin', 'system_admin', 'admin'])
// Perfil "Administrador (Programador/Suporte)": Painel Admin com todas as empresas.
export const PLATFORM_ADMIN_ROLES = new Set(['system_admin', 'admin'])

const TZ = 'America/Sao_Paulo'

/** Minutos → "8h00" */
export function fmtMin(min: number | null | undefined): string {
  const m = Math.max(0, Math.round(Number(min) || 0))
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0')
}

/** Minutos com sinal → "-0h30" / "+1h15" */
export function fmtSignedMin(min: number | null | undefined): string {
  const m = Math.round(Number(min) || 0)
  const sign = m < 0 ? '-' : '+'
  const abs = Math.abs(m)
  return sign + Math.floor(abs / 60) + 'h' + String(abs % 60).padStart(2, '0')
}

const fmtBRFull = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' })
export function fmtBR(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : fmtBRFull.format(d)
}

const fmtBRTime = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
export function fmtTimeBR(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : fmtBRTime.format(d)
}

/** ISO yyyy-mm-dd de um timestamp, no fuso do backend (Brasil). */
const fmtDayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
export function dayKeyOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return fmtDayKey.format(d)
}

const fmtWeekday = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' })
const fmtMD = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' })

const WEEKDAYS_LONG = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado']

/** Rótulo "seg, 01/01" para um dia do espelho. */
export function formatDayLabel(dateISO: string, weekday?: number): string {
  const d = new Date(dateISO + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return dateISO
  const wd = typeof weekday === 'number' ? WEEKDAYS_LONG[weekday] ?? fmtWeekday.format(d) : fmtWeekday.format(d)
  return `${wd}, ${fmtMD.format(d)}`
}

export function weekdayLongBR(weekday: number): string {
  return WEEKDAYS_LONG[weekday] ?? ''
}

export function isoDay(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

export function todayISO(): string {
  return isoDay(new Date())
}

export function mondayOfWeek(): string {
  const now = new Date()
  const dow = (now.getDay() + 6) % 7 // 0 = segunda
  const mon = new Date(now)
  mon.setDate(now.getDate() - dow)
  return isoDay(mon)
}

export function firstDayOfMonthISO(): string {
  const n = new Date()
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01'
}

export function formatCNPJ14(digits: string): string {
  const d = String(digits || '').replace(/\D/g, '')
  if (d.length !== 14) return d
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
}

export function avatarInitials(name?: string | null, email?: string | null): string {
  const source = name || email || '?'
  const parts = source.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase() || '?'
}

export function companyLabel(m: Me): string {
  return m.company_nome || m.company?.nome || m.company?.cnpj || m.company_cnpj || 'Empresa'
}

export function companyActiveLabel(m: Me): string {
  const active = m.company_ativa ?? m.company?.ativa
  return active === false ? 'Inativo' : 'Ativo'
}

export function roleLabel(role: string): string {
  switch (role) {
    case 'employee':
      return 'Operador'
    case 'manager':
      return 'Gestor'
    case 'company_admin':
      return 'Administrador'
    case 'system_admin':
      return 'Admin do Sistema'
    case 'admin':
      return 'Admin'
    default:
      return role
  }
}

/** Chip de status de um dia do espelho. */
export function dayStatusBadge(day: TimesheetDay): { label: string; cls: string } {
  if (day.pending) return { label: 'Pendente', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' }
  switch (day.status) {
    case 'ok':
      return { label: 'OK', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' }
    case 'incomplete':
      return { label: 'Incompleto', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' }
    case 'absent':
      return { label: 'Falta', cls: 'bg-rose-50 text-rose-700 ring-rose-600/20' }
    case 'holiday':
      return { label: 'Feriado', cls: 'bg-violet-50 text-violet-700 ring-violet-600/20' }
    case 'weekend':
      return { label: 'Folga', cls: 'bg-slate-100 text-slate-600 ring-slate-500/10' }
    default:
      return { label: day.status, cls: 'bg-slate-100 text-slate-600 ring-slate-500/10' }
  }
}

/** Chip de status de aprovação de uma batida. */
export function approvalBadge(status?: string): { label: string; cls: string } {
  if (!status || status === 'pending')
    return { label: 'Pendente', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' }
  if (status === 'approved') return { label: 'Aprovado', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' }
  if (status === 'rejected') return { label: 'Recusado', cls: 'bg-rose-50 text-rose-700 ring-rose-600/20' }
  return { label: status, cls: 'bg-slate-100 text-slate-600 ring-slate-500/10' }
}

/** Status geral do dia de trabalho do colaborador (hero). */
export function daySummary(punchesOfToday: { p_type: string }[]): {
  label: string
  cls: string
  completed: boolean
} {
  const has = (t: string) => punchesOfToday.some((p) => p.p_type === t)
  const inDone = has('in')
  const canFinish = inDone && !has('out')
  if (inDone && has('out') && has('break_start') && has('break_end'))
    return { label: 'Dia concluído', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', completed: true }
  if (canFinish)
    return { label: 'Em andamento', cls: 'bg-blue-50 text-blue-700 ring-blue-600/20', completed: false }
  if (inDone) return { label: 'Em andamento', cls: 'bg-blue-50 text-blue-700 ring-blue-600/20', completed: false }
  return { label: 'Não iniciado', cls: 'bg-slate-100 text-slate-600 ring-slate-500/10', completed: false }
}

/** Próximo botão sugerido conforme as batidas de hoje. */
export function suggestedPunch(punchesOfToday: { p_type: string }[]): string {
  const has = (t: string) => punchesOfToday.some((p) => p.p_type === t)
  if (!has('in')) return 'in'
  if (!has('break_start')) return 'break_start'
  if (!has('break_end')) return 'break_end'
  if (!has('out')) return 'out'
  return 'in'
}

const fmtClock = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtClockDate = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'long', day: '2-digit', month: 'long' })

export function clockParts(now: Date): { time: string; date: string } {
  return { time: fmtClock.format(now), date: fmtClockDate.format(now) }
}