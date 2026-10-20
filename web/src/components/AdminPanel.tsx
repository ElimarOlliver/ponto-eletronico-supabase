import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AdminCompany } from '../types'
import { api, ApiError } from '../lib/api'
import { formatCNPJ14 } from '../lib/utils'
import {
  AlertIcon,
  BuildingIcon,
  MapPinIcon,
  PlusIcon,
  PowerIcon,
  RefreshIcon,
  StoreIcon,
  UsersIcon,
} from './icons'
import CompanyFormModal from './CompanyFormModal'
import CompanyPanel from './CompanyPanel'
import ConfirmStatusModal from './ConfirmStatusModal'

// *HOME DO ADMINISTRADOR (Super Admin)*
// O foco do Admin não são funcionários soltos, mas as EMPRESAS (CNPJs).
// Aqui ele vê o catálogo de empresas em cards, cadastra novas empresas e
// entra numa loja (drill-down) para gerenciar colaboradores, marcações e
// auditoria — incluindo cadastrar funcionários NAQUELA empresa.
//
// SOFT DELETE: cada card tem um botão Ativar/Desativar. Desativar uma empresa
// derruba (em cascata) o acesso dos funcionários dela e bloqueia o ponto —
// sempre por meio de um modal de confirmação com digitação de segurança.
//
// Fluxo: Lista de Empresas -> [Cadastrar Empresa] (modal)
//                        \-> clicar num card -> CompanyPanel (abas)

const input =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

type StatusFiltro = 'todas' | 'ativas' | 'inativas'

function enderecoCurto(c: AdminCompany): string {
  const rua = [c.logradouro, c.numero].filter(Boolean).join(', ')
  const partes = [rua, c.bairro, [c.cidade, c.uf].filter(Boolean).join('/')]
    .filter((p) => p && p.trim() && p !== '/')
    .join(' — ')
  return c.endereco || partes || 'Endereço não informado'
}

