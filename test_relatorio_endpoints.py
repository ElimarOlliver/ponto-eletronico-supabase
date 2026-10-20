"""Testes dos endpoints do Relatório de Fechamento (PDF + JSON).

Valida a HIERARQUIA DE ACESSO e os arquivos gerados, com Supabase e auth
substituídos por stubs (sem rede).

Rodar: .venv\\Scripts\\python.exe test_relatorio_endpoints.py
"""
import sys
import types

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


# ---------- Stub do client Supabase ----------
EMP = "11111111-0000-0000-0000-000000000001"   # funcionário comum
MGR = "22222222-0000-0000-0000-000000000002"   # gerente
ADM = "33333333-0000-0000-0000-000000000003"   # company_admin
PLAT = "44444444-0000-0000-0000-000000000004"  # system_admin
SUB = "55555555-0000-0000-0000-000000000005"   # subordinado do gerente
OTHER = "66666666-0000-0000-0000-000000000006"  # fora da equipe/empresa
CNPJ = "66782325000181"

PROFILES = [
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "manager_id": MGR, "company_id": "c1"},
    {"id": MGR, "full_name": "Milena", "role": "manager", "manager_id": None, "company_id": "c1"},
    {"id": SUB, "full_name": "Mayara", "role": "employee", "manager_id": MGR, "company_id": "c1"},
    {"id": ADM, "full_name": "Admin empresa", "role": "company_admin", "manager_id": None, "company_id": "c1"},
    {"id": OTHER, "full_name": "Forasteiro", "role": "employee", "manager_id": None, "company_id": "c2"},
]

PUNCHES = {
    EMP: [
        {"p_type": "in", "occurred_at": "2026-09-07T10:00:00+00:00", "approval_status": "approved", "note": None},
        {"p_type": "out", "occurred_at": "2026-09-07T21:00:00+00:00", "approval_status": "approved", "note": None},
    ],
}


