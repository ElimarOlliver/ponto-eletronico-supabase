"""Testes do Espelho de Ponto — Anexo II Portaria 1510 (MTE).

Cobre:
  - _compute_timesheet: novos campos MTE por dia (marcações, jornada
    realizada, tratamentos D/I/P com motivo)
  - _mte_jornada / _mte_tratamentos (helpers)
  - _build_espelho_mte: JSON relatorio_espelho_ponto por empregado
  - _fmt_cpf / _fmt_pis / _fmt_cnpj / _min_to_hhmm
  - _contract_schedule (CH) — sem banco cai no padrão 8h
Rodar: .venv\\Scripts\\python.exe test_espelho_mte.py
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


def ts(iso, ptype, status="approved", note=None, approved_by=None):
    return {
        "p_type": ptype,
        "occurred_at": iso,
        "approval_status": status,
        "note": note,
        "approved_by": approved_by,
    }


print("== 1) formatação de documentos ==")
check("CPF 11 dígitos formatado", m._fmt_cpf("12345678901") == "123.456.789-01")
check("CPF vazio -> vazio", m._fmt_cpf("") == "")
check("PIS formatado", m._fmt_pis("12345678901") == "123.45678.90-1")
check("CNPJ formatado", m._fmt_cnpj("66782325000181") == "66.782.325/0001-81")
check("min -> HH:MM", m._min_to_hhmm(660) == "11:00")
check("min negativo", m._min_to_hhmm(-90) == "-01:30")

print("== 2) _compute_timesheet: campos MTE por dia ==")
# Segunda 2026-09-07 (BRT): 07:55 in, 12:05 break_start, 13:00 break_end,
# 17:50 out; mais uma batida recusada com justificativa.
punches = [
    ts("2026-09-07T10:55:00+00:00", "in", "approved"),          # 07:55
    ts("2026-09-07T15:05:00+00:00", "break_start", "approved"),  # 12:05
    ts("2026-09-07T16:00:00+00:00", "break_end", "approved"),    # 13:00
    ts("2026-09-07T20:50:00+00:00", "out", "approved"),          # 17:50
    # batida recusada no mesmo dia (18:30 BRT = 21:30Z): entra nas marcações
    # + tratamento 'D'. (Não pode cruzar a meia-noite BRT.)
    ts("2026-09-07T21:30:00+00:00", "in", "rejected", note="Batida duplicada"),
]
days, totals = m._compute_timesheet(
    punches, set(), date(2026, 9, 7), date(2026, 9, 7), 480,
    expected_days={"2026-09-07": {"is_work": True, "expected_min": 480, "is_holiday": False}},
)
d = days[0]
check("marcações listam TODAS as batidas (inclui recusada)", d["marcacoes_eletronicas"] == ["07:55", "12:05", "13:00", "17:50", "18:30"])
jr = d["jornada_realizada"]
check("jornada realizada: entrada 07:55", jr[0] == "07:55")
check("jornada realizada: início intervalo 12:05", jr[1] == "12:05")
check("jornada realizada: fim intervalo 13:00", jr[2] == "13:00")
check("jornada realizada: saída 17:50", jr[3] == "17:50")
trats = d["tratamentos_efetuados"]
check("1 tratamento (a batida recusada)", len(trats) == 1)
check("tratamento ocorrência 'D'", trats[0]["ocorrencia"] == "D")
check("tratamento motivo = nota", trats[0]["motivo"] == "Batida duplicada")
check("tratamento horário original", trats[0]["horario_original"] == "18:30")
check("recusada não conta horas (worked = 10h - 1h = 9h=540)",
      d["worked_min"] == 540)
check("recusada NÃO vira falta justificada do dia", d["absent_justified"] is False)

print("== 3) tratamentos 'P' (pendente) e 'I' (nota em aprovada) ==")
p2 = [
    ts("2026-09-08T11:00:00+00:00", "in", "pending"),
    ts("2026-09-08T20:00:00+00:00", "out", "approved", note="Saída ajustada pelo gestor"),
]
days2, _ = m._compute_timesheet(
    p2, set(), date(2026, 9, 8), date(2026, 9, 8), 480,
    expected_days={"2026-09-08": {"is_work": True, "expected_min": 480, "is_holiday": False}},
)
tr2 = days2[0]["tratamentos_efetuados"]
occs = sorted(x["ocorrencia"] for x in tr2)
check("ocorrência 'P' para pendente e 'I' para nota em aprovada", occs == ["I", "P"])
check("motivo P menciona aprovação", any("aprovação" in x["motivo"] for x in tr2))

print("== 4) _mte_jornada: 2º turno em slots extras ==")
extra = m._mte_jornada([
    {"type": "in", "local": __import__("datetime").datetime(2026, 9, 9, 8, 0)},
    {"type": "out", "local": __import__("datetime").datetime(2026, 9, 9, 12, 0)},
    {"type": "in", "local": __import__("datetime").datetime(2026, 9, 9, 14, 0)},
    {"type": "out", "local": __import__("datetime").datetime(2026, 9, 9, 18, 0)},
])
check("2º turno anexado em slot extra", len(extra) == 6 and extra[4] == "14:00" and extra[5] == "18:00")

print("== 5) _build_espelho_mte: estrutura do modelo colado ==")
emp = {
    "user_id": "u1",
    "full_name": "Deusiane",
    "role": "employee",
    "cadastro": {"cpf": "123.456.789-01", "pis": "123.45678.90-1", "ctps": "1234567 Série 001-SP", "cargo": "Balconista", "data_admissao": "2023-01-15"},
    "escala_trabalho": "12x36",
    "codigo_ch": "001",
    "jornada_prevista": {"entrada": "07:00", "inicio_intervalo": "12:00", "fim_intervalo": "13:00", "saida": "19:00"},
    "days": days,
    "totals": totals,
}
company = {"cnpj": "66782325000181", "razao_social": "Por do Sol 2", "endereco": "Rua X, 100"}
doc = m._build_espelho_mte(emp, company, date(2026, 9, 1), date(2026, 9, 30))
root = doc["relatorio_espelho_ponto"]
check("raiz relatorio_espelho_ponto", "relatorio_espelho_ponto" in doc)
check("metadados.periodo_referencia", root["metadados"]["periodo_referencia"] == "09/2026")
check("empregador.identificador_cnpj formatado", root["empregador"]["identificador_cnpj"] == "66.782.325/0001-81")
check("empregado.nome", root["empregado"]["nome"] == "Deusiane")
check("empregado.escala_trabalho", root["empregado"]["escala_trabalho"] == "12x36")
check("horarios_contratuais.codigo_ch", root["horarios_contratuais"]["codigo_ch"] == "001")
check("registros_diarios tem o dia", any(r["dia"] == "07" for r in root["registros_diarios"]))
check("resumo_mensal_rh.total_horas_trabalhadas", root["resumo_mensal_rh"]["total_horas_trabalhadas"] == "09:00")
check("resumo tem dias_para_desconto_salarial", "dias_para_desconto_salarial" in root["resumo_mensal_rh"])
check("status_fechamento_mes presente", "status_fechamento_mes" in root["resumo_mensal_rh"])

print(f"\nRESULTADO: {OK} ok, {FAIL} falha(s)")
sys.exit(1 if FAIL else 0)
