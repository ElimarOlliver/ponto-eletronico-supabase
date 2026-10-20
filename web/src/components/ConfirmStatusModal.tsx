import { useMemo, useState } from 'react'
import { AlertIcon, CheckIcon, ShieldIcon, XIcon } from './icons'

// *MODAL DE CONFIRMAÇÃO DE SEGURANÇA (Soft Delete)*
// Mecanismo anti-erro: desativar NUNCA é 1 clique. O usuário precisa DIGITAR
// a palavra-chave (ex.: o nome do funcionário/empresa ou "DESATIVAR") e vê um
// aviso claro das consequências. Reativar é uma ação segura, mas ainda pede
// confirmação simples (sem digitação) para evitar clique duplo acidental.

interface Props {
  title: string
  /** Texto exato que o usuário deve digitar para confirmar. */
  keyword: string
  /** Lista de consequências exibidas no aviso. */
  consequences: string[]
  /** 'destructive' = desativar (vermelho); 'safe' = reativar (verde). */
  tone?: 'destructive' | 'safe'
  confirmLabel: string
  busy?: boolean
  error?: string | null
  onClose: () => void
  onConfirm: () => void
}

export default function ConfirmStatusModal({
  title,
  keyword,
  consequences,
  tone = 'destructive',
  confirmLabel,
  busy = false,
  error = null,
  onClose,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState('')
  const destructive = tone === 'destructive'

  const matches = useMemo(
    () => typed.trim().toLowerCase() === keyword.trim().toLowerCase(),
    [typed, keyword],
  )
  // Reativar (safe) dispensa digitação; desativar exige a palavra-chave.
  const canConfirm = destructive ? matches : true

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm print:hidden">
      <div className="my-10 w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div
          className={`flex items-center gap-3 border-b p-5 ${
            destructive ? 'border-rose-100 bg-rose-50/60' : 'border-emerald-100 bg-emerald-50/60'
          }`}
        >
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              destructive ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'
            }`}
          >
            {destructive ? <AlertIcon className="h-5 w-5" /> : <ShieldIcon className="h-5 w-5" />}
          </span>
          <h2 className="font-bold tracking-tight text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition hover:border-slate-300 hover:bg-white disabled:opacity-50"
            title="Fechar"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {consequences.length > 0 && (
            <div
              className={`rounded-xl border px-3.5 py-3 text-sm ${
                destructive
                  ? 'border-rose-200 bg-rose-50 text-rose-800'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-800'
              }`}
            >
              <p className="mb-1.5 flex items-center gap-1.5 font-bold">
                {destructive ? 'O que vai acontecer:' : 'Ao reativar:'}
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {consequences.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              {destructive && (
                <p className="mt-2 font-semibold">
                  Nada é apagado do banco: o histórico de pontos é preservado.
                </p>
              )}
            </div>
          )}

          {destructive && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Para confirmar, digite <span className="font-mono text-rose-700">{keyword}</span>
              </label>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canConfirm && !busy) onConfirm()
                }}
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none transition focus:border-rose-500 focus:ring-2 focus:ring-rose-400/40"
                placeholder={keyword}
                autoComplete="off"
                spellCheck={false}
              />
              {typed.length > 0 && !matches && (
                <p className="mt-1 text-xs font-medium text-rose-600">
                  O texto não confere. Digite exatamente “{keyword}”.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 p-5">
          <button
            onClick={onConfirm}
            disabled={!canConfirm || busy}
            className={`flex h-10 items-center gap-2 rounded-xl px-5 text-sm font-bold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
              destructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            <CheckIcon className="h-4 w-4" />
            {busy ? 'Processando…' : confirmLabel}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="flex h-10 items-center rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
