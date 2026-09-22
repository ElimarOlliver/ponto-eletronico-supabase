import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Punch } from '../types'
import { fmtTimeBR, punchLabel } from '../lib/utils'

// *MAPA DE MARCAÇÕES (gestores)*
// Leaflet puro (sem react-leaflet): mapa inicializado uma vez, marcadores
// sincronizados a cada mudança do props.

interface Props {
  punches: Punch[]
}

const DOT: Record<string, string> = {
  in: '#10b981',
  break_start: '#f59e0b',
  break_end: '#f59e0b',
  out: '#f43f5e',
}

export default function PunchMap({ punches }: Props) {
  const divRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!divRef.current || mapRef.current) return
    const map = L.map(divRef.current, { zoomControl: true }).setView([-15.78, -47.93], 12)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  useEffect(() => {
    const layer = layerRef.current
    const map = mapRef.current
    if (!layer || !map) return
    layer.clearLayers()

    const valid = punches.filter(
      (p) => typeof p.latitude === 'number' && typeof p.longitude === 'number',
    ) as (Punch & { latitude: number; longitude: number })[]

    for (const p of valid.slice(0, 120)) {
      const color = DOT[p.p_type] ?? '#0ea5e9'
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:26px;height:26px;border-radius:9999px;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(2,6,23,.35)"></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      })
      const marker = L.marker([p.latitude, p.longitude], { icon })
      marker.bindPopup(
        `<strong>${punchLabel(p.p_type)}</strong><br/>${fmtTimeBR(p.occurred_at)}` +
          (p.note ? `<br/><em>${p.note}</em>` : ''),
      )
      marker.addTo(layer)
    }

    if (valid.length > 0) {
      map.setView([valid[0].latitude, valid[0].longitude], 14)
    }
  }, [punches])

  return <div ref={divRef} className="h-72 w-full" aria-label="Mapa de marcações" />
}