class FakeQuery:
    def __init__(self, table, rows):
        self.table = table
        self.rows = rows
        self._filters = []
        self._limit = None

    def select(self, *a, **k):
        return self

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def neq(self, *a, **k):
        return self

    def gte(self, *a, **k):
        return self

    def lt(self, *a, **k):
        return self

    def lte(self, *a, **k):
        return self

    def or_(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def single(self):
        self._single = True
        return self

    def execute(self):
        rows = self.rows
        for col, val in self._filters:
            rows = [r for r in rows if str(r.get(col)) == str(val)]
        if getattr(self, "_single", False):
            return types.SimpleNamespace(data=(rows[0] if rows else None))
        if self._limit:
            rows = rows[: self._limit]
        return types.SimpleNamespace(data=rows)

    def upsert(self, *a, **k):
        return self


class FakeClient:
    def __init__(self):
        self.calls = []

    def table(self, name):
        self.calls.append(name)
        if name == "profiles":
            return FakeQuery(name, [dict(p) for p in PROFILES])
        if name == "companies":
            return FakeQuery(name, [{"id": "c1", "nome": "Por do Sol 2", "cnpj": CNPJ}])
        if name == "punches":
            return FakePunchQuery()
        if name == "holidays":
            return FakeQuery(name, [])
        return FakeQuery(name, [])


class FakePunchQuery(FakeQuery):
    def __init__(self):
        super().__init__("punches", [])
        self._user = None

    def eq(self, col, val):
        if col == "user_id":
            self._user = val
        return self

    def execute(self):
        rows = PUNCHES.get(self._user, [])
        return types.SimpleNamespace(data=rows)


def fake_resolve_auth(me):
    def _inner(request, authorization, x_company_id=None):
        client = FakeClient()
        prof = dict(me)
        prof.setdefault("active_company_id", prof.get("company_id"))
        prof.setdefault("is_switched", False)
        return client, prof, "jwt"

    return _inner


def run_case(me, query, label):
    m.resolve_auth = fake_resolve_auth(me)
    m.rate_limit = lambda *a, **k: None  # noqa: ARG005
    from fastapi.testclient import TestClient

    app = m.app
    client = TestClient(app)
    res = client.get(f"/api/reports/monthly.json?{query}")
    return res


print("== 1) Funcionário: só o próprio ==")
r = run_case(
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"},
    "month=2026-09",
    "employee",
)
check("employee gera o próprio (200)", r.status_code == 200)
if r.status_code == 200:
    j = r.json()
    check("employee: 1 colaborador", j["count"] == 1)
    check("employee: é ele mesmo", j["employees"][0]["user_id"] == EMP)
    check("employee: saldo calculado", "balance_min" in j["totals"])
    check("resposta tem Content-Disposition json", "attachment" in r.headers.get("content-disposition", ""))

print("== 2) Funcionário tentando outro colaborador ==")
r = run_case(
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"},
    f"month=2026-09&user_id={SUB}",
    "employee-other",
)
check("employee com user_id alheio -> 403", r.status_code == 403)

print("== 3) Gerente: a própria equipe ==")
r = run_case(
    {"id": MGR, "full_name": "Milena", "role": "manager", "company_id": "c1"},
    "month=2026-09",
    "manager",
)
check("manager gera a equipe (200)", r.status_code == 200)
if r.status_code == 200:
    j = r.json()
    ids = {e["user_id"] for e in j["employees"]}
    check("manager inclui o subordinado", SUB in ids)
    check("manager NÃO inclui forasteiro de outra empresa", OTHER not in ids)

print("== 4) Gerente tentando alguém fora da equipe ==")
r = run_case(
    {"id": MGR, "full_name": "Milena", "role": "manager", "company_id": "c1"},
    f"month=2026-09&user_id={OTHER}",
    "manager-other",
)
check("manager com user_id fora da equipe -> 403", r.status_code == 403)

print("== 5) Admin/RH: toda a empresa + filtro por CNPJ ==")
r = run_case(
    {"id": ADM, "full_name": "Admin", "role": "company_admin", "company_id": "c1"},
    "month=2026-09",
    "admin",
)
check("company_admin gera a empresa (200)", r.status_code == 200)
if r.status_code == 200:
    j = r.json()
    ids = {e["user_id"] for e in j["employees"]}
    check("company_admin inclui vários", len(ids) >= 2)

r = run_case(
    {"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"},
    f"month=2026-09&cnpj={CNPJ}",
    "admin-cnpj",
)
check("system_admin com CNPJ válido (200)", r.status_code == 200)

r = run_case(
    {"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"},
    "month=2026-09&cnpj=00000000000000",
    "admin-cnpj-invalido",
)
check("system_admin com CNPJ inexistente -> 404", r.status_code == 404)

print("== 6) Validação de mês ==")
r = run_case(
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"},
    "month=2026-13",
    "mes-invalido",
)
check("mês inválido -> 400", r.status_code == 400)
r = run_case(
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"},
    "",
    "sem-mes",
)
check("sem mês -> 400", r.status_code == 400)

print("== 7) PDF ==")
r = run_case(
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"},
    "month=2026-09",
    "pdf",
)
# Chama diretamente o endpoint PDF pela app (mesma rota com .pdf)
m.resolve_auth = fake_resolve_auth(
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"}
)
from fastapi.testclient import TestClient  # noqa: E402

pdf_res = TestClient(m.app).get("/api/reports/monthly.pdf?month=2026-09")
check("PDF retorna 200", pdf_res.status_code == 200)
check("content-type é application/pdf", pdf_res.headers.get("content-type") == "application/pdf")
check("PDF começa com %PDF", pdf_res.content[:4] == b"%PDF")
check("PDF tem tamanho > 1KB", len(pdf_res.content) > 1024)

print("== 8) format=mte (Anexo II / um empregado) ==")
m.resolve_auth = fake_resolve_auth(
    {"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"}
)
r = TestClient(m.app).get("/api/reports/monthly.json?month=2026-09&format=mte")
check("employee format=mte -> 200", r.status_code == 200)
if r.status_code == 200:
    doc = r.json()
    check("mte: raiz relatorio_espelho_ponto", "relatorio_espelho_ponto" in doc)
    root = doc["relatorio_espelho_ponto"]
    check("mte: metadados com período", root["metadados"]["periodo_referencia"] == "09/2026")
    check("mte: empregado nomeado", root["empregado"]["nome"] == "Edenilza")
    check("mte: registros_diarios é lista", isinstance(root["registros_diarios"], list))
    check("mte: resumo_mensal_rh presente", "resumo_mensal_rh" in root)
    check("mte: rota .json também expõe espelhos_mte", "espelhos_mte" in TestClient(m.app).get("/api/reports/monthly.json?month=2026-09").json())

print("== 9) format=mte exige UM colaborador ==")
m.resolve_auth = fake_resolve_auth(
    {"id": ADM, "full_name": "Admin", "role": "company_admin", "company_id": "c1"}
)
r = TestClient(m.app).get("/api/reports/monthly.json?month=2026-09&format=mte")
check("admin format=mte sem user_id (vários) -> 400", r.status_code == 400)

print(f"\nRESULTADO: {OK} ok, {FAIL} falha(s)")
sys.exit(1 if FAIL else 0)
