import type { Punch, PunchType, TimesheetDay } from '../types'
import {
  PUNCH_ORDER,
  approvalBadge,
  dayStatusBadge,
  dayKeyOf,
  fmtMin,
  fmtTimeBR,
  formatDayLabel,
  punchLabel,
} from '../lib/utils'
import { CalendarIcon, ClockIcon } from './icons'

// *MARCACOES DO DIA + SEMANA*

interface Props {
  punches: Punch[]
  week: TimesheetDay[]
  loading: boolean
}

function Row({ p }: { p: Punch }) {
  const badge = approvalBadge(p.approval_status)
  return (
    <li className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-0">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-900">
        <ClockIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-800">{punchLabel(p.p_type)}</p>
        <p className="truncate text-xs text-slate-400">
          {p.latitude ? `Localização registrada` : 'Sem localização'}
        </p>
      </div>
      <span className="text-sm font-bold tabular-nums text-slate-900">{fmtTimeBR(p.occurred_at)}</span>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${badge.cls}`}>{badge.label}</span>
    </li>
  )
}

export default function PunchLists({ punches, week, loading }: Props) {
  const todayKey = dayKeyOf(new Date().toISOString())
  const today = punches
    .filter((p) => dayKeyOf(p.occurred_at) === todayKey)
    .sort((a, b) => rank(a.p_type) - rank(b.p_type))

  function rank(t: string): number {
    const idx = PUNCH_ORDER.indexOf(t as PunchType)
    return idx === -1 ? 99 : idx
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2 print:hidden">
      {/* Hoje */}
      <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm shadow-blue-950/5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-950/5 text-blue-950">
              <ClockIcon className="h-4 w-4" />
            </span>
            Batidas de hoje
          </h3>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-500">
            {today.length}
          </span>
        </div>
        {today.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            {loading ? 'Carregando…' : 'Nenhuma batida registrada hoje ainda.'}
          </p>
        ) : (
          <ul>{today.map((p) => <Row key={p.id} p={p} />)}</ul>
        )}
      </section>

      {/* Semana */}
      <section className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm shadow-blue-950/5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-950/5 text-blue-950">
              <CalendarIcon className="h-4 w-4" />
            </span>
            Espelho da semana
          </h3>
        </div>
        {week.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            {loading ? 'Carregando…' : 'Sem dados da semana.'}
          </p>
        ) : (
          <ul>
            {week.map((d) => {
              const badge = dayStatusBadge(d)
              return (
                <li key={d.date} className="flex items-center gap-3 border-b border-slate-100 py-2.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold capitalize text-slate-800">
                      {formatDayLabel(d.date, d.weekday)}
                    </p>
                    <p className="text-xs text-slate-400">
                      {d.punches} batidas · {fmtMin(d.expected_min)} previsto
                    </p>
                  </div>
                  <span className="text-sm font-bold tabular-nums text-slate-900">{fmtMin(d.worked_min)}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ring-1 ${badge.cls}`}>
                    {badge.label}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}