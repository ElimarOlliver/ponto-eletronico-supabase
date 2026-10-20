import { useState, type FormEvent } from 'react'
import { useAuth } from '../state/AuthContext'
import { api } from '../lib/api'
import { EyeIcon } from './icons'

// *LOGIN*
// E-mail/senha (tenant resolvido no backend). Fluxo de redefinição
// via /api/auth/forgot-password (sempre 200, anti-enumeração).

export default function LoginCard() {
  const { login, authError, clearAuthError } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [forgotMsg, setForgotMsg] = useState<string | null>(null)

  const onLogin = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !email.trim() || !password) return
    setBusy(true)
    try {
      await login(email.trim(), password)
    } finally {
      setBusy(false)
    }
  }

  const onForgot = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !email.trim()) return
    setBusy(true)
    setForgotMsg(null)
    try {
      const detail = await api.forgotPassword(email.trim())
      setForgotMsg(
        detail && !detail.toLowerCase().includes('enviado')
          ? detail
          : 'Se o e-mail estiver cadastrado, enviamos um link de redefinição.',
      )
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'h-11 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-950 focus:ring-2 focus:ring-amber-400/50'

  return (
    <div className="flex min-h-[calc(100vh-12rem)] items-center justify-center">
      <div className="w-full max-w-md">
        <div className="overflow-hidden rounded-3xl border border-white/60 bg-white/80 shadow-2xl shadow-blue-950/10 backdrop-blur-xl">
          <div className="bg-gradient-to-br from-blue-950 via-blue-900 to-blue-950 px-8 pb-10 pt-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-white/10 ring-1 ring-white/15">
              <img src="/img/logo-pollar.png" alt="Pollar" className="h-full w-full object-contain" />
            </div>
            <h1 className="text-xl font-extrabold tracking-tight text-white">Ponto Eletrônico</h1>
            <p className="mt-1 text-sm font-medium text-blue-200">
              Acesse com seu e-mail corporativo
            </p>
          </div>

          <div className="px-6 pb-7 pt-6 sm:px-8">
            {authError && (
              <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm font-medium text-rose-700">
                {authError}
              </div>
            )}

            {mode === 'login' ? (
              <form onSubmit={(e) => void onLogin(e)} className="space-y-4">
                <div>
                  <label htmlFor="email" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    E-mail
                  </label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      clearAuthError()
                    }}
                    placeholder="voce@empresa.com.br"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor="password" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Senha
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPass ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value)
                        clearAuthError()
                      }}
                      placeholder="••••••••"
                      className={inputCls + ' pr-10'}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                      aria-label={showPass ? 'Ocultar senha' : 'Mostrar senha'}
                    >
                      <EyeIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="h-11 w-full rounded-xl bg-amber-400 px-4 text-sm font-bold text-blue-950 shadow-lg shadow-amber-400/30 transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/60 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? 'Entrando…' : 'Entrar'}
                </button>

                <p className="text-center text-sm text-slate-500">
                  Esqueceu a senha?{' '}
                  <button
                    type="button"
                    onClick={() => setMode('forgot')}
                    className="font-semibold text-blue-900 underline-offset-2 hover:underline"
                  >
                    Redefinir
                  </button>
                </p>
              </form>
            ) : (
              <form onSubmit={(e) => void onForgot(e)} className="space-y-4">
                <p className="text-sm leading-relaxed text-slate-600">
                  Informe o e-mail cadastrado e enviaremos um link de redefinição de senha.
                </p>
                <div>
                  <label htmlFor="forgot-email" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    E-mail
                  </label>
                  <input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="voce@empresa.com.br"
                    className={inputCls}
                  />
                </div>
                {forgotMsg && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm font-medium text-emerald-700">
                    {forgotMsg}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="h-11 w-full rounded-xl bg-blue-950 px-4 text-sm font-bold text-white shadow-lg shadow-blue-950/25 transition hover:bg-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-950/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? 'Enviando…' : 'Enviar link'}
                </button>
                <p className="text-center text-sm text-slate-500">
                  <button
                    type="button"
                    onClick={() => setMode('login')}
                    className="font-semibold text-blue-900 underline-offset-2 hover:underline"
                  >
                    Voltar ao login
                  </button>
                </p>
              </form>
            )}
          </div>
        </div>

        <p className="mt-5 text-center text-xs font-medium text-slate-400">
          Horários registrados conforme a legislação trabalhista.
        </p>
      </div>
    </div>
  )
}