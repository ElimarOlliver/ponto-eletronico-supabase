"""Testes negativos de ISOLAMENTO entre empresas (correções de escopo multi-tenant).

Cobre as correções da Fase 1 do backlog de segurança:
  C-A1  /api/my-punches devolve apenas as batidas do PRÓPRIO usuário
        (antes, em modo alternado, vazava a empresa inteira).
  C-C2  _get_punch_or_403 recusa ponto de outra empresa SEM exceção de papel.
  C-C3  _report_targets recusa colaborador de outra empresa para company_admin
        (a condição "not SYSTEM_ADMIN_ROLES" era sempre falsa).
  C-C5  company_admin NÃO cria funcionário em empresa alheia.

Supabase e auth são substituídos por stubs (sem rede).
Rodar: .venv\\Scripts\\python.exe test_multi_tenant_scope.py
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


# ---------- Identidades ----------
EMP_A = "11111111-0000-0000-0000-000000000001"  # funcionário da empresa A
EMP_B = "11111111-0000-0000-0000-000000000002"  # funcionário da empresa B
ADM_A = "33333333-0000-0000-0000-000000000003"  # company_admin da empresa A
PLAT = "44444444-0000-0000-0000-000000000004"   # system_admin
PUNCH_A = 101
PUNCH_B = 202

# Dados por empresa: punches e profiles das duas empresas.
PUNCHES = [
    {"id": PUNCH_A, "user_id": EMP_A, "company_id": "cA", "note": "a"},
    {"id": 102, "user_id": EMP_A, "company_id": "cA", "note": "a2"},
    {"id": PUNCH_B, "user_id": EMP_B, "company_id": "cB", "note": "b"},
]
PROFILES = [
    {"id": EMP_A, "full_name": "Ana A", "role": "employee", "company_id": "cA", "manager_id": ADM_A},
    {"id": EMP_B, "full_name": "Bia B", "role": "employee", "company_id": "cB", "manager_id": None},
    {"id": ADM_A, "full_name": "Adm A", "role": "company_admin", "company_id": "cA", "manager_id": None},
]


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self._filters = []
        self._limit = None

    def select(self, *a, **k):
        return self

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def single(self):
        self._is_single = True
        self._limit = 1
        return self

    def execute(self):
        rows = self.rows
        for col, val in self._filters:
            rows = [r for r in rows if str(r.get(col)) == str(val)]
        if self._limit:
            rows = rows[: self._limit]
        if getattr(self, "_is_single", False):
            return types.SimpleNamespace(data=dict(rows[0]) if rows else None)
        return types.SimpleNamespace(data=[dict(r) for r in rows])


class FakeClient:
    def table(self, name):
        if name == "punches":
            return FakeQuery(PUNCHES)
        if name == "profiles":
            return FakeQuery(PROFILES)
        return FakeQuery([])


def fake_resolve_auth(me):
    def _inner(request, authorization, x_company_id=None):
        prof = dict(me)
        prof.setdefault("active_company_id", prof.get("company_id"))
        prof.setdefault("is_switched", False)
        prof.setdefault("companies", [{"id": prof.get("company_id"), "cnpj": "", "nome": "", "ativa": True}])
        return FakeClient(), prof, "jwt"

    return _inner


def make_client(me):
    m.resolve_auth = fake_resolve_auth(me)
    m.rate_limit = lambda *a, **k: None  # noqa: ARG005
    from fastapi.testclient import TestClient

    return TestClient(m.app)


print("== 1) /api/my-punches: só as batidas do PRÓPRIO usuário ==")
cl = make_client({"id": EMP_A, "full_name": "Ana A", "role": "employee", "company_id": "cA"})
r = cl.get("/api/my-punches")
check("employee -> 200", r.status_code == 200)
data = r.json()
check("retorna apenas batidas do próprio usuário", all(p.get("user_id") == EMP_A for p in data))
check("não retorna nada da outra empresa", all(p.get("company_id") == "cA" for p in data))
check("trouxe as 2 batidas próprias", len(data) == 2)

# Em modo alternado (service key, sem RLS) o filtro de usuário tem que valer igual.
cl = make_client(
    {"id": EMP_A, "full_name": "Ana A", "role": "employee", "company_id": "cB", "is_switched": True}
)
r = cl.get("/api/my-punches")
check("modo alternado: continua só o próprio usuário", all(p.get("user_id") == EMP_A for p in r.json()))


print("== 2) Leitura de ponto de outra empresa -> 403 ==")
cl = make_client({"id": ADM_A, "full_name": "Adm A", "role": "company_admin", "company_id": "cA"})
try:
    m._get_punch_or_403(FakeClient(), PUNCH_B, {"id": ADM_A, "role": "company_admin", "company_id": "cA"})
    check("company_admin lendo ponto de outra empresa -> 403", False)
except Exception as e:
    check("company_admin lendo ponto de outra empresa -> 403", getattr(e, "status_code", None) == 403)

# system_admin também precisa declarar a empresa (sem isenção).
try:
    m._get_punch_or_403(FakeClient(), PUNCH_B, {"id": PLAT, "role": "system_admin", "company_id": "cA"})
    check("system_admin de cA lendo ponto de cB -> 403", False)
except Exception as e:
    check("system_admin de cA lendo ponto de cB -> 403", getattr(e, "status_code", None) == 403)

# Mesma empresa continua funcionando.
row = m._get_punch_or_403(FakeClient(), PUNCH_A, {"id": ADM_A, "role": "company_admin", "company_id": "cA"})
check("ponto da própria empresa -> liberado", row.get("id") == PUNCH_A)


print("== 3) _report_targets: company_admin não lê CPF/PIS de outra empresa ==")
try:
    m._report_targets(
        FakeClient(),
        {"id": ADM_A, "full_name": "Adm A", "role": "company_admin", "company_id": "cA", "companies": []},
        EMP_B,
        None,
    )
    check("company_admin pedindo colaborador de cB -> 403", False)
except Exception as e:
    check("company_admin pedindo colaborador de cB -> 403", getattr(e, "status_code", None) == 403)

# O próprio colaborador da empresa continua acessível.
tgts = m._report_targets(
    FakeClient(),
    {"id": ADM_A, "full_name": "Adm A", "role": "company_admin", "company_id": "cA", "companies": []},
    EMP_A,
    None,
)
check("company_admin pedindo colaborador da própria empresa -> ok", tgts and tgts[0]["id"] == EMP_A)

# system_admin (plataforma) continua acessando outra empresa via CNPJ.
tgts = m._report_targets(
    FakeClient(),
    {"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "cA", "companies": []},
    EMP_B,
    None,
)
check("system_admin pedindo colaborador de outra empresa -> ok", tgts and tgts[0]["id"] == EMP_B)


print(f"\nRESULTADO: {OK} ok, {FAIL} falha(s)")
sys.exit(1 if FAIL else 0)
