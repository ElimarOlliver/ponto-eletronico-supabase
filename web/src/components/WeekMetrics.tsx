import type { TimesheetTotals } from '../types'
import { fmtMin, fmtSignedMin } from '../lib/utils'
import { ClockIcon, ZapIcon } from './icons'

// *MÉTRICAS DA SEMANA*
// 3 cards: trabalhadas, extras e saldo/banco (mesmos números do espelho).

interface Props {
  totals: TimesheetTotals | null
  loading: boolean
}

export default function WeekMetrics({ totals, loading }: Props) {
  const worked = totals?.worked_min ?? 0
  const overtime = totals?.overtime_min ?? 0
  const balance = totals?.balance_min ?? 0
  const hasPending = totals?.has_pending ?? false
  const hasIncomplete = totals?.has_incomplete ?? false

  const balanceCls = loading
    ? 'text-slate-400'
    : balance < 0
      ? 'text-rose-600'
      : balance > 0
        ? 'text-emerald-600'
        : 'text-slate-900'

  const cards = [
    {
      label: 'Horas trabalhadas',
      value: fmtMin(worked),
      cls: 'text-slate-900',
      tile: 'from-emerald-500 to-emerald-600',
      title: 'Total trabalhado nesta semana',
    },
    {
      label: 'Horas extras',
      value: fmtMin(overtime),
      cls: 'text-slate-900',
      tile: 'from-amber-400 to-amber-500',
      title: 'Excedente sobre a jornada prevista',
    },
    {
      label: 'Saldo',
      value: fmtSignedMin(balance),
      cls: balanceCls,
      tile: 'from-blue-500 to-blue-600',
      title: 'Saldo (trabalhado − previsto)',
    },
  ]

  return (
    <section className="space-y-3 print:hidden">
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <div
            key={c.label}
            title={c.title}
            className="flex items-center gap-3.5 rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm shadow-blue-950/5"
          >
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${c.tile} text-white shadow-md`}
            >
              {c.label === 'Saldo' ? <ZapIcon className="h-5 w-5" /> : <ClockIcon className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <p className={`truncate text-xl font-bold tabular-nums tracking-tight ${loading ? 'text-slate-400' : c.cls}`}>
                {loading ? '…' : c.value}
              </p>
              <p className="truncate text-xs font-semibold text-slate-500">{c.label}</p>
            </div>
          </div>
        ))}
      </div>

      {(hasPending || hasIncomplete) && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-700">
          {hasPending && hasIncomplete
            ? 'Há marcações pendentes de aprovação e dias incompletos na semana.'
            : hasPending
              ? 'Há marcações pendentes de aprovação nesta semana.'
              : 'Há dias incompletos nesta semana.'}
        </p>
      )}
    </section>
  )
}