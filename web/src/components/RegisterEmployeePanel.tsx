import { useEffect, useMemo, useState } from 'react'
import type { CompanyOption, EscalaTipo } from '../types'
import { api, ApiError } from '../lib/api'
import { PLATFORM_ADMIN_ROLES } from '../lib/utils'
import { BuildingIcon, UserPlusIcon } from './icons'

// *CADASTRAR FUNCIONÁRIO*
// Formulário transacional (auth + profiles + user_companies + escalas).
// Regras:
//   - Só Administrador/RH e Gestor veem esta tela.
//   - Gestor: empresa travada na dele; manager_id = o próprio gestor.
//   - Admin (tela global): escolhe qualquer empresa cadastrada.
//   - Admin (drill-down): veio do painel de uma loja -> empresa herdada e
//     o campo de empresa some (company_id vem do contexto da página).
//   - Senha provisória digitada pelo gestor; troca no 1º login.

interface Props {
  role: string
  /** Empresa ativa do usuário (para travar o select do gestor). */
  activeCompanyId?: string | null
  /** Drill-down: empresa herdada do painel da loja (esconde o select). */
  lockedCompanyId?: string | null
  /** Rótulo amigável da empresa herdada (ex.: nome fantasia). */
  lockedCompanyLabel?: string | null
}

const ESCOLHAS_ESCALA: { value: EscalaTipo; label: string; hint: string }[] = [
  { value: 'padrao', label: 'Padrão (5x2 · seg a sex, 8h)', hint: 'Segunda a sexta, 8h/dia (480 min).' },
  { value: '12x36', label: '12x36 (plantão de 12h)', hint: '12h de plantão + 36h de descanso (660 min efetivos).' },
  { value: 'personalizada', label: 'Personalizada', hint: 'Você define os dias da semana e a carga diária.' },
]

const inputCls =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50 disabled:bg-slate-100 disabled:text-slate-500'
const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500'

function maskCPF(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11)
  return d
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
}

function maskPIS(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 11) // 000.00000.00-0
  const p1 = d.slice(0, 3)
  const p2 = d.slice(3, 8)
  const p3 = d.slice(8, 10)
  const p4 = d.slice(10, 11)
  let out = p1
  if (p2) out += '.' + p2
  if (p3) out += '.' + p3
  if (p4) out += '-' + p4
  return out
}

