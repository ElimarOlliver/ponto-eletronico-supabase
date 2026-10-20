import { useCallback, useEffect, useState } from 'react'
import type { Punch, TeamMember } from '../types'
import { api, ApiError } from '../lib/api'
import { approvalBadge, fmtTimeBR } from '../lib/utils'
import { UsersIcon, MapIcon, RefreshIcon, CheckIcon, XIcon } from './icons'
import PunchMap from './PunchMap'

// *EQUIPE (gestor)*
// Lista, filtro por período, aprovação/recusa e edição de horário/observação
// das marcações dos colaboradores — mesma lógica do backend anterior.

const input =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

export default function TeamPanel() {
  const [members, setMembers] = useState<TeamMember[]>([])
  const [selected, setSelected] = useState<string>('')
  const [punches, setPunches] = useState<Punch[]>([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const reloadTeam = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.team()
      setMembers(list)
      if (list.length > 0) {
        setSelected((prev) => (prev && list.some((m) => m.id === prev) ? prev : list[0].id))
      } else {
        setSelected('')
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar a equipe')
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadPunches = useCallback(async () => {
    if (!selected) {
      setPunches([])
      return
    }
    setError(null)
    try {
      const list = await api.teamPunches(selected, start || undefined, end || undefined)
      setPunches(list)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar marcações')
    }
  }, [selected, start, end])

  useEffect(() => {
    void reloadTeam()
  }, [reloadTeam])

  useEffect(() => {
    void reloadPunches()
  }, [reloadPunches, selected])

  const runAction = async (p: Punch, fn: () => Promise<unknown>) => {
    if (busyId !== null) return
    setBusyId(p.id)
    setError(null)
    try {
      await fn()
      await reloadPunches()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha na operação')
    } finally {
      setBusyId(null)
    }
  }

  const askJustification = (action: string): string | null => {
    const j = prompt(
      `${action} — Justificativa obrigatória (fica gravada no histórico de auditoria):`,
      '',
    )
    if (j === null) return null
    const clean = j.trim()
    if (clean.length < 10) {
      alert('A justificativa é obrigatória (mínimo de 10 caracteres) para registrar a alteração.')
      return null
    }
    return clean.slice(0, 500)
  }

  const approve = (p: Punch) => {
    const j = askJustification('Aprovar marcação')
    if (j === null) return
    runAction(p, () => api.punchApprove(p.id, 'approved', j))
  }
  const reject = (p: Punch) => {
    const j = askJustification('Recusar marcação')
    if (j === null) return
    runAction(p, () => api.punchApprove(p.id, 'rejected', j))
  }

  const editTime = (p: Punch) => {
    const raw = prompt('Novo horário (formato: yyyy-mm-ddThh:mm ou yyyy-mm-dd hh:mm):', p.occurred_at)
    if (!raw) return
    const normalized = raw.replace(' ', 'T')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(normalized)) {
      alert('Formato inválido. Use yyyy-mm-ddThh:mm.')
      return
    }
    const j = askJustification('Alterar horário')
    if (j === null) return
    void runAction(p, () => api.punchUpdate(p.id, { occurred_at: normalized }, j))
  }

  const editNote = (p: Punch) => {
    const note = prompt('Observação (vazio para limpar):', p.note ?? '')
    if (note === null) return
    const j = askJustification('Alterar observação')
    if (j === null) return
    void runAction(p, () => api.punchUpdate(p.id, { note: note.trim() }, j))
  }

  const selectedMember = members.find((m) => m.id === selected)
  const withLocation = punches.filter(
    (p) => typeof p.latitude === 'number' && typeof p.longitude === 'number',
  ).length

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5 print:hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5">
        <h2 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-950/5 text-blue-950">
            <UsersIcon className="h-4 w-4" />
          </span>
          Equipe
        </h2>
        {selectedMember && (
          <span className="rounded-full bg-blue-950/5 px-3 py-1 text-xs font-bold text-blue-950">
            {selectedMember.full_name ?? '—'} · {punches.length} marcações
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
          <MapIcon className="h-3.5 w-3.5" />
          {withLocation} com localização
        </span>
      </div>

      <div className="grid gap-3 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Colaborador
          </label>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className={input}>
            {members.length === 0 && <option value="">Sem colaboradores</option>}
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name ?? m.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Período (opcional)
          </label>
          <div className="grid grid-cols-2 gap-2">
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={input} aria-label="Início" />
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={input} aria-label="Fim" />
          </div>
        </div>
        <button
          onClick={() => void reloadPunches()}
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-blue-950 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-blue-900"
        >
          <RefreshIcon className="h-4 w-4" />
          Atualizar
        </button>
      </div>

      {error && (
        <div className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      <div className="px-5 pb-5">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">Carregando equipe…</p>
        ) : punches.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            Nenhuma marcação encontrada para o período selecionado.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2.5 font-semibold">Horário</th>
                  <th className="px-3 py-2.5 font-semibold">Tipo</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Observação</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Ações</th>
                </tr>
              </thead>
              <tbody>
                {punches.map((p) => {
                  const badge = approvalBadge(p.approval_status)
                  return (
                    <tr key={p.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                      <td className="whitespace-nowrap px-3 py-2.5 font-semibold tabular-nums text-slate-900">
                        {fmtTimeBR(p.occurred_at)}
                      </td>
                      <td className="px-3 py-2.5 capitalize text-slate-700">{p.p_type.replace('_', ' ')}</td>
                      <td className="px-3 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="max-w-[14rem] truncate px-3 py-2.5 text-slate-500">{p.note || '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => void reject(p)}
                            disabled={busyId !== null}
                            title="Recusar"
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                          >
                            <XIcon className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => void approve(p)}
                            disabled={busyId !== null}
                            title="Aprovar"
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-50"
                          >
                            <CheckIcon className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => editTime(p)}
                            disabled={busyId !== null}
                            title="Editar horário"
                            className="h-8 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
                          >
                            Horário
                          </button>
                          <button
                            onClick={() => editNote(p)}
                            disabled={busyId !== null}
                            title="Editar observação"
                            className="h-8 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
                          >
                            Obs
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {withLocation > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Mapa de marcações
            </p>
            <PunchMap punches={punches} />
          </div>
        )}
      </div>
    </section>
  )
}