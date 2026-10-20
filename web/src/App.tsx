import { useState } from 'react'
import { AuthProvider, useAuth } from './state/AuthContext'
import Header, { type AppView } from './components/Header'
import LoginCard from './components/LoginCard'
import Dashboard from './components/Dashboard'
import RegisterEmployeePanel from './components/RegisterEmployeePanel'

// *APP ROOT*
// Fluxo: loading → login/anon → dashboard (role-gate feito no Dashboard).
// Navegação: aba 'Meu ponto' sempre; 'Cadastrar funcionário' só para o GESTOR
// de loja. O Administrador cadastra funcionários por drill-down (Dashboard →
// Empresa → aba Cadastrar), portanto NÃO tem atalho global.

function Shell() {
  const { status, me } = useAuth()
  const [view, setView] = useState<AppView>('dashboard')

  // Gestor de loja: cadastro global (empresa travada). Admin: sem atalho global.
  const canRegister = me ? me.role === 'manager' : false
  const view2 = canRegister ? view : 'dashboard'

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 antialiased">
      <Header view={view2} onNavigate={setView} onRegister={canRegister} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {status === 'loading' ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-950/15 border-t-blue-950" />
          </div>
        ) : status === 'anonymous' ? (
          <LoginCard />
        ) : view2 === 'cadastrar' && me ? (
          <RegisterEmployeePanel role={me.role} activeCompanyId={me.company_id} />
        ) : (
          <Dashboard />
        )}
      </main>
      <footer className="py-6 text-center text-xs font-medium text-slate-400 print:hidden">
        Ponto Eletrônico · Gestão de jornada de trabalho
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}