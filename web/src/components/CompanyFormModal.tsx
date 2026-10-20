import { useState } from 'react'
import type { AdminCompany, CreateCompanyPayload } from '../types'
import { api, ApiError } from '../lib/api'
import { StoreIcon, XIcon } from './icons'

// *CADASTRAR EMPRESA (tenant)*
// Modal do Super Admin: CNPJ + Razão Social + Nome Fantasia + endereço
// estruturado. O backend valida CNPJ (dígitos verificadores) e duplicidade
// na RPC criar_empresa (transacional). O endereço também alimenta o texto
// livre 'endereco' usado no Espelho de Ponto (Anexo II).

interface Props {
  onClose: () => void
  onCreated: (company: AdminCompany) => void
}

const inputCls =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'
const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500'

function maskCNPJ(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 14)
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
}

function maskCEP(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 8)
  return d.replace(/^(\d{5})(\d)/, '$1-$2')
}

export default function CompanyFormModal({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<CreateCompanyPayload>({
    cnpj: '',
    nome: '',
    nome_fantasia: '',
    cep: '',
    logradouro: '',
    numero: '',
    bairro: '',
    cidade: '',
    uf: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof CreateCompanyPayload>(k: K, v: CreateCompanyPayload[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const submit = async () => {
    setError(null)
    const cnpjDigits = form.cnpj.replace(/\D/g, '')
    if (cnpjDigits.length !== 14) return setError('CNPJ deve ter 14 dígitos.')
    if (form.nome.trim().length < 2) return setError('Informe a Razão Social.')
    const cepDigits = (form.cep ?? '').replace(/\D/g, '')
    if (cepDigits && cepDigits.length !== 8) return setError('CEP deve ter 8 dígitos (ou deixe em branco).')
    const uf = (form.uf ?? '').replace(/[^A-Za-z]/g, '')
    if (uf && uf.length !== 2) return setError('UF deve ter 2 letras (ou deixe em branco).')

    setSaving(true)
    try {
      const res = await api.adminCreateCompany({
        cnpj: cnpjDigits,
        nome: form.nome.trim(),
        nome_fantasia: form.nome_fantasia?.trim() || undefined,
        cep: cepDigits || undefined,
        logradouro: form.logradouro?.trim() || undefined,
        numero: form.numero?.trim() || undefined,
        bairro: form.bairro?.trim() || undefined,
        cidade: form.cidade?.trim() || undefined,
        uf: uf ? uf.toUpperCase() : undefined,
      })
      onCreated(res.empresa)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao cadastrar empresa.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm print:hidden">
      <div className="my-8 w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-slate-100 p-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-950 text-amber-300">
            <StoreIcon className="h-4 w-4" />
          </span>
          <h2 className="font-bold tracking-tight text-slate-900">Cadastrar Empresa</h2>
          <button
            onClick={onClose}
            className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
            title="Fechar"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div>
            <label className={labelCls}>CNPJ *</label>
            <input
              value={form.cnpj}
              onChange={(e) => set('cnpj', maskCNPJ(e.target.value))}
              className={inputCls}
              placeholder="00.000.000/0000-00"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelCls}>Razão Social *</label>
            <input
              value={form.nome}
              onChange={(e) => set('nome', e.target.value)}
              className={inputCls}
              placeholder="Ex.: Farmácia Por do Sol LTDA"
              autoComplete="off"
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Nome Fantasia</label>
            <input
              value={form.nome_fantasia}
              onChange={(e) => set('nome_fantasia', e.target.value)}
              className={inputCls}
              placeholder="Ex.: Por do Sol 2"
            />
          </div>

          <div className="sm:col-span-2 mt-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <span className="h-px flex-1 bg-slate-100" />
            Endereço completo
            <span className="h-px flex-1 bg-slate-100" />
          </div>

          <div>
            <label className={labelCls}>CEP</label>
            <input
              value={form.cep}
              onChange={(e) => set('cep', maskCEP(e.target.value))}
              className={inputCls}
              placeholder="00000-000"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className={labelCls}>UF</label>
            <input
              value={form.uf}
              onChange={(e) => set('uf', e.target.value.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase())}
              className={inputCls}
              placeholder="DF"
              maxLength={2}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Logradouro</label>
            <input
              value={form.logradouro}
              onChange={(e) => set('logradouro', e.target.value)}
              className={inputCls}
              placeholder="Ex.: Av. Central"
            />
          </div>
          <div>
            <label className={labelCls}>Número</label>
            <input
              value={form.numero}
              onChange={(e) => set('numero', e.target.value)}
              className={inputCls}
              placeholder="Ex.: 100"
            />
          </div>
          <div>
            <label className={labelCls}>Bairro</label>
            <input
              value={form.bairro}
              onChange={(e) => set('bairro', e.target.value)}
              className={inputCls}
              placeholder="Ex.: Centro"
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Cidade</label>
            <input
              value={form.cidade}
              onChange={(e) => set('cidade', e.target.value)}
              className={inputCls}
              placeholder="Ex.: Brasília"
            />
          </div>
        </div>

        {error && (
          <div className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 p-5">
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
          >
            <StoreIcon className="h-4 w-4" />
            {saving ? 'Cadastrando…' : 'Cadastrar Empresa'}
          </button>
          <button
            onClick={onClose}
            className="flex h-10 items-center rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
