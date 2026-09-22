import { useAuth } from '../state/AuthContext'
import { avatarInitials, companyLabel, formatCNPJ14, roleLabel } from '../lib/utils'
import { ClockIcon, LogoutIcon } from './icons'

// *HEADER GLASS*
// Sticky com blur + borda translúcida. À direita: seletor de empresa
// (multi-empresa, sem relogin), avatar do usuário e logout.

export default function Header() {
  const { me, activeCompanyId, companies, switchCompany, signOut } = useAuthHeader()

  const list = companies ?? []
  const hasMany = list.length > 1

  return (
    <header className="sticky top-0 z-40 border-b border-white/50 bg-white/70 shadow-[0_1px_20px_-12px_rgba(2,6,23,0.25)] backdrop-blur-xl print:hidden">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-950 to-blue-800 text-amber-400 shadow-lg shadow-blue-950/20">
            <ClockIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-bold leading-tight tracking-tight text-slate-900">
              Ponto Eletrônico
            </p>
            {me && (
              <p className="truncate text-xs font-medium text-slate-500">
                {companyLabel(me) || '—'}
              </p>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {hasMany && me && (
            <select
              value={activeCompanyId ?? me.company_id ?? ''}
              onChange={(e) => void switchCompany(e.target.value)}
              className="h-9 max-w-[9.5rem] truncate rounded-xl border border-slate-200 bg-white/80 px-2.5 text-xs font-semibold text-slate-700 shadow-sm ring-blue-950/5 outline-none transition hover:border-slate-300 focus:ring-2 focus:ring-amber-400/60 sm:max-w-xs sm:text-sm"
              title="Trocar empresa (sem relogin)"
              aria-label="Trocar empresa"
            >
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome || c.cnpj}
                  {c.cnpj ? ` · ${formatCNPJ14(c.cnpj)}` : ''}
                </option>
              ))}
            </select>
          )}

          {me && (
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-950 to-blue-700 text-xs font-bold text-white shadow-md shadow-blue-950/20">
                {avatarInitials(me.full_name)}
              </div>
              <div className="hidden text-right sm:block">
                <p className="max-w-[10rem] truncate text-sm font-semibold leading-tight text-slate-900">
                  {me.full_name || 'Usuário'}
                </p>
                <p className="text-xs font-medium text-slate-500">{roleLabel(me.role)}</p>
              </div>
            </div>
          )}

          {me && (
            <button
              onClick={() => void signOut()}
              className="flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white/80 px-3 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 sm:text-sm"
              title="Sair"
            >
              <LogoutIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Sair</span>
            </button>
          )}
        </div>
      </div>
    </header>
  )
}

// Pequena adaptação: companies vem de me.companies (com fallback no backend).
function useAuthHeader() {
  const auth = useAuth()
  return {
    ...auth,
    companies: auth.me?.companies,
  }
}