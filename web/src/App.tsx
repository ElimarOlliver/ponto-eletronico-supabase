import { AuthProvider, useAuth } from './state/AuthContext'
import Header from './components/Header'
import LoginCard from './components/LoginCard'
import Dashboard from './components/Dashboard'

// *APP ROOT*
// Fluxo: loading → login/anon → dashboard (role-gate feito no Dashboard).

function Shell() {
  const { status } = useAuth()

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900 antialiased">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {status === 'loading' ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-950/15 border-t-blue-950" />
          </div>
        ) : status === 'anonymous' ? (
          <LoginCard />
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