import { useCallback, useEffect, useState } from 'react'
import type {
  AdminCompany,
  AdminTeamMember,
  AuditLog,
  Punch,
} from '../types'
import { api, ApiError } from '../lib/api'
import {
  approvalBadge,
  avatarInitials,
  dayKeyOf,
  fmtBR,
  fmtTimeBR,
  formatCNPJ14,
  roleLabel,
} from '../lib/utils'
import {
  BuildingIcon,
  CheckIcon,
  FileIcon,
  RefreshIcon,
  ShieldIcon,
  UsersIcon,
  XIcon,
} from './icons'

// *PAINEL ADMIN (Programador/Suporte)*
// Instituições/Empresas por CNPJ -> árvore de colaboradores -> marcações.
// Toda ação (aprovar/recusar/editar) pede justificativa e gera registro em
// logs_auditoria (Regra de Ouro de legalidade).

const input =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

const acaoLabel: Record<string, string> = {
  insert: 'Inclusão',
  update: 'Alteração',
  approve: 'Aprovação',
  reject: 'Recusa',
  delete: 'Exclusão',
}

export default function AdminPanel() {
  const [companies, setCompanies] = useState<AdminCompany[]>([])
  const [selectedCompany, setSelectedCompany] = useState<string>('')
  const [team, setTeam] = useState<AdminTeamMember[]>([])
  const [selectedUser, setSelectedUser] = useState<string>('')
  const [punches, setPunches] = useState<Punch[]>([])
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const loadCompanies = useCallback(async () => {
    setLoadingCompanies(true)
    setError(null)
    try {
      const list = await api.adminCompanies()
      setCompanies(list)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao listar empresas')
    } finally {
      setLoadingCompanies(false)
    }
  }, [])

  const loadCompanyDetail = useCallback(async (companyId: string) => {
    setLoading(true)
    setError(null)
    setSelectedUser('')
    setPunches([])
    try {
      const [t, l] = await Promise.all([
        api.adminTeam(companyId),
        api.adminLogs(companyId),
      ])
      setTeam(t.team)
      setLogs(l)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar a empresa')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCompanies()
  }, [loadCompanies])

  const reloadPunches = useCallback(async () => {
    if (!selectedCompany) return
    setError(null)
    try {
      const list = await api.adminPunches(selectedCompany, {
        user_id: selectedUser || undefined,
        start: start || undefined,
        end: end || undefined,
      })
      setPunches(list)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar marcações')
    }
  }, [selectedCompany, selectedUser, start, end])

  useEffect(() => {
    if (!selectedUser) return
    void reloadPunches()
  }, [reloadPunches, selectedUser])

  const selectCompany = (id: string) => {
    setSelectedCompany(id)
    void loadCompanyDetail(id)
  }

  const selectMember = (id: string) => {
    setSelectedUser(id)
    setPunches([])
    setStart('')
    setEnd('')
    void reloadPunches()
  }

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
    if (!clean) {
      alert('A justificativa é obrigatória para registrar a alteração.')
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

  const selectedCompanyData = companies.find((c) => c.id === selectedCompany)
  const selectedMember = team.find((m) => m.id === selectedUser)
  const todayPunchesOfMember = punches.filter(
    (p) => dayKeyOf(p.occurred_at) === dayKeyOf(new Date().toISOString()),
  )

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5 print:hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5">
        <h2 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400/90 text-blue-950">
            <ShieldIcon className="h-4 w-4" />
          </span>
          Painel Administrador
        </h2>
        <span className="rounded-full bg-blue-950/5 px-3 py-1 text-xs font-bold text-blue-950">
          {companies.length} instituição{companies.length === 1 ? '' : 'ões'}
        </span>
        <button
          onClick={() => void loadCompanies()}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
        >
          <RefreshIcon className="h-4 w-4" />
          Atualizar
        </button>
      </div>

      {error && (
        <div className="mx-5 mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      <div className="p-5">
        {/* 1) Instituições/Empresas por CNPJ */}
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Instituições / Empresas por CNPJ
        </p>
        {loadingCompanies ? (
          <p className="py-6 text-center text-sm text-slate-400">Carregando empresas…</p>
        ) : companies.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            Nenhuma empresa cadastrada.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {companies.map((c) => {
              const active = c.ativa !== false
              const isSelected = selectedCompany === c.id
              return (
                <button
                  key={c.id}
                  onClick={() => selectCompany(c.id)}
                  className={`group rounded-2xl border p-4 text-left transition ${
                    isSelected
                      ? 'border-blue-950 bg-blue-950 text-white shadow-md'
                      : 'border-slate-200 bg-white hover:border-blue-950/40 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                        isSelected ? 'bg-white/15 text-amber-300' : 'bg-blue-950/5 text-blue-950'
                      }`}
                    >
                      <BuildingIcon className="h-4 w-4" />
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                        active
                          ? isSelected
                            ? 'bg-emerald-400/20 text-emerald-200 ring-emerald-300/30'
                            : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                          : 'bg-rose-50 text-rose-700 ring-rose-600/20'
                      }`}
                    >
                      {active ? 'Ativa' : 'Inativa'}
                    </span>
                  </div>
                  <p
                    className={`mt-3 font-mono text-sm font-bold tracking-tight ${
                      isSelected ? 'text-amber-300' : 'text-blue-950'
                    }`}
                  >
                    {formatCNPJ14(c.cnpj)}
                  </p>
                  <p className={`mt-0.5 truncate text-sm ${isSelected ? 'text-blue-100' : 'text-slate-700'}`}>
                    {c.nome || 'Sem nome'}
                  </p>
                  <p className={`mt-1 text-xs ${isSelected ? 'text-blue-200/70' : 'text-slate-400'}`}>
                    {c.colaborador_count ?? '—'} colaborador
                    {c.colaborador_count === 1 ? '' : 'es'}
                  </p>
                </button>
              )
            })}
          </div>
        )}

        {/* 2) Árvore de colaboradores da empresa selecionada */}
        {selectedCompany && (
          <div className="mt-6">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <UsersIcon className="h-3.5 w-3.5" />
              Colaboradores —{' '}
              {selectedCompanyData?.nome || formatCNPJ14(selectedCompanyData?.cnpj || '')}
            </p>
            {loading ? (
              <p className="py-6 text-center text-sm text-slate-400">Carregando colaboradores…</p>
            ) : team.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-400">
                Nenhum colaborador atrelado a este CNPJ.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {team.map((m) => {
                  const active = selectedUser === m.id
                  return (
                    <button
                      key={m.id}
                      onClick={() => selectMember(m.id)}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition ${
                        active
                          ? 'border-amber-400 bg-amber-400/10 ring-1 ring-amber-400/60'
                          : 'border-slate-200 bg-white hover:border-blue-950/40 hover:bg-slate-50'
                      }`}
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-950/10 text-xs font-bold text-blue-950">
                        {avatarInitials(m.full_name, m.email)}
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-slate-800">
                          {m.full_name ?? '—'}
                        </span>
                        <span className="block text-[11px] text-slate-500">
                          {roleLabel(m.role)}
                          {m.email ? ` · ${m.email}` : ''}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 3) Marcações do colaborador selecionado */}
        {selectedUser && (
          <div className="mt-6">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Marcações — {selectedMember?.full_name ?? 'colaborador'}
              </p>
              {todayPunchesOfMember.length > 0 && (
                <span className="rounded-full bg-blue-950/5 px-2.5 py-0.5 text-[11px] font-bold text-blue-950">
                  {todayPunchesOfMember.length} hoje
                </span>
              )}
            </div>

            <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
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

            {punches.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">
                Nenhuma marcação encontrada para o período.
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
                          <td className="px-3 py-2.5 capitalize text-slate-700">
                            {p.p_type.replace('_', ' ')}
                          </td>
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
          </div>
        )}

        {/* 4) Histórico de auditoria (logs_auditoria / punch_audit) */}
        {selectedCompany && (
          <div className="mt-6">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <FileIcon className="h-3.5 w-3.5" />
              Histórico de Auditoria (log)
            </p>
            {loading ? (
              <p className="py-4 text-center text-sm text-slate-400">Carregando logs…</p>
            ) : logs.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">
                Nenhuma alteração registrada ainda. As alterações feitas aqui geram log com
                quem, por quê e quando.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full min-w-[52rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2.5 font-semibold">Data/hora</th>
                      <th className="px-3 py-2.5 font-semibold">Ação</th>
                      <th className="px-3 py-2.5 font-semibold">Quem alterou</th>
                      <th className="px-3 py-2.5 font-semibold">Permissão</th>
                      <th className="px-3 py-2.5 font-semibold">Colaborador</th>
                      <th className="px-3 py-2.5 font-semibold">Justificativa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l) => (
                      <tr key={l.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-slate-500">
                          {l.created_at ? fmtBR(l.created_at) : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="rounded-full bg-blue-950/5 px-2 py-0.5 text-[10px] font-bold text-blue-950">
                            {acaoLabel[l.acao ?? ''] ?? l.acao ?? '—'}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-800">
                          {l.alterado_por_email || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {roleLabel(l.alterado_por_role ?? '')}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
                          {l.usuario_alterado_nome || '—'}
                        </td>
                        <td className="max-w-[18rem] px-3 py-2.5 text-slate-600">{l.justificativa || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}