export default function AdminPanel() {
  const [companies, setCompanies] = useState<AdminCompany[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFiltro, setStatusFiltro] = useState<StatusFiltro>('todas')
  const [showModal, setShowModal] = useState(false)
  const [selected, setSelected] = useState<AdminCompany | null>(null)
  // Modal de confirmação de status da empresa.
  const [statusTarget, setStatusTarget] = useState<AdminCompany | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const loadCompanies = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.adminCompanies()
      setCompanies(list)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao listar empresas')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCompanies()
  }, [loadCompanies])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const digits = q.replace(/\D/g, '')
    return companies.filter((c) => {
      if (statusFiltro === 'ativas' && c.ativa === false) return false
      if (statusFiltro === 'inativas' && c.ativa !== false) return false
      if (!q) return true
      const nome = (c.nome ?? '').toLowerCase()
      const fantasia = (c.nome_fantasia ?? '').toLowerCase()
      const cnpj = (c.cnpj ?? '').replace(/\D/g, '')
      const cidade = (c.cidade ?? '').toLowerCase()
      return (
        nome.includes(q) ||
        fantasia.includes(q) ||
        cidade.includes(q) ||
        (digits.length > 0 && cnpj.includes(digits))
      )
    })
  }, [companies, search, statusFiltro])

  const totalColaboradores = useMemo(
    () =>
      companies.reduce(
        (acc, c) => acc + (typeof c.colaborador_count === 'number' ? c.colaborador_count : 0),
        0,
      ),
    [companies],
  )

  const totalInativas = useMemo(
    () => companies.filter((c) => c.ativa === false).length,
    [companies],
  )

  const onCreated = (company: AdminCompany) => {
    setCompanies((prev) => [company, ...prev.filter((c) => c.id !== company.id)])
    setShowModal(false)
  }

  const confirmStatus = async () => {
    if (!statusTarget) return
    const novoAtivo = statusTarget.ativa === false
    setStatusBusy(true)
    setStatusError(null)
    try {
      const res = await api.adminCompanyStatus(statusTarget.id, novoAtivo, true)
      setCompanies((prev) =>
        prev.map((c) => (c.id === statusTarget.id ? { ...c, ...res.empresa } : c)),
      )
      if (selected?.id === statusTarget.id) {
        setSelected((s) => (s ? { ...s, ativa: novoAtivo } : s))
      }
      setStatusTarget(null)
    } catch (e) {
      setStatusError(e instanceof ApiError ? e.message : 'Falha ao alterar o status da empresa')
    } finally {
      setStatusBusy(false)
    }
  }

  // ---- Drill-down: painel de uma loja ----
  if (selected) {
    return <CompanyPanel company={selected} onBack={() => setSelected(null)} />
  }

  const desativando = statusTarget?.ativa !== false

  return (
    <div className="space-y-5">
      {/* Cabeçalho + estatísticas */}
      <section className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5">
        <div className="flex flex-wrap items-center gap-4 p-5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-950 to-blue-800 text-amber-300 shadow-md shadow-blue-950/20">
            <StoreIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold tracking-tight text-slate-900">Empresas cadastradas</h1>
            <p className="text-sm text-slate-500">
              Selecione uma loja para gerenciar colaboradores, marcações e auditoria.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="flex items-center gap-1.5 rounded-xl bg-blue-950/5 px-3 py-2 text-xs font-bold text-blue-950">
              <BuildingIcon className="h-4 w-4" />
              {companies.length} {companies.length === 1 ? 'empresa' : 'empresas'}
            </span>
            {totalInativas > 0 && (
              <span className="flex items-center gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
                <AlertIcon className="h-4 w-4" />
                {totalInativas} {totalInativas === 1 ? 'inativa' : 'inativas'}
              </span>
            )}
            <span className="flex items-center gap-1.5 rounded-xl bg-blue-950/5 px-3 py-2 text-xs font-bold text-blue-950">
              <UsersIcon className="h-4 w-4" />
              {totalColaboradores} colaboradores
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 p-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${input} sm:max-w-xs`}
            placeholder="Buscar por CNPJ, razão social, fantasia ou cidade…"
            aria-label="Buscar empresa"
          />
          <div className="flex h-10 items-center gap-1 rounded-xl border border-slate-200 bg-white p-1">
            {(['todas', 'ativas', 'inativas'] as StatusFiltro[]).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFiltro(f)}
                className={`h-8 rounded-lg px-3 text-xs font-bold capitalize transition ${
                  statusFiltro === f
                    ? 'bg-blue-950 text-white'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            onClick={() => void loadCompanies()}
            className="flex h-10 items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 text-sm font-bold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
          >
            <RefreshIcon className="h-4 w-4" />
            Atualizar
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700"
          >
            <PlusIcon className="h-4 w-4" />
            Cadastrar Empresa
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      {/* Catálogo em cards */}
      {loading ? (
        <p className="py-12 text-center text-sm text-slate-400">Carregando empresas…</p>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 py-14 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <BuildingIcon className="h-5 w-5" />
          </span>
          <p className="text-sm text-slate-500">
            {companies.length === 0
              ? 'Nenhuma empresa cadastrada ainda.'
              : 'Nenhuma empresa corresponde ao filtro/busca.'}
          </p>
          {companies.length === 0 && (
            <button
              onClick={() => setShowModal(true)}
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-bold text-white transition hover:bg-blue-700"
            >
              <PlusIcon className="h-4 w-4" />
              Cadastrar Empresa
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => {
            const inativa = c.ativa === false
            return (
              <div
                key={c.id}
                className={`group flex flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm shadow-blue-950/5 transition hover:-translate-y-0.5 hover:shadow-md ${
                  inativa ? 'border-rose-200/70 opacity-95' : 'border-slate-200/70 hover:border-blue-200'
                }`}
              >
                <button
                  onClick={() => setSelected(c)}
                  className="flex items-start gap-3 text-left"
                  title="Abrir loja"
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                      inativa
                        ? 'bg-rose-100 text-rose-600'
                        : 'bg-blue-950/5 text-blue-950 group-hover:bg-blue-950 group-hover:text-amber-300'
                    }`}
                  >
                    <BuildingIcon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold tracking-tight text-slate-900">
                      {c.nome_fantasia || c.nome || 'Empresa'}
                    </h3>
                    {c.nome_fantasia && c.nome && (
                      <p className="truncate text-xs text-slate-500">{c.nome}</p>
                    )}
                    <p className="mt-0.5 font-mono text-xs font-bold text-blue-950">
                      {formatCNPJ14(c.cnpj)}
                    </p>
                  </div>
                </button>

                <div className="flex items-center justify-between">
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                      inativa
                        ? 'bg-rose-50 text-rose-700 ring-rose-600/20'
                        : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                    }`}
                  >
                    {inativa ? 'Inativa' : 'Ativa'}
                  </span>
                  <button
                    onClick={() => {
                      setStatusError(null)
                      setStatusTarget(c)
                    }}
                    className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-bold transition ${
                      inativa
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                    }`}
                  >
                    <PowerIcon className="h-3.5 w-3.5" />
                    {inativa ? 'Ativar' : 'Desativar'}
                  </button>
                </div>

                <p className="flex items-start gap-1.5 text-xs text-slate-500">
                  <MapPinIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="line-clamp-2">{enderecoCurto(c)}</span>
                </p>

                <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-3">
                  <span className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                    <UsersIcon className="h-3.5 w-3.5" />
                    {typeof c.colaborador_count === 'number' ? c.colaborador_count : '—'} colaboradores
                  </span>
                  <button
                    onClick={() => setSelected(c)}
                    className="text-xs font-bold text-blue-700 hover:underline"
                  >
                    Abrir loja →
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showModal && (
        <CompanyFormModal onClose={() => setShowModal(false)} onCreated={onCreated} />
      )}

      {statusTarget && (
        <ConfirmStatusModal
          title={desativando ? 'Desativar empresa' : 'Reativar empresa'}
          keyword={statusTarget.nome_fantasia || statusTarget.nome || formatCNPJ14(statusTarget.cnpj)}
          tone={desativando ? 'destructive' : 'safe'}
          confirmLabel={desativando ? 'Desativar empresa' : 'Reativar empresa'}
          busy={statusBusy}
          error={statusError}
          onClose={() => {
            if (!statusBusy) setStatusTarget(null)
          }}
          onConfirm={() => void confirmStatus()}
          consequences={
            desativando
              ? [
                  'TODOS os funcionários desta empresa serão inativados (em cascata).',
                  'Nenhum deles conseguirá logar nem registrar ponto.',
                  'A empresa sai das operações, mas o histórico de pontos continua guardado.',
                ]
              : [
                  'Os funcionários que foram inativados por causa desta empresa voltam a ficar ativos.',
                  'Quem já estava inativo por conta própria continua inativo.',
                  'Eles poderão logar e registrar ponto novamente.',
                ]
          }
        />
      )}
    </div>
  )
}
