import { useCallback, useEffect, useState } from 'react'
import type { AdminCompany, AdminTeamMember, AuditLog, Punch } from '../types'
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
  ArrowLeftIcon,
  BuildingIcon,
  CalendarIcon,
  CheckIcon,
  FileIcon,
  MapPinIcon,
  PowerIcon,
  RefreshIcon,
  UserCheckIcon,
  UserPlusIcon,
  UsersIcon,
  UserXIcon,
  XIcon,
} from './icons'
import RegisterEmployeePanel from './RegisterEmployeePanel'
import ConfirmStatusModal from './ConfirmStatusModal'
import { useAuth } from '../state/AuthContext'

// *PAINEL DA LOJA (drill-down do Admin)*
// O Admin clica numa empresa no dashboard e entra aqui. Abas:
//   Colaboradores | Cadastrar Usuário/Funcionário | Marcações | Auditoria
// O cadastro de funcionário NÃO pede a empresa: ela é herdada deste painel
// (company_id vem do estado da página), garantindo que o usuário nasça
// exatamente neste CNPJ.

type Tab = 'equipe' | 'cadastrar' | 'pontos' | 'auditoria'

interface Props {
  company: AdminCompany
  onBack: () => void
}

const input =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

const acaoLabel: Record<string, string> = {
  insert: 'Inclusão',
  update: 'Alteração',
  approve: 'Aprovação',
  reject: 'Recusa',
  delete: 'Exclusão',
}

function enderecoLinha(c: AdminCompany): string {
  const rua = [c.logradouro, c.numero].filter(Boolean).join(', ')
  const partes = [rua, c.bairro, [c.cidade, c.uf].filter(Boolean).join('/')]
    .filter((p) => p && p.trim() && p !== '/')
    .join(' — ')
  return c.endereco || partes || '—'
}

