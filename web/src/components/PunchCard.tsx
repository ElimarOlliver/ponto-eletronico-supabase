import { useEffect, useState } from 'react'
import type { Punch, PunchType } from '../types'
import { clockParts, daySummary, punchLabel, suggestedPunch } from '../lib/utils'
import { ClockIcon, CheckIcon, ZapIcon } from './icons'

// *HERO DE MARCAÇÃO*
// Relógio ao vivo + chip de status do dia + os 4 botões (Entrada,
// Almoço/Saída, Retorno, Saída Final). Botão sugerido destacado.

interface Props {
  todayPunches: Punch[]
  punching: PunchType | null
  onPunch: (type: PunchType) => void
  // Perfil Admin (Programador/Suporte): não bate ponto — mostra apenas o
  // relógio/horário atual e oculta os botões de marcação.
  readOnly?: boolean
}

const BUTTONS: { type: PunchType; cls: string; icon: 'in' | 'break' | 'out' }[] = [
  { type: 'in', cls: 'from-emerald-500 to-emerald-600 shadow-emerald-600/25 hover:from-emerald-400 hover:to-emerald-500 text-white', icon: 'in' },
  { type: 'break_start', cls: 'from-amber-400 to-amber-500 shadow-amber-500/25 hover:from-amber-300 hover:to-amber-400 text-blue-950', icon: 'break' },
  { type: 'break_end', cls: 'from-amber-400 to-amber-500 shadow-amber-500/25 hover:from-amber-300 hover:to-amber-400 text-blue-950', icon: 'break' },
  { type: 'out', cls: 'from-rose-500 to-rose-600 shadow-rose-600/25 hover:from-rose-400 hover:to-rose-500 text-white', icon: 'out' },
]

function BreakIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3v8a6 6 0 0 0 12 0V3" />
      <path d="M6 9h12" />
      <path d="M12 17v4M8 21h8" />
    </svg>
  )
}

function OutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M13 3L4.8 12.7c-.3.4 0 .9.5.9H11l-1.4 7.6c-.1.7.8 1.1 1.2.4L19 10.9c.3-.4 0-.9-.5-.9H13l.9-7.3c.1-.6-.6-1-1-.7z" />
    </svg>
  )
}

export default function PunchCard({ todayPunches, punching, onPunch, readOnly = false }: Props) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const clock = clockParts(now)
  const summary = daySummary(todayPunches)
  const suggested = suggestedPunch(todayPunches)
  const count = todayPunches.length

  return (
    <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-blue-950 via-blue-900 to-blue-950 shadow-2xl shadow-blue-950/20 ring-1 ring-white/10 print:hidden">
      <div className={`grid gap-6 p-6 sm:p-8 ${readOnly ? '' : 'md:grid-cols-[1.1fr_1fr] md:items-center'}`}>
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ring-1 ${summary.cls}`}>
              {summary.completed ? <CheckIcon className="h-3.5 w-3.5" /> : <ClockIcon className="h-3.5 w-3.5" />}
              {summary.label}
            </span>
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-blue-100 ring-1 ring-white/15">
              {count} batida{count === 1 ? '' : 's'} hoje
            </span>
          </div>
          <p className="mt-5 font-mono text-5xl font-bold tabular-nums tracking-tight text-white sm:text-6xl">
            {clock.time}
          </p>
          <p className="mt-2 text-sm font-medium capitalize text-blue-200">{clock.date}</p>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-blue-100/80">
            Registre seus horários ao iniciar, pausar e encerrar o expediente. A localização é
            anexada a cada marcação.
          </p>
        </div>

        {readOnly ? (
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-5 py-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/90 text-blue-950">
              <ClockIcon className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium leading-snug text-blue-100/80">
              Perfil Administrador — a marcação de ponto está oculta. Você gerencia as
              empresas, colaboradores e o histórico de auditoria abaixo.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {BUTTONS.map((b) => {
              const isSuggested = b.type === suggested
              return (
                <button
                  key={b.type}
                  onClick={() => onPunch(b.type)}
                  disabled={punching !== null}
                  className={`btn-punch relative flex h-20 flex-col items-center justify-center gap-1 rounded-2xl bg-gradient-to-br text-sm font-bold shadow-lg transition active:scale-[0.98] sm:h-24 ${b.cls} ${
                    isSuggested
                      ? 'ring-2 ring-white/60 ring-offset-2 ring-offset-blue-950'
                      : ''
                  }`}
                >
                  {b.icon === 'in' ? (
                    <ZapIcon className="h-5 w-5" />
                  ) : b.icon === 'break' ? (
                    <BreakIcon className="h-5 w-5" />
                  ) : (
                    <OutIcon className="h-5 w-5" />
                  )}
                  <span className="px-1 text-center leading-tight">{punchLabel(b.type)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {!readOnly && (
        <div className="border-t border-white/10 bg-white/5 px-6 py-2.5 text-center text-xs font-medium text-blue-100/70 sm:px-8">
          {punching !== null ? 'Registrando marcação…' : 'Botão destacado = próxima marcação sugerida'}
        </div>
      )}
    </section>
  )
}