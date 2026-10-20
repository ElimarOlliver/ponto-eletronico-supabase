"""Teste unitario do motor de jornada com escala 12x36.

Valida _compute_timesheet sem banco: monta um "expected_days" sintetico
(como se viesse de public.dias_esperados) e punches sinteticos, e confere:
  - dia de plantao 07:00-19:00 com 1h almoco = 660 min trabalhados, saldo 0
  - dia de folga 12x36 => expected 0, sem falta
  - variacao de minutos gera overtime/deficit corretos
  - ponto 'rejected' nao conta

Uso: python test_timesheet_12x36.py
"""
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, ".")

from app.main import _compute_timesheet  # noqa: E402

# Brasil/Sao_Paulo em setembro/2026 = UTC-3 (sem horario de verao).
SP = timezone(timedelta(hours=-3))

ok = 0
fail = 0


def check(nome, cond, detalhe=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"PASS  {nome}")
    else:
        fail += 1
        print(f"FAIL  {nome}  {detalhe}")


def punch(tipo, dia, hora, minuto, status="approved", seg=0):
    ts = datetime(dia.year, dia.month, dia.day, hora, minuto, seg, tzinfo=SP)
    return {"p_type": tipo, "occurred_at": ts.isoformat(), "approval_status": status}


def plantao(dia, jit=0, status="approved"):
    """4 batidas: in 07:00+jit, break_start 12:00, break_end 13:00, out 19:00+jit."""
    return [
        punch("in", dia, 7, 0 + jit, status),
        punch("break_start", dia, 12, 0, status),
        punch("break_end", dia, 13, 0, status),
        punch("out", dia, 19, 0 + jit, status),
    ]


# ---------- Cenario 1: um plantao completo, saldo zero ----------
d1 = date(2026, 9, 1)
expected_days = {
    d1.isoformat(): {"is_work": True, "expected_min": 660, "is_holiday": False},
}
days, totals = _compute_timesheet(plantao(d1), set(), d1, d1, 480, expected_days)
check("1 plantao = 660 min trabalhados", totals["worked_min"] == 660, detalhe=str(totals))
check("1 plantao = 660 min esperados", totals["expected_min"] == 660, detalhe=str(totals))
check("1 plantao = saldo 0", totals["balance_min"] == 0, detalhe=str(totals))
check("1 plantao sem overtime", totals["overtime_min"] == 0, detalhe=str(totals))
check("1 plantao sem deficit", totals["deficit_min"] == 0, detalhe=str(totals))
check("1 plantao status ok", days[0]["status"] == "ok", detalhe=days[0]["status"])

# ---------- Cenario 2: ciclo 12x36 em 2 dias (trabalha, folga) ----------
d2a, d2b = date(2026, 9, 2), date(2026, 9, 3)
expected_days2 = {
    d2a.isoformat(): {"is_work": True, "expected_min": 660, "is_holiday": False},
    d2b.isoformat(): {"is_work": False, "expected_min": 0, "is_holiday": False},
}
days, totals = _compute_timesheet(plantao(d2a), set(), d2a, d2b, 480, expected_days2)
check("ciclo: 2 dias, 1 trabalhado", totals["worked_min"] == 660, detalhe=str(totals))
check("ciclo: esperado so 1 dia (660)", totals["expected_min"] == 660, detalhe=str(totals))
check("ciclo: saldo 0", totals["balance_min"] == 0, detalhe=str(totals))
check("dia de folga nao e falta (status off)", days[1]["status"] == "off", detalhe=days[1]["status"])
check("dia de folga nao gera deficit", days[1]["deficit_min"] == 0, detalhe=str(days[1]))

# ---------- Cenario 3: variacao de minutos gera overtime ----------
d3 = date(2026, 9, 4)
# in 07:00, out 19:10 -> 730 - 60 = 670 min (660 + 10 extra)
p3 = [
    punch("in", d3, 7, 0),
    punch("break_start", d3, 12, 0),
    punch("break_end", d3, 13, 0),
    punch("out", d3, 19, 10),
]
days, totals = _compute_timesheet(p3, set(), d3, d3, 480, {d3.isoformat(): {"is_work": True, "expected_min": 660, "is_holiday": False}})
check("variacao: 670 min trabalhados", totals["worked_min"] == 670, detalhe=str(totals))
check("variacao: overtime 10", totals["overtime_min"] == 10, detalhe=str(totals))
check("variacao: saldo +10", totals["balance_min"] == 10, detalhe=str(totals))

# ---------- Cenario 4: atraso gera deficit ----------
d4 = date(2026, 9, 5)
p4 = [
    punch("in", d4, 7, 5),   # entrou 5 min depois
    punch("break_start", d4, 12, 0),
    punch("break_end", d4, 13, 0),
    punch("out", d4, 19, 0),
]
days, totals = _compute_timesheet(p4, set(), d4, d4, 480, {d4.isoformat(): {"is_work": True, "expected_min": 660, "is_holiday": False}})
check("atraso: 655 min trabalhados", totals["worked_min"] == 655, detalhe=str(totals))
check("atraso: deficit 5", totals["deficit_min"] == 5, detalhe=str(totals))
check("atraso: saldo -5", totals["balance_min"] == -5, detalhe=str(totals))

# ---------- Cenario 5: 'rejected' nao conta ----------
d5 = date(2026, 9, 6)
days, totals = _compute_timesheet(
    plantao(d5, status="rejected"), set(), d5, d5, 480,
    {d5.isoformat(): {"is_work": True, "expected_min": 660, "is_holiday": False}},
)
check("rejected: 0 min trabalhados", totals["worked_min"] == 0, detalhe=str(totals))
check("rejected: dia fica 'absent' (esperado mas sem batida)", days[0]["status"] == "absent", detalhe=days[0]["status"])
check("rejected: deficit 660", totals["deficit_min"] == 660, detalhe=str(totals))

# ---------- Cenario 6: 'pending' conta e sinaliza ----------
d6 = date(2026, 9, 7)
days, totals = _compute_timesheet(
    plantao(d6, status="pending"), set(), d6, d6, 480,
    {d6.isoformat(): {"is_work": True, "expected_min": 660, "is_holiday": False}},
)
check("pending: 660 min contam", totals["worked_min"] == 660, detalhe=str(totals))
check("pending: has_pending true", totals["has_pending"] is True, detalhe=str(totals))

# ---------- Cenario 7: SEM escala (fallback antigo seg-sex 8h) ----------
d7 = date(2026, 9, 8)  # terca-feira
days, totals = _compute_timesheet(plantao(d7), set(), d7, d7, 480, None)
check("fallback sem escala: esperado 480", totals["expected_min"] == 480, detalhe=str(totals))
check("fallback sem escala: trabalhado 660", totals["worked_min"] == 660, detalhe=str(totals))
check("fallback sem escala: overtime 180", totals["overtime_min"] == 180, detalhe=str(totals))

# ---------- Cenario 8: dia incompleto (so 'in', sem 'out') ----------
d8 = date(2026, 9, 9)
days, totals = _compute_timesheet(
    [punch("in", d8, 7, 0)], set(), d8, d8, 480,
    {d8.isoformat(): {"is_work": True, "expected_min": 660, "is_holiday": False}},
)
check("incompleto: flag has_incomplete", totals["has_incomplete"] is True, detalhe=str(totals))
check("incompleto: status incomplete", days[0]["status"] == "incomplete", detalhe=days[0]["status"])

print(f"\nRESULTADO: {ok} ok, {fail} falha(s)")
sys.exit(1 if fail else 0)
