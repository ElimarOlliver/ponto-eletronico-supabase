import { useCallback, useEffect, useState } from 'react'
import type { Closing, TeamMember, Timesheet } from '../types'
import { api, ApiError } from '../lib/api'
import {
  COMPANY_ADMIN_ROLES,
  fmtMin,
  fmtSignedMin,
  firstDayOfMonthISO,
  formatDayLabel,
  todayISO,
} from '../lib/utils'
import { dayStatusBadge } from '../lib/utils'
import { ClockIcon, DownloadIcon, FileIcon, PrintIcon } from './icons'

// *FOLHA DE PONTO (espelho)*
// Espelho do próprio colaborador ou de outro (gestor), com totais,
// impressão e fechamento de período (admin).

interface Props {
  role: string
}

const inputTime =
  'h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'
const inputNum =
  'h-10 w-24 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

export default function PayrollPanel({ role }: Props) {
  const isManager = role !== 'employee'
  const isAdmin = COMPANY_ADMIN_ROLES.has(role)

  const [members, setMembers] = useState<TeamMember[]>([])
  const [selected, setSelected] = useState<string>('self')
  const [start, setStart] = useState(firstDayOfMonthISO())
  const [end, setEnd] = useState(todayISO())
  const [expected, setExpected] = useState(480)
  const [sheet, setSheet] = useState<Timesheet | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closings, setClosings] = useState<Closing[]>([])
  const [closeStart, setCloseStart] = useState('')
  const [closeEnd, setCloseEnd] = useState('')
  const [busy, setBusy] = useState(false)

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const ts = await api.timesheet({
        user_id: selected !== 'self' ? selected : undefined,
        start,
        end,
        expected_daily_min: expected,
      })
      setSheet(ts)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao gerar o espelho')
    } finally {
      setLoading(false)
    }
  }, [selected, start, end, expected])

  useEffect(() => {
    if (!isManager) return
    void api
      .team()
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [isManager])

  useEffect(() => {
    if (!role || role === 'employee') return
    void api
      .closings()
      .then(setClosings)
      .catch(() => setClosings([]))
  }, [role])

  useEffect(() => {
    void generate()
  }, [generate])

  const closePeriod = async () => {
    if (busy || !closeStart || !closeEnd) return
    if (closeEnd <= closeStart) {
      alert('O fim do período precisa ser depois do início.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.payrollClose({ period_start: closeStart, period_end: closeEnd })
      setClosings(await api.closings())
      setCloseStart('')
      setCloseEnd('')
      alert('Período fechado com sucesso.')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao fechar o período')
    } finally {
      setBusy(false)
    }
  }

  const totals = sheet?.totals
  const len = sheet?.days.length ?? 0
  const combos = sheet
    ? sheet.days.reduce(
        (acc, d) => {
          acc.ok += d.status === 'ok' ? 1 : 0
          acc.incomplete += d.status === 'incomplete' ? 1 : 0
          acc.absent += d.status === 'absent' ? 1 : 0
          return acc
        },
        { ok: 0, incomplete: 0, absent: 0 },
      )
    : { ok: 0, incomplete: 0, absent: 0 }

  return (
    <section id="payroll-card" className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5">
        <h2 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-950/5 text-blue-950">
            <FileIcon className="h-4 w-4" />
          </span>
          Folha de Ponto
        </h2>
        {sheet && (
          <span className="rounded-full bg-blue-950/5 px-3 py-1 text-xs font-bold text-blue-950">
            {len} dia(s)
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2 print:hidden">
          <button
            onClick={() => void generate()}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-blue-950 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-blue-900"
          >
            <RefreshIconSmall />
            Gerar espelho
          </button>
          <button
            onClick={() => window.print()}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
          >
            <PrintIcon className="h-4 w-4" />
            Imprimir
          </button>
        </div>
      </div>

      <div className="grid gap-3 p-5 print:hidden sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto] lg:items-end">
        {isManager && (
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Colaborador
            </label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className={inputTime + ' w-full'}>
              <option value="self">Eu</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name ?? m.id}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Período
          </label>
          <div className="flex gap-2">
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputTime} aria-label="Início" />
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputTime} aria-label="Fim" />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Jornada/dia (min)
          </label>
          <input
            type="number"
            min="0"
            step="5"
            value={expected}
            onChange={(e) => setExpected(Math.max(0, Number(e.target.value) || 0))}
            className={inputNum}
            aria-label="Minutos esperados por dia"
          />
        </div>
      </div>

      {error && (
        <div className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700 print:hidden">
          {error}
        </div>
      )}

      {isAdmin && (
        <div className="mx-5 mb-4 rounded-xl border border-dashed border-blue-950/20 bg-blue-950/5 p-4 print:hidden">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Fechamento de período
          </p>
          <div className="grid gap-2 sm:grid-cols-[auto_auto_auto] sm:items-end">
            <input type="date" value={closeStart} onChange={(e) => setCloseStart(e.target.value)} className={inputTime} aria-label="Início do fechamento" />
            <input type="date" value={closeEnd} onChange={(e) => setCloseEnd(e.target.value)} className={inputTime} aria-label="Fim do fechamento" />
            <button
              onClick={() => void closePeriod()}
              disabled={busy}
              className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-amber-400 px-4 text-sm font-bold text-blue-950 shadow-sm transition hover:bg-amber-300 disabled:opacity-50"
            >
              <DownloadIcon className="h-4 w-4" />
              Fechar período
            </button>
          </div>
        </div>
      )}

      <div className="px-5 pb-5">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">Gerando espelho…</p>
        ) : !sheet ? (
          <p className="py-8 text-center text-sm text-slate-400">Clique em “Gerar espelho”.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2.5 font-semibold">Dia</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Previsto</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Trabalhado</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Extra</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Déficit</th>
                </tr>
              </thead>
              <tbody>
                {sheet.days.map((d, i) => {
                  const badge = dayStatusBadge(d)
                  return (
                    <tr key={d.date} className={`border-b border-slate-50 last:border-0 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
                      <td className="whitespace-nowrap px-3 py-2.5 font-semibold capitalize text-slate-800">
                        {formatDayLabel(d.date, d.weekday)}
                        {d.holiday && <span className="ml-1.5 text-[10px] font-bold text-violet-600">Feriado</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{fmtMin(d.expected_min)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">{fmtMin(d.worked_min)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600">{fmtSignedMin(d.overtime_min)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{fmtSignedMin(-d.deficit_min)}</td>
                    </tr>
                  )
                })}
              </tbody>
              {totals && (
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                    <td className="px-3 py-3" colSpan={2}>
                      Totais · {combos.ok} OK · {combos.incomplete} incompletos · {combos.absent} faltas
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtMin(totals.expected_min)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtMin(totals.worked_min)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-emerald-600">{fmtSignedMin(totals.overtime_min)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-rose-600">{fmtSignedMin(-totals.deficit_min)}</td>
                  </tr>
                  <tr className="bg-blue-950/[0.04]">
                    <td className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500" colSpan={5}>
                      Saldo do período
                    </td>
                    <td className={`px-3 py-2.5 text-right text-base font-extrabold tabular-nums ${totals.balance_min < 0 ? 'text-rose-600' : totals.balance_min > 0 ? 'text-emerald-600' : 'text-slate-900'}`}>
                      {fmtSignedMin(totals.balance_min)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}

        {closings.length > 0 && (
          <div className="mt-5">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 print:hidden">
              <ClockIcon className="h-3.5 w-3.5" />
              Períodos fechados
            </p>
            <div className="flex flex-wrap gap-2 print:hidden">
              {closings.map((c) => (
                <span
                  key={String(c.id)}
                  className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-600/15"
                >
                  {c.period_start.slice(0, 10)} → {c.period_end.slice(0, 10)} · {c.status}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function RefreshIconSmall() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}