export default function RegisterEmployeePanel({
  role,
  activeCompanyId,
  lockedCompanyId,
  lockedCompanyLabel,
}: Props) {
  const isPlatform = PLATFORM_ADMIN_ROLES.has(role)
  const isManagerOnly = role === 'manager'
  // Empresa herdada do drill-down (Admin dentro de uma loja) ou do gestor.
  const inheritedCompany = lockedCompanyId || (isManagerOnly ? activeCompanyId : null)
  const companyLocked = Boolean(inheritedCompany)

  const [companies, setCompanies] = useState<CompanyOption[]>([])
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    role: 'employee' as 'employee' | 'manager',
    company_id: '',
    cpf: '',
    pis: '',
    ctps: '',
    cargo: '',
    data_admissao: '',
    escala_tipo: 'padrao' as EscalaTipo,
    ancora: '',
    expected_min: 480,
    work_days: [1, 2, 3, 4, 5] as number[],
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Empresas disponíveis (Admin: todas; Gestor: só a dele).
  // No drill-down (empresa herdada) nem carregamos a lista — o campo some.
  useEffect(() => {
    if (inheritedCompany) {
      setForm((f) => ({ ...f, company_id: inheritedCompany }))
      return
    }
    void api
      .companyOptions()
      .then((list) => {
        setCompanies(list)
        const fallback = activeCompanyId || list[0]?.id
        setForm((f) => ({ ...f, company_id: f.company_id || fallback || '' }))
      })
      .catch(() => setCompanies([]))
  }, [inheritedCompany, activeCompanyId])

  const selectedCompany = useMemo(
    () => companies.find((c) => c.id === form.company_id) || null,
    [companies, form.company_id],
  )
  const companyLabel = lockedCompanyLabel || selectedCompany?.nome || selectedCompany?.cnpj || ''

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const toggleDay = (d: number) =>
    setForm((f) => ({
      ...f,
      work_days: f.work_days.includes(d) ? f.work_days.filter((x) => x !== d) : [...f.work_days, d].sort(),
    }))

  const submit = async () => {
    setError(null)
    setSuccess(null)
    // Validações amigáveis (o backend reforça todas).
    if (form.full_name.trim().length < 2) return setError('Informe o nome completo.')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return setError('E-mail inválido.')
    if (form.password.length < 8) return setError('A senha provisória deve ter ao menos 8 caracteres.')
    if (!form.company_id) return setError('Selecione a empresa/loja.')
    const cpfDigits = form.cpf.replace(/\D/g, '')
    if (cpfDigits && cpfDigits.length !== 11) return setError('CPF deve ter 11 dígitos (ou deixe em branco).')
    if (form.escala_tipo === 'personalizada' && form.work_days.length === 0)
      return setError('Escala personalizada exige ao menos um dia da semana.')

    setSaving(true)
    try {
      await api.createEmployee({
        full_name: form.full_name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        role: form.role,
        company_id: form.company_id,
        cpf: cpfDigits || undefined,
        pis: form.pis.replace(/\D/g, '') || undefined,
        ctps: form.ctps.trim() || undefined,
        cargo: form.cargo.trim() || undefined,
        data_admissao: form.data_admissao || undefined,
        escala_tipo: form.escala_tipo,
        ancora: form.ancora || undefined,
        expected_min: form.expected_min,
        work_days: form.escala_tipo === 'personalizada' ? form.work_days : undefined,
      })
      setSuccess(`✓ ${form.full_name.trim()} cadastrado(a) com sucesso. Entregue a senha provisória; será trocada no 1º login.`)
      setForm((f) => ({
        ...f,
        full_name: '',
        email: '',
        password: '',
        cpf: '',
        pis: '',
        ctps: '',
        cargo: '',
        data_admissao: '',
      }))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao cadastrar funcionário.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      id="register-employee-card"
      className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm shadow-blue-950/5"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5">
        <h2 className="flex items-center gap-2 font-bold tracking-tight text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-950/5 text-blue-950">
            <UserPlusIcon className="h-4 w-4" />
          </span>
          Cadastrar funcionário
        </h2>
        <span className="rounded-full bg-blue-950/5 px-3 py-1 text-xs font-bold text-blue-950">
          {lockedCompanyId
            ? companyLabel || 'Loja'
            : isPlatform
              ? 'Acesso total'
              : isManagerOnly
                ? 'Minha loja'
                : 'Minha empresa'}
        </span>
      </div>

      <div className="grid gap-4 p-5 sm:grid-cols-2">
        {/* Identificação */}
        <div className="sm:col-span-2">
          <label className={labelCls}>Nome completo *</label>
          <input
            value={form.full_name}
            onChange={(e) => set('full_name', e.target.value)}
            className={inputCls}
            placeholder="Ex.: Maria da Silva"
            autoComplete="off"
          />
        </div>

        <div>
          <label className={labelCls}>E-mail (login) *</label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            className={inputCls}
            placeholder="maria@empresa.com.br"
            autoComplete="off"
          />
        </div>

        <div>
          <label className={labelCls}>Senha provisória * (mín. 8)</label>
          <input
            type="text"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            className={inputCls}
            placeholder="Ex.: Trocar@123"
            autoComplete="off"
          />
        </div>

        <div>
          <label className={labelCls}>CPF (opcional)</label>
          <input
            value={form.cpf}
            onChange={(e) => set('cpf', maskCPF(e.target.value))}
            className={inputCls}
            placeholder="000.000.000-00"
            inputMode="numeric"
          />
        </div>

        <div>
          <label className={labelCls}>PIS/NIS (opcional)</label>
          <input
            value={form.pis}
            onChange={(e) => set('pis', maskPIS(e.target.value))}
            className={inputCls}
            placeholder="000.00000.00-0"
            inputMode="numeric"
          />
        </div>

        <div>
          <label className={labelCls}>Cargo (opcional)</label>
          <input
            value={form.cargo}
            onChange={(e) => set('cargo', e.target.value)}
            className={inputCls}
            placeholder="Ex.: Balconista"
          />
        </div>

        <div>
          <label className={labelCls}>CTPS (opcional)</label>
          <input
            value={form.ctps}
            onChange={(e) => set('ctps', e.target.value)}
            className={inputCls}
            placeholder="Ex.: 1234567 Série 001-SP"
          />
        </div>

        <div>
          <label className={labelCls}>Data de admissão (opcional)</label>
          <input
            type="date"
            value={form.data_admissao}
            onChange={(e) => set('data_admissao', e.target.value)}
            className={inputCls}
          />
        </div>

        <div>
          <label className={labelCls}>Perfil (nível de acesso) *</label>
          <select
            value={form.role}
            onChange={(e) => set('role', e.target.value as 'employee' | 'manager')}
            className={inputCls}
          >
            <option value="employee">Funcionário</option>
            <option value="manager">Gestor/Gerente</option>
          </select>
        </div>

        <div>
          <label className={labelCls}>Empresa/Loja *</label>
          {companyLocked ? (
            <>
              <div className={`${inputCls} flex items-center gap-2 disabled:bg-slate-100 disabled:text-slate-500`}>
                <BuildingIcon className="h-4 w-4 text-slate-400" />
                <span className="truncate font-semibold text-slate-700">
                  {companyLabel || 'Empresa selecionada'}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {lockedCompanyId
                  ? 'Herdada da loja selecionada (não editável aqui).'
                  : 'Travada na sua loja (gestor cadastra só para a própria).'}
              </p>
            </>
          ) : (
            <select
              value={form.company_id}
              onChange={(e) => set('company_id', e.target.value)}
              className={inputCls}
            >
              {companies.length === 0 && <option value="">—</option>}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome || c.cnpj}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Escala inicial */}
        <div>
          <label className={labelCls}>Escala de trabalho inicial *</label>
          <select
            value={form.escala_tipo}
            onChange={(e) => set('escala_tipo', e.target.value as EscalaTipo)}
            className={inputCls}
          >
            {ESCOLHAS_ESCALA.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400">
            {ESCOLHAS_ESCALA.find((o) => o.value === form.escala_tipo)?.hint}
          </p>
        </div>

        <div>
          <label className={labelCls}>Início da escala (vigência)</label>
          <input
            type="date"
            value={form.ancora}
            onChange={(e) => set('ancora', e.target.value)}
            className={inputCls}
          />
          <p className="mt-1 text-xs text-slate-400">
            No 12x36, esta data é a âncora (um dia de plantão). Vazio = hoje.
          </p>
        </div>

        {form.escala_tipo !== 'padrao' && (
          <div>
            <label className={labelCls}>
              Carga diária (min) — {Math.floor(form.expected_min / 60)}h{String(form.expected_min % 60).padStart(2, '0')}
            </label>
            <input
              type="number"
              min={0}
              max={1440}
              value={form.expected_min}
              onChange={(e) => set('expected_min', Number(e.target.value))}
              className={inputCls}
            />
            <p className="mt-1 text-xs text-slate-400">12x36 costuma ser 660 min (12h − 1h de almoço).</p>
          </div>
        )}

        {form.escala_tipo === 'personalizada' && (
          <div className="sm:col-span-2">
            <label className={labelCls}>Dias trabalhados</label>
            <div className="flex flex-wrap gap-1.5">
              {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d, i) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className={`h-9 rounded-lg border px-3 text-xs font-bold transition ${
                    form.work_days.includes(i)
                      ? 'border-blue-950 bg-blue-950 text-white'
                      : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mx-5 mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm font-medium text-emerald-700">
          {success}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 px-5 pb-5">
        <button
          onClick={() => void submit()}
          disabled={saving}
          className="flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-950 px-5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-900 disabled:opacity-50"
        >
          <UserPlusIcon className="h-4 w-4" />
          {saving ? 'Cadastrando…' : 'Cadastrar funcionário'}
        </button>
        {companyLocked ? (
          <span className="text-xs text-slate-400">
            Será vinculado(a) a <b>{companyLabel || 'esta loja'}</b>
            {isManagerOnly ? ' (você como gestor).' : '.'}
          </span>
        ) : selectedCompany ? (
          <span className="text-xs text-slate-400">
            Será vinculado(a) a <b>{selectedCompany.nome || selectedCompany.cnpj}</b>.
          </span>
        ) : null}
      </div>
    </section>
  )
}
