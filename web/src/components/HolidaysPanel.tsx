import { useCallback, useEffect, useState } from 'react'
import type { Holiday } from '../types'
import { api, ApiError } from '../lib/api'
import { CalendarIcon, PlusIcon, RefreshIcon } from './icons'

// *FERIADOS*
// Lista nacional (via API pública) + pontos facultativos da empresa.
// Sync BrasilAPI e cadastro local apenas para admin da empresa.

interface Props {
  isAdmin: boolean
}

const input =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

export default function HolidaysPanel({ isAdmin }: Props) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hDate, setHDate] = useState('')
  const [hName, setHName] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.holidays(year)
      setHolidays(list.sort((a, b) => a.h_date.localeCompare(b.h_date)))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar feriados')
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => {
    void reload()
  }, [reload])

  const sync = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.holidaysSync(year)
      setHolidays(
        (await api.holidays(year)).sort((a, b) => a.h_date.localeCompare(b.h_date)),
      )
      alert(`Feriados sincronizados para ${year}.${r.created ? `\n${r.created} criados.` : ''}${r.updated ? `\n${r.updated} atualizados.` : ''}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao sincronizar feriados')
    } finally {
      setBusy(false)
    }
  }

  const addLocal = async () => {
    if (busy || !hDate || !hName.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.holidayCreate({ date: hDate, name: hName.trim(), kind: 'company' })
      setHDate('')
      setHName('')
      setHolidays((await api.holidays(year)).sort((a, b) => a.h_date.localeCompare(b.h_date)))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao cadastrar feriado')
    } finally {
      setBusy(false)
    }
  }

  const national = holidays.filter((h) => h.kind !== 'company')
  const local = holidays.filter((h) => h.kind === 'company')

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5 print:hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5">
        <h2 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-950/5 text-blue-950">
            <CalendarIcon className="h-4 w-4" />
          </span>
          Feriados
        </h2>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500">
          {holidays.length} em {year}
        </span>
      </div>

      <div className="grid gap-3 p-5 sm:grid-cols-[8rem_auto_1fr] sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Ano
          </label>
          <input
            type="number"
            min="2000"
            max="2100"
            value={year}
            onChange={(e) => setYear(Number(e.target.value) || now.getFullYear())}
            className={input}
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void reload()}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-blue-950 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-blue-900"
          >
            <RefreshIcon className="h-4 w-4" />
            Recarregar
          </button>
          {isAdmin && (
            <button
              onClick={() => void sync()}
              disabled={busy}
              className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-blue-950/20 px-4 text-sm font-bold text-blue-950 transition hover:bg-blue-950/5 disabled:opacity-50"
            >
              Sincronizar BrasilAPI
            </button>
          )}
        </div>
        <p className="text-xs font-medium text-slate-400 sm:col-start-3">
          Feriados nacionais vêm da API pública. Pontos facultativos da empresa são cadastrados
          localmente.
        </p>
      </div>

      {error && (
        <div className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {isAdmin && (
        <div className="mx-5 mb-4 grid gap-2 rounded-xl border border-dashed border-blue-950/20 bg-blue-950/5 p-3 sm:grid-cols-[9rem_1fr_auto]">
          <input type="date" value={hDate} onChange={(e) => setHDate(e.target.value)} className={input} aria-label="Data do feriado" />
          <input
            value={hName}
            onChange={(e) => setHName(e.target.value)}
            placeholder="Ex.: Aniversário da empresa"
            className={input}
            aria-label="Nome do feriado"
          />
          <button
            onClick={() => void addLocal()}
            disabled={busy || !hDate || !hName.trim()}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-amber-400 px-4 text-sm font-bold text-blue-950 shadow-sm transition hover:bg-amber-300 disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            Adicionar
          </button>
        </div>
      )}

      <div className="px-5 pb-5">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">Carregando feriados…</p>
        ) : holidays.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">Nenhum feriado para {year}.</p>
        ) : (
          <>
            {local.length > 0 && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Pontos facultativos da empresa
                </p>
                <ul className="overflow-hidden rounded-xl border border-slate-100">
                  {local.map((h) => (
                    <li key={String(h.id ?? h.h_date)} className="flex items-center gap-3 border-b border-slate-50 px-3.5 py-2.5 last:border-0">
                      <span className="w-16 shrink-0 rounded-full bg-violet-50 px-2 py-0.5 text-center text-[10px] font-bold text-violet-700 ring-1 ring-violet-600/15">
                        {h.h_date.slice(8, 10)}/{h.h_date.slice(5, 7)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{h.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Feriados nacionais de {year}
              </p>
              {national.length === 0 ? (
                <p className="text-sm text-slate-400">Nenhum feriado nacional cadastrado.</p>
              ) : (
                <ul className="overflow-hidden rounded-xl border border-slate-100">
                  {national.map((h) => (
                    <li key={String(h.id ?? h.h_date)} className="flex items-center gap-3 border-b border-slate-50 px-3.5 py-2.5 last:border-0">
                      <span className="w-16 shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-center text-[10px] font-bold text-slate-600">
                        {h.h_date.slice(8, 10)}/{h.h_date.slice(5, 7)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{h.name}</span>
                      <span className="text-xs capitalize text-slate-400">{h.kind.replace('_', ' ')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}