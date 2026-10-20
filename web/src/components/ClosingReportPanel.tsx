import { useCallback, useEffect, useState } from 'react'
import type { AdminCompany, MonthlyReport, TeamMember } from '../types'
import { api, ApiError } from '../lib/api'
import { COMPANY_ADMIN_ROLES, PLATFORM_ADMIN_ROLES, fmtMin, fmtSignedMin } from '../lib/utils'
import { dayStatusBadge } from '../lib/utils'
import { FileIcon, JsonIcon, PdfIcon } from './icons'

// *RELATÓRIO DE FECHAMENTO DE PONTO*
// Gera o fechamento mensal em PDF (conferência/impressão) e JSON (integração
// com a folha do RH). Exige selecionar mês/ano ANTES de gerar.
//
// Hierarquia de acesso (validada também no backend):
//   - Funcionário      -> só o próprio mês
//   - Gerente          -> a própria equipe (subordinados diretos)
//   - Administrador/RH -> toda a empresa, com filtro por CNPJ

interface Props {
  role: string
}

function monthOptions(): { value: string; label: string }[] {
  // Últimos 18 meses, do mais recente para o mais antigo.
  const out: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
    out.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) })
  }
  return out
}

const selectCls =
  'h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

export default function ClosingReportPanel({ role }: Props) {
  const isManager = role !== 'employee'
  const isAdmin = COMPANY_ADMIN_ROLES.has(role)
  const isPlatform = PLATFORM_ADMIN_ROLES.has(role)

  const months = monthOptions()
  const [month, setMonth] = useState(months[0].value)
  const [selected, setSelected] = useState('all') // 'all' | 'self' | user_id
  const [cnpj, setCnpj] = useState('')
  const [members, setMembers] = useState<TeamMember[]>([])
  const [companies, setCompanies] = useState<AdminCompany[]>([])
  const [report, setReport] = useState<MonthlyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState<'pdf' | 'json' | 'mte' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Equipe: gerente/admin escolhem um colaborador específico.
  useEffect(() => {
    if (!isManager) {
      setMembers([])
      return
    }
    void api
      .team()
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [isManager])

  // Admin de plataforma: lista de empresas para filtrar por CNPJ.
  useEffect(() => {
    if (!isPlatform) {
      setCompanies([])
      return
    }
    void api
      .adminCompanies()
      .then(setCompanies)
      .catch(() => setCompanies([]))
  }, [isPlatform])

  const generate = useCallback(async () => {
    if (!month) return
    setLoading(true)
    setError(null)
    try {
      // Prévia (JSON) reaproveitando o mesmo endpoint de download via blob não
      // é ideal; buscamos os dados pelo próprio relatório para exibir na tela.
      const res = await api.monthlyReportPreview({
        month,
        user_id: isManager && selected !== 'all' && selected !== 'self' ? selected : undefined,
        cnpj: isPlatform && cnpj ? cnpj : undefined,
      })
      setReport(res)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao gerar o relatório')
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [month, isManager, isPlatform, selected, cnpj])

  // Escopo de UM colaborador? O espelho MTE (Anexo II) só existe por empregado.
  const singleUserId = isManager
    ? selected !== 'all' && selected !== 'self'
      ? selected
      : selected === 'self'
        ? undefined // 'Eu' -> backend usa o próprio do token
        : null // 'Tudo' -> sem empregado único
    : undefined
  const canMte = singleUserId !== null

  const download = async (format: 'pdf' | 'json', mte = false) => {
    setDownloading(mte ? 'mte' : format)
    setError(null)
    try {
      await api.monthlyReportDownload({
        month,
        format,
        user_id: isManager && selected !== 'all' && selected !== 'self' ? selected : undefined,
        cnpj: isPlatform && cnpj ? cnpj : undefined,
        mte,
      })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao baixar o arquivo')
    } finally {
      setDownloading(null)
    }
  }

  const totals = report?.totals

  return (
    <section
      id="closing-report-card"
      className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5">
        <h2 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-950/5 text-blue-950">
            <FileIcon className="h-4 w-4" />
          </span>
          Relatório de Fechamento
        </h2>
        {report && (
          <span className="rounded-full bg-blue-950/5 px-3 py-1 text-xs font-bold text-blue-950">
            {report.count} colaborador(es)
          </span>
        )}
      </div>

      {/* Seletor de mês/ano + escopo + botões de exportação */}
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Mês de referência
          </label>
          <select value={month} onChange={(e) => setMonth(e.target.value)} className={selectCls + ' w-full'}>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {isManager ? (
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Colaborador
            </label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} className={selectCls + ' w-full'}>
              <option value="all">{isAdmin ? 'Toda a empresa' : 'Minha equipe'}</option>
              <option value="self">Eu</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name ?? m.id}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Escopo
            </label>
            <input readOnly value="Meu próprio relatório" className={selectCls + ' w-full text-slate-500'} />
          </div>
        )}

        {isPlatform ? (
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Empresa (CNPJ)
            </label>
            <select value={cnpj} onChange={(e) => setCnpj(e.target.value)} className={selectCls + ' w-full'}>
              <option value="">Empresa ativa</option>
              {companies.map((c) => (
                <option key={c.id} value={c.cnpj}>
                  {c.nome || c.cnpj}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="hidden lg:block" />
        )}

        <button
          onClick={() => void generate()}
          disabled={loading || !month}
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-blue-950 px-4 text-sm font-bold text-white shadow-sm transition hover:bg-blue-900 disabled:opacity-50"
        >
          <RefreshIconSmall />
          Gerar relatório
        </button>
      </div>

      {/* Exportação */}
      <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
        <button
          onClick={() => void download('pdf')}
          disabled={!month || downloading !== null}
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <PdfIcon className="h-4 w-4" />
          {downloading === 'pdf' ? 'Gerando PDF…' : 'Baixar PDF'}
        </button>
        <button
          onClick={() => void download('json')}
          disabled={!month || downloading !== null}
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <JsonIcon className="h-4 w-4" />
          {downloading === 'json' ? 'Gerando JSON…' : 'Baixar JSON (RH)'}
        </button>
        <button
          onClick={() => void download('json', true)}
          disabled={!month || downloading !== null || !canMte}
          title={
            canMte
              ? 'Modelo oficial Anexo II (Portaria 1510) para um empregado'
              : 'Selecione UM colaborador para exportar o espelho oficial MTE'
          }
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-4 text-sm font-bold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
        >
          <JsonIcon className="h-4 w-4" />
          {downloading === 'mte' ? 'Gerando espelho…' : 'Espelho MTE (1 empregado)'}
        </button>
        <span className="text-xs text-slate-400">
          O PDF é para conferência/impressão; o JSON integra direto com a folha do RH. O
          “Espelho MTE” segue o Anexo II da Portaria 1510 e exige selecionar um único empregado.
        </span>
      </div>

      {error && (
        <div className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {/* Prévia na tela */}
      <div className="px-5 pb-5">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">Gerando relatório…</p>
        ) : !report ? (
          <p className="py-8 text-center text-sm text-slate-400">
            Selecione o mês e clique em “Gerar relatório”.
          </p>
        ) : report.employees.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">Nenhum colaborador no escopo selecionado.</p>
        ) : (
          <div className="space-y-6">
            {totals && (
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Metric label="Previsto" value={fmtMin(totals.expected_min)} />
                <Metric label="Trabalhado" value={fmtMin(totals.worked_min)} />
                <Metric
                  label="Saldo"
                  value={fmtSignedMin(totals.balance_min)}
                  tone={totals.balance_min < 0 ? 'bad' : totals.balance_min > 0 ? 'good' : 'neutral'}
                />
                <Metric label="Faltas justificadas" value={String(totals.absences_justified ?? 0)} />
                <Metric
                  label="Faltas p/ desconto"
                  value={String(totals.absences_unjustified ?? 0)}
                  tone={(totals.absences_unjustified ?? 0) > 0 ? 'bad' : 'neutral'}
                />
              </div>
            )}

            {report.employees.map((emp) => (
              <div key={emp.user_id} className="overflow-hidden rounded-xl border border-slate-100">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
                  <span className="font-bold text-slate-800">{emp.full_name || emp.user_id}</span>
                  <span className="text-xs font-medium text-slate-500">{emp.role}</span>
                  <span className="ml-auto flex flex-wrap gap-2 text-xs font-semibold">
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-emerald-700 ring-1 ring-emerald-600/15">
                      {emp.summary.days_worked} dia(s) trabalhado(s)
                    </span>
                    <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-amber-700 ring-1 ring-amber-600/15">
                      {emp.summary.absences_justified} falta(s) justificada(s)
                    </span>
                    <span className="rounded-full bg-rose-50 px-2.5 py-0.5 text-rose-700 ring-1 ring-rose-600/15">
                      {emp.summary.absences_unjustified} falta(s) p/ desconto
                    </span>
                  </span>
                </div>
                {/* Cabeçalho contratual (Anexo II) */}
                <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 text-xs text-slate-600">
                  <span>CPF: <b>{emp.cadastro?.cpf || '—'}</b></span>
                  <span>PIS: <b>{emp.cadastro?.pis || '—'}</b></span>
                  <span>Cargo: <b>{emp.cadastro?.cargo || '—'}</b></span>
                  <span>CTPS: <b>{emp.cadastro?.ctps || '—'}</b></span>
                  <span>Admissão: <b>{emp.cadastro?.data_admissao || '—'}</b></span>
                  <span>
                    Escala: <b>{emp.escala_trabalho || '—'}</b> (CH {emp.codigo_ch || '—'})
                    {emp.jornada_prevista && (
                      <>
                        {' '}
                        · {emp.jornada_prevista.entrada}–{emp.jornada_prevista.saida} · int.{' '}
                        {emp.jornada_prevista.inicio_intervalo}–{emp.jornada_prevista.fim_intervalo}
                      </>
                    )}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[64rem] text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-2 font-semibold">Dia</th>
                        <th className="px-3 py-2 font-semibold">Status</th>
                        <th className="px-3 py-2 font-semibold">Marcações</th>
                        <th className="px-3 py-2 font-semibold">Entrada</th>
                        <th className="px-3 py-2 font-semibold">Iní./Fim int.</th>
                        <th className="px-3 py-2 font-semibold">Saída</th>
                        <th className="px-3 py-2 text-right font-semibold">Extra</th>
                        <th className="px-3 py-2 font-semibold">Tratamentos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {emp.days.map((d) => {
                        const badge = dayStatusBadge(d)
                        const jr = d.jornada_realizada ?? []
                        const trats = d.tratamentos_efetuados ?? []
                        const show = d.expected_min > 0 || d.worked_min > 0 || d.holiday || (d.marcacoes_eletronicas?.length ?? 0) > 0
                        if (!show) return null
                        return (
                          <tr key={d.date} className="border-b border-slate-50 last:border-0 align-top">
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-700">
                              {d.date.slice(0, 10)}
                              {d.absent_unjustified && (
                                <span className="ml-1.5 text-[10px] font-bold text-rose-600">FALTA</span>
                              )}
                              {d.absent_justified && (
                                <span className="ml-1.5 text-[10px] font-bold text-amber-600">JUSTIF.</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${badge.cls}`}>
                                {badge.label}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-slate-600">
                              {(d.marcacoes_eletronicas ?? []).join(' ') || '—'}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-slate-700">{jr[0] || '—'}</td>
                            <td className="px-3 py-2 tabular-nums text-slate-700">
                              {jr[1] || '—'}/{jr[2] || '—'}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-slate-700">{jr[3] || '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-emerald-600">
                              {fmtSignedMin(d.overtime_min)}
                            </td>
                            <td className="px-3 py-2 text-xs text-slate-600">
                              {trats.length === 0 ? (
                                '—'
                              ) : (
                                <ul className="space-y-0.5">
                                  {trats.map((t, i) => (
                                    <li key={i}>
                                      <span className="font-mono">{t.horario_original}</span>{' '}
                                      <b className="text-slate-800">{t.ocorrencia}</b> — {t.motivo}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const color = tone === 'bad' ? 'text-rose-600' : tone === 'good' ? 'text-emerald-600' : 'text-slate-900'
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-lg font-extrabold tabular-nums ${color}`}>{value}</p>
    </div>
  )
}

function RefreshIconSmall() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}
