"""Testes da funcionalidade: Relatório de Fechamento de Ponto (PDF + JSON).

Cobre:
  - _month_range (parsing do mês)
  - _compute_timesheet: contagem de aprovados/pendentes/recusados e
    faltas justificadas x não justificadas
  - _report_pdf_bytes: gera um PDF válido (cabeçalho %PDF)
  - _report_filename
Rodar: .venv\\Scripts\\python.exe test_relatorio_fechamento.py
"""
import sys
from datetime import date

sys.path.insert(0, ".")

import app.main as m  # noqa: E402

OK = 0
FAIL = 0


def check(name, cond):
    global OK, FAIL
    if cond:
        OK += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FALHA {name}")


def ts(iso, ptype, status="approved", note=None):
    return {"p_type": ptype, "occurred_at": iso, "approval_status": status, "note": note}


print("== 1) _month_range ==")
s, e = m._month_range("2026-09")
check("set/2026 inicia 01", s == date(2026, 9, 1))
check("set/2026 termina 30", e == date(2026, 9, 30))
s, e = m._month_range("2026-12")
check("dez/2026 termina 31", e == date(2026, 12, 31))
s, e = m._month_range("2024-02")
check("fev/2024 (bissexto) termina 29", e == date(2024, 2, 29))
try:
    m._month_range("2026/09")
    check("month inválido -> 400", False)
except m.HTTPException as ex:
    check("month inválido -> 400", ex.status_code == 400)

print("== 2) _compute_timesheet: contagens e faltas ==")
# Segunda 2026-09-07: dia trabalhado com 1 aprovado + 1 pendente;
# Terça 2026-09-08: dia previsto sem batida com justificativa (falta justificada);
# Quarta 2026-09-09: dia previsto sem batida (falta NÃO justificada).
punches = [
    ts("2026-09-07T10:00:00+00:00", "in", "approved"),      # 07:00 BRT
    ts("2026-09-07T11:00:00+00:00", "break_start", "approved"),
    ts("2026-09-07T12:00:00+00:00", "break_end", "pending"),
    ts("2026-09-07T21:00:00+00:00", "out", "approved"),      # 18:00 BRT -> 11h - 1h = 10h? ajusta abaixo
    # Dia 08 sem batida mas com justificativa registrada numa batida recusada.
    ts("2026-09-08T11:00:00+00:00", "in", "rejected", note="Atestado médico apresentado ao RH"),
]
days, totals = m._compute_timesheet(
    punches, set(), date(2026, 9, 7), date(2026, 9, 9), 480,
    expected_days={
        "2026-09-07": {"is_work": True, "expected_min": 480, "is_holiday": False},
        "2026-09-08": {"is_work": True, "expected_min": 480, "is_holiday": False},
        "2026-09-09": {"is_work": True, "expected_min": 480, "is_holiday": False},
    },
)
d7, d8, d9 = days
check("dia 07 tem 4 batidas contadas (recusado fora)", d7["punches"] == 4)
check("dia 07: 3 aprovadas", d7["approved_count"] == 3)
check("dia 07: 1 pendente", d7["pending_count"] == 1)
check("dia 07: 0 recusadas", d7["rejected_count"] == 0)
check("dia 07 nao e falta", not d7["absent_justified"] and not d7["absent_unjustified"])
check("dia 08 e falta JUSTIFICADA", d8["absent_justified"] is True and d8["absent_unjustified"] is False)
check("dia 09 e falta NAO justificada", d9["absent_unjustified"] is True and d9["absent_justified"] is False)
check("totais: 1 justificada", totals["absences_justified"] == 1)
check("totais: 1 nao justificada", totals["absences_unjustified"] == 1)
check("totais: soma de aprovadas", totals["approved_count"] == 3)
check("totais: soma de pendentes", totals["pending_count"] == 1)

print("== 3) folga (off) nao conta como falta ==")
days2, totals2 = m._compute_timesheet(
    [], set(), date(2026, 9, 12), date(2026, 9, 13), 480,
    expected_days={
        "2026-09-12": {"is_work": False, "expected_min": 0, "is_holiday": False},
        "2026-09-13": {"is_work": False, "expected_min": 0, "is_holiday": False},
    },
)
check("folga: 0 faltas", totals2["absences_justified"] == 0 and totals2["absences_unjustified"] == 0)

print("== 4) PDF e nome do arquivo ==")
report = {
    "period": {"month": "2026-09", "start": "2026-09-01", "end": "2026-09-30"},
    "company": {"id": "x", "cnpj": "66.782.325/0001-81", "nome": "Por do Sol 2"},
    "generated_by": {"id": "u", "full_name": "Milena", "role": "company_admin"},
    "generated_at": "2026-10-01T10:00:00-03:00",
    "employees": [
        {
            "user_id": "u1",
            "full_name": "Deusiane",
            "role": "employee",
            "days": days,
            "totals": totals,
        }
    ],
    "totals": totals,
    "count": 1,
}
pdf = m._report_pdf_bytes(report)
check("PDF comeca com %PDF", pdf[:4] == b"%PDF")
check("PDF tem tamanho razoavel (>1KB)", len(pdf) > 1024)
check(
    "nome do arquivo usa mes+cnpj",
    m._report_filename(report, "json") == "fechamento-ponto-2026-09-66782325000181.json",
)
check(
    "nome do arquivo pdf",
    m._report_filename(report, "pdf") == "fechamento-ponto-2026-09-66782325000181.pdf",
)

print(f"\nRESULTADO: {OK} ok, {FAIL} falha(s)")
sys.exit(1 if FAIL else 0)
