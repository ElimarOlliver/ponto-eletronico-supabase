import { useCallback, useEffect, useState } from 'react'
import type { Punch, PunchType, TimesheetDay, TimesheetTotals } from '../types'
import { useAuth } from '../state/AuthContext'
import { api, ApiError } from '../lib/api'
import {
  COMPANY_ADMIN_ROLES,
  MANAGER_ROLES,
  PLATFORM_ADMIN_ROLES,
  dayKeyOf,
  mondayOfWeek,
  todayISO,
} from '../lib/utils'
import PunchCard from './PunchCard'
import WeekMetrics from './WeekMetrics'
import PunchLists from './PunchLists'
import TeamPanel from './TeamPanel'
import AdminPanel from './AdminPanel'
import HolidaysPanel from './HolidaysPanel'
import PayrollPanel from './PayrollPanel'

// *DASHBOARD*
// Operador: hero + métricas + listas (mínimo).
// Gestor: + equipe, feriados, folha de ponto e mapa.
// Administrador (Programador/Suporte): NÃO bate ponto — vê apenas o relógio
// e o Painel Admin (empresas por CNPJ, colaboradores, pontos e auditoria).
// Dados recarregados ao trocar de empresa.

export default function Dashboard() {
  const { me } = useAuth()
  const [punches, setPunches] = useState<Punch[]>([])
  const [week, setWeek] = useState<TimesheetDay[]>([])
  const [totals, setTotals] = useState<TimesheetTotals | null>(null)
  const [loading, setLoading] = useState(true)
  const [punching, setPunching] = useState<PunchType | null>(null)
  const [punchMsg, setPunchMsg] = useState<string | null>(null)

  const isPlatformAdmin = me ? PLATFORM_ADMIN_ROLES.has(me.role) : false

  const loadAll = useCallback(async () => {
    setLoading(true)
    setPunchMsg(null)
    try {
      const [px, ts] = await Promise.all([
        api.myPunches(100),
        api.timesheet({ start: mondayOfWeek(), end: todayISO() }),
      ])
      setPunches(px)
      setWeek(ts.days)
      setTotals(ts.totals)
    } catch (e) {
      setPunchMsg(e instanceof ApiError ? e.message : 'Falha ao carregar seus dados. Recarregue a página.')
    } finally {
      setLoading(false)
    }
  }, [])

  const doPunch = useCallback(
    async (type: PunchType) => {
      if (punching) return
      setPunching(type)
      setPunchMsg(null)
      try {
        let lat: number | null = null
        let lon: number | null = null
        let acc: number | null = null
        if ('geolocation' in navigator) {
          try {
            const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 10000,
              }),
            )
            lat = pos.coords.latitude
            lon = pos.coords.longitude
            acc = pos.coords.accuracy
          } catch {
            /* sem permissão — registra sem localização */
          }
        }
        await api.clock({ type, lat, lon, accuracy: acc })
        setPunchMsg('✓ Marcação registrada com sucesso.')
        await loadAll()
      } catch (e) {
        setPunchMsg(e instanceof ApiError ? e.message : 'Falha ao registrar a marcação.')
      } finally {
        setPunching(null)
      }
    },
    [punching, loadAll],
  )

  useEffect(() => {
    // Perfil Admin não consome punche/timesheet próprio (não bate ponto).
    if (isPlatformAdmin) {
      setLoading(false)
      return
    }
    void loadAll()
  }, [loadAll, me?.id, isPlatformAdmin])

  const todayKey = dayKeyOf(new Date().toISOString())
  const todayPunches = punches.filter((p) => dayKeyOf(p.occurred_at) === todayKey)

  const isManager = me ? MANAGER_ROLES.has(me.role) : false
  const isAdmin = me ? COMPANY_ADMIN_ROLES.has(me.role) : false

  return (
    <div className="space-y-6">
      <PunchCard
        todayPunches={todayPunches}
        punching={punching}
        onPunch={doPunch}
        readOnly={isPlatformAdmin}
      />

      {isPlatformAdmin ? (
        <AdminPanel />
      ) : (
        <>
          {punchMsg && (
            <div
              className={`rounded-2xl border px-4 py-3 text-sm font-semibold shadow-sm ${
                punchMsg.startsWith('✓')
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}
            >
              {punchMsg}
            </div>
          )}

          <WeekMetrics totals={totals} loading={loading} />
          <PunchLists punches={punches} week={week} loading={loading} />

          {isManager && (
            <>
              <TeamPanel />
              <HolidaysPanel isAdmin={isAdmin} />
            </>
          )}

          {isManager && <PayrollPanel role={me!.role} />}
        </>
      )}
    </div>
  )
}