export default function CompanyPanel({ company, onBack }: Props) {
  const { me } = useAuth()
  const [tab, setTab] = useState<Tab>('equipe')
  const [team, setTeam] = useState<AdminTeamMember[]>([])
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [punches, setPunches] = useState<Punch[]>([])
  const [selectedUser, setSelectedUser] = useState<string>('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [loadingTeam, setLoadingTeam] = useState(true)
  const [loadingPunches, setLoadingPunches] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Status da empresa (soft delete) — controlado pelo pai via callback opcional.
  const [companyAtiva, setCompanyAtiva] = useState(company.ativa !== false)
  const [companyStatusOpen, setCompanyStatusOpen] = useState(false)
  // Status de funcionário (soft delete).
  const [empTarget, setEmpTarget] = useState<AdminTeamMember | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  useEffect(() => {
    setCompanyAtiva(company.ativa !== false)
  }, [company.id, company.ativa])

  const loadTeam = useCallback(async () => {
    setLoadingTeam(true)
    setError(null)
    try {
      const [t, l] = await Promise.all([api.adminTeam(company.id), api.adminLogs(company.id)])
      setTeam(t.team)
      setLogs(l)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar a loja')
    } finally {
      setLoadingTeam(false)
    }
  }, [company.id])

  useEffect(() => {
    setTeam([])
    setLogs([])
    setPunches([])
    setSelectedUser('')
    setTab('equipe')
    void loadTeam()
  }, [loadTeam, company.id])

  const reloadPunches = useCallback(async () => {
    if (!selectedUser) return
    setLoadingPunches(true)
    setError(null)
    try {
      const list = await api.adminPunches(company.id, {
        user_id: selectedUser || undefined,
        start: start || undefined,
        end: end || undefined,
      })
      setPunches(list)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar marcações')
    } finally {
      setLoadingPunches(false)
    }
  }, [company.id, selectedUser, start, end])

  useEffect(() => {
    if (tab === 'pontos' && selectedUser) void reloadPunches()
  }, [tab, reloadPunches, selectedUser])

  const runAction = async (p: Punch, fn: () => Promise<unknown>) => {
    if (busyId !== null) return
    setBusyId(p.id)
    setError(null)
    try {
      await fn()
      await reloadPunches()
      void loadTeam()
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
    void runAction(p, () => api.punchApprove(p.id, 'approved', j))
  }
  const reject = (p: Punch) => {
    const j = askJustification('Recusar marcação')
    if (j === null) return
    void runAction(p, () => api.punchApprove(p.id, 'rejected', j))
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

  // --- Soft delete: status da empresa ---
  const confirmCompanyStatus = async () => {
    const novoAtivo = !companyAtiva
    setStatusBusy(true)
    setStatusError(null)
    try {
      const res = await api.adminCompanyStatus(company.id, novoAtivo, true)
      setCompanyAtiva(res.empresa?.ativa !== false)
      setCompanyStatusOpen(false)
      void loadTeam()
    } catch (e) {
      setStatusError(e instanceof ApiError ? e.message : 'Falha ao alterar o status da empresa')
    } finally {
      setStatusBusy(false)
    }
  }

  // --- Soft delete: status do funcionário ---
  const confirmEmployeeStatus = async () => {
    if (!empTarget) return
    const novoAtivo = empTarget.ativo === false
    setStatusBusy(true)
    setStatusError(null)
    try {
      await api.adminEmployeeStatus(empTarget.id, novoAtivo)
      setTeam((prev) => prev.map((m) => (m.id === empTarget.id ? { ...m, ativo: novoAtivo } : m)))
      setEmpTarget(null)
    } catch (e) {
      setStatusError(e instanceof ApiError ? e.message : 'Falha ao alterar o status do funcionário')
    } finally {
      setStatusBusy(false)
    }
  }

  const selectedMember = team.find((m) => m.id === selectedUser)
  const todayPunchesOfMember = punches.filter(
    (p) => dayKeyOf(p.occurred_at) === dayKeyOf(new Date().toISOString()),
  )

  const tabs: { id: Tab; label: string; icon: typeof UsersIcon }[] = [
    { id: 'equipe', label: 'Colaboradores', icon: UsersIcon },
    { id: 'cadastrar', label: 'Cadastrar Usuário/Funcionário', icon: UserPlusIcon },
    { id: 'pontos', label: 'Marcações', icon: CalendarIcon },
    { id: 'auditoria', label: 'Auditoria', icon: FileIcon },
  ]

  return (
    <div className="space-y-5">
      {/* Voltar + cabeçalho da loja */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onBack}
          className="flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Voltar às empresas
        </button>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5">
        <div className="flex flex-wrap items-start gap-4 border-b border-slate-100 p-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-950 to-blue-800 text-amber-300 shadow-md shadow-blue-950/20">
            <BuildingIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold tracking-tight text-slate-900">
              {company.nome_fantasia || company.nome || 'Empresa'}
            </h2>
            {company.nome_fantasia && company.nome && (
              <p className="truncate text-sm text-slate-500">{company.nome}</p>
            )}
            <p className="mt-1 font-mono text-sm font-bold text-blue-950">
              {formatCNPJ14(company.cnpj)}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
              <MapPinIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{enderecoLinha(company)}</span>
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
              !companyAtiva
                ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
                : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
            }`}
          >
            {!companyAtiva ? 'Inativa' : 'Ativa'}
          </span>
          <button
            onClick={() => {
              setStatusError(null)
              setCompanyStatusOpen(true)
            }}
            className={`flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-bold shadow-sm transition ${
              !companyAtiva
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
            }`}
          >
            <PowerIcon className="h-4 w-4" />
            {!companyAtiva ? 'Ativar empresa' : 'Desativar empresa'}
          </button>
        </div>

        {/* Abas */}
        <div className="flex flex-wrap gap-1 border-b border-slate-100 px-3 pt-3">
          {tabs.map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex h-10 items-center gap-2 rounded-t-xl border-b-2 px-3 text-xs font-bold transition sm:text-sm ${
                  active
                    ? 'border-blue-950 text-blue-950'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            )
          })}
        </div>

        {error && (
          <div className="mx-5 mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
            {error}
          </div>
        )}

        <div className="p-5">
          {/* --- Aba: Colaboradores --- */}
          {tab === 'equipe' && (
            <>
              <div className="mb-3 flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Colaboradores deste CNPJ
                </p>
                <span className="rounded-full bg-blue-950/5 px-2.5 py-0.5 text-[11px] font-bold text-blue-950">
                  {team.length}
                </span>
                <button
                  onClick={() => void loadTeam()}
                  className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-bold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                >
                  <RefreshIcon className="h-3.5 w-3.5" />
                  Atualizar
                </button>
              </div>
              {loadingTeam ? (
                <p className="py-6 text-center text-sm text-slate-400">Carregando colaboradores…</p>
              ) : team.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center">
                  <p className="text-sm text-slate-400">Nenhum colaborador atrelado a este CNPJ.</p>
                  <button
                    onClick={() => setTab('cadastrar')}
                    className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-xs font-bold text-white transition hover:bg-blue-700"
                  >
                    <UserPlusIcon className="h-4 w-4" />
                    Cadastrar o primeiro
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50/70 text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-2.5 font-semibold">Colaborador</th>
                        <th className="px-3 py-2.5 font-semibold">Perfil</th>
                        <th className="px-3 py-2.5 font-semibold">E-mail</th>
                        <th className="px-3 py-2.5 font-semibold">Status</th>
                        <th className="px-3 py-2.5 text-right font-semibold">Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.map((m) => {
                        const inativo = m.ativo === false
                        const isSelf = me?.id === m.id
                        const canManage = !isSelf
                        return (
                        <tr
                          key={m.id}
                          className={`border-b border-slate-50 last:border-0 hover:bg-slate-50/50 ${
                            inativo ? 'bg-rose-50/30' : ''
                          }`}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <span
                                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                                  inativo ? 'bg-rose-100 text-rose-700' : 'bg-blue-950/10 text-blue-950'
                                }`}
                              >
                                {avatarInitials(m.full_name, m.email)}
                              </span>
                              <span
                                className={`font-semibold ${
                                  inativo ? 'text-slate-400 line-through' : 'text-slate-800'
                                }`}
                              >
                                {m.full_name ?? '—'}
                                {isSelf && <span className="ml-1 text-xs font-normal text-slate-400">(você)</span>}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-slate-600">{roleLabel(m.role)}</td>
                          <td className="px-3 py-2.5 text-slate-500">{m.email || '—'}</td>
                          <td className="px-3 py-2.5">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                                inativo
                                  ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
                                  : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                              }`}
                            >
                              {inativo ? 'Inativo' : 'Ativo'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => {
                                  setSelectedUser(m.id)
                                  setStart('')
                                  setEnd('')
                                  setTab('pontos')
                                }}
                                className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                              >
                                Ver marcações
                              </button>
                              {canManage && (
                                <button
                                  onClick={() => {
                                    setStatusError(null)
                                    setEmpTarget(m)
                                  }}
                                  title={inativo ? 'Reativar funcionário' : 'Desativar funcionário'}
                                  className={`flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-bold transition ${
                                    inativo
                                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                      : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                  }`}
                                >
                                  {inativo ? (
                                    <UserCheckIcon className="h-3.5 w-3.5" />
                                  ) : (
                                    <UserXIcon className="h-3.5 w-3.5" />
                                  )}
                                  {inativo ? 'Ativar' : 'Desativar'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* --- Aba: Cadastrar Usuário/Funcionário (empresa herdada) --- */}
          {tab === 'cadastrar' && me && (
            <RegisterEmployeePanel
              role={me.role}
              activeCompanyId={me.company_id}
              lockedCompanyId={company.id}
              lockedCompanyLabel={company.nome_fantasia || company.nome || formatCNPJ14(company.cnpj)}
            />
          )}

          {/* --- Aba: Marcações --- */}
          {tab === 'pontos' && (
            <>
              {team.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {team.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setSelectedUser(m.id)
                        setPunches([])
                        setStart('')
                        setEnd('')
                      }}
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                        selectedUser === m.id
                          ? 'border-blue-950 bg-blue-950 text-white'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {m.full_name ?? '—'}
                    </button>
                  ))}
                </div>
              )}

              {!selectedUser ? (
                <p className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
                  Selecione um colaborador para ver as marcações.
                </p>
              ) : (
                <>
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

                  {loadingPunches ? (
                    <p className="py-6 text-center text-sm text-slate-400">Carregando marcações…</p>
                  ) : punches.length === 0 ? (
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
                                      className="h-8 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
                                    >
                                      Horário
                                    </button>
                                    <button
                                      onClick={() => editNote(p)}
                                      disabled={busyId !== null}
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
                </>
              )}
            </>
          )}

          {/* --- Aba: Auditoria --- */}
          {tab === 'auditoria' && (
            <>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <FileIcon className="h-3.5 w-3.5" />
                Histórico de Auditoria (log)
              </p>
              {loadingTeam ? (
                <p className="py-4 text-center text-sm text-slate-400">Carregando logs…</p>
              ) : logs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400">
                  Nenhuma alteração registrada ainda. As alterações feitas aqui geram log com quem, por quê e quando.
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
                          <td className="px-3 py-2.5 text-slate-600">{roleLabel(l.alterado_por_role ?? '')}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{l.usuario_alterado_nome || '—'}</td>
                          <td className="max-w-[18rem] px-3 py-2.5 text-slate-600">{l.justificativa || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Modal: ativar/desativar EMPRESA (com cascata) */}
      {companyStatusOpen && (
        <ConfirmStatusModal
          title={companyAtiva ? 'Desativar empresa' : 'Reativar empresa'}
          keyword={company.nome_fantasia || company.nome || formatCNPJ14(company.cnpj)}
          tone={companyAtiva ? 'destructive' : 'safe'}
          confirmLabel={companyAtiva ? 'Desativar empresa' : 'Reativar empresa'}
          busy={statusBusy}
          error={statusError}
          onClose={() => {
            if (!statusBusy) setCompanyStatusOpen(false)
          }}
          onConfirm={() => void confirmCompanyStatus()}
          consequences={
            companyAtiva
              ? [
                  'TODOS os funcionários desta empresa serão inativados (em cascata).',
                  'Nenhum deles conseguirá logar nem registrar ponto.',
                  'A empresa sai das operações, mas o histórico continua guardado.',
                ]
              : [
                  'Os funcionários inativados por causa desta empresa voltam a ficar ativos.',
                  'Quem já estava inativo por conta própria continua inativo.',
                  'Eles poderão logar e registrar ponto novamente.',
                ]
          }
        />
      )}

      {/* Modal: ativar/desativar FUNCIONÁRIO */}
      {empTarget && (
        <ConfirmStatusModal
          title={empTarget.ativo === false ? 'Reativar funcionário' : 'Desativar funcionário'}
          keyword={empTarget.full_name || empTarget.email || 'DESATIVAR'}
          tone={empTarget.ativo === false ? 'safe' : 'destructive'}
          confirmLabel={empTarget.ativo === false ? 'Reativar funcionário' : 'Desativar funcionário'}
          busy={statusBusy}
          error={statusError}
          onClose={() => {
            if (!statusBusy) setEmpTarget(null)
          }}
          onConfirm={() => void confirmEmployeeStatus()}
          consequences={
            empTarget.ativo === false
              ? [
                  'O funcionário volta a poder logar no aplicativo.',
                  'Poderá registrar ponto normalmente novamente.',
                ]
              : [
                  'O funcionário perde o acesso: não consegue mais logar (bloqueio no Auth).',
                  'O registro de ponto dele fica bloqueado.',
                  'Os pontos já registrados são PRESERVADOS para o histórico/legislação.',
                ]
          }
        />
      )}
    </div>
  )
}
