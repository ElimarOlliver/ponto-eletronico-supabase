"""Testes do cadastro de funcionário (POST /api/admin/employees e /api/companies/options).

Cobre a HIERARQUIA DE ACESSO, a TRAVA DE EMPRESA do gestor, as validações e o
FLUXO TRANSACIONAL (RPC falhou -> usuário auth é apagado = rollback compensatório).
Supabase e auth são substituídos por stubs (sem rede).

Rodar: .venv\\Scripts\\python.exe test_cadastro_funcionario.py
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
EMP = "11111111-0000-0000-0000-000000000001"   # funcionário comum
MGR = "22222222-0000-0000-0000-000000000002"   # gerente da empresa c1
ADM = "33333333-0000-0000-0000-000000000003"   # company_admin
PLAT = "44444444-0000-0000-0000-000000000004"  # system_admin
CNPJ1 = "66782325000181"
CNPJ2 = "11222333000199"

COMPANIES = [
    {"id": "c1", "nome": "Por do Sol 2", "cnpj": CNPJ1, "ativa": True},
    {"id": "c2", "nome": "Por do Sol Centro", "cnpj": CNPJ2, "ativa": True},
]


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

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = self.rows
        for col, val in self._filters:
            rows = [r for r in rows if str(r.get(col)) == str(val)]
        if self._limit:
            rows = rows[: self._limit]
        return types.SimpleNamespace(data=rows)


class FakeClient:
    def table(self, name):
        if name == "companies":
            return FakeQuery(name, [dict(c) for c in COMPANIES])
        if name == "profiles":
            return FakeQuery(name, [])
        return FakeQuery(name, [])


# ---------- Stubs de auth/admin ----------
class FakeAdmin:
    """Stub do client service_role: auth.admin.create_user + rpc + delete."""

    def __init__(self, fail_rpc=False):
        self.fail_rpc = fail_rpc
        self.deleted = []
        self.created = []
        self.rpc_calls = []
        self.auth = types.SimpleNamespace(admin=self)

    def create_user(self, payload):
        self.created.append(payload)
        return types.SimpleNamespace(user=types.SimpleNamespace(id="new-user-uuid"))

    def rpc(self, fn, args):
        self.rpc_calls.append((fn, args))
        fail = self.fail_rpc

        class _Exec:
            def execute(_self):
                if fail:
                    raise RuntimeError('function public.criar_funcionario(...) does not exist')
                return types.SimpleNamespace(data={"profile": {"id": args["p_user_id"]}})

        return _Exec()

    def table(self, name):
        return FakeClient().table(name)


def fake_resolve_auth(me):
    def _inner(request, authorization, x_company_id=None):
        prof = dict(me)
        prof.setdefault("active_company_id", prof.get("company_id"))
        prof.setdefault("is_switched", False)
        # Multi-empresa: gestor enxerga só a própria; admin da empresa enxerga
        # as dele; system_admin lista tudo por outra rota (não usa isto).
        comps = [c for c in COMPANIES if c["id"] == me.get("company_id")]
        prof.setdefault("companies", [dict(c) for c in comps])
        return FakeClient(), prof, "jwt"

    return _inner


def make_client(me, admin):
    m.resolve_auth = fake_resolve_auth(me)
    m.rate_limit = lambda *a, **k: None  # noqa: ARG005
    m.sb_admin = admin
    # Intercepta o rollback compensatório (DELETE em auth) para não tocar na rede.
    def _fake_delete(url, **kwargs):
        if "/auth/v1/admin/users/" in url:
            admin.deleted.append(url.rsplit("/", 1)[-1])
        return types.SimpleNamespace(status_code=200)

    m.httpx = types.SimpleNamespace(delete=_fake_delete)
    from fastapi.testclient import TestClient

    return TestClient(m.app)


BODY = {
    "email": "nova@empresa.com.br",
    "full_name": "Nova Funcionária",
    "password": "Provisoria123",
    "role": "employee",
    "cpf": "123.456.789-09",
    "cargo": "Balconista",
    "escala_tipo": "12x36",
    "ancora": "2026-09-01",
    "expected_min": 660,
}

print("== 1) Funcionário comum NÃO pode cadastrar ==")
adm = FakeAdmin()
r = make_client({"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json={**BODY, "company_id": "c1"}
)
check("employee -> 403", r.status_code == 403)
check("employee: nenhum usuário auth criado", adm.created == [])

print("== 2) Gestor cadastra na PRÓPRIA empresa ==")
adm = FakeAdmin()
r = make_client({"id": MGR, "full_name": "Milena", "role": "manager", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json=BODY
)
check("gestor -> 200", r.status_code == 200)
check("gestor: usuário auth criado", len(adm.created) == 1)
check("gestor: RPC criar_funcionario chamada", adm.rpc_calls and adm.rpc_calls[0][0] == "criar_funcionario")
if adm.rpc_calls:
    args = adm.rpc_calls[0][1]
    check("gestor: manager_id = o próprio gestor", args["p_manager_id"] == MGR)
    check("gestor: empresa = a dele", args["p_company_id"] == "c1")
    check("gestor: papel employee", args["p_role"] == "employee")
    check("gestor: CPF normalizado (só dígitos)", args["p_cpf"] == "12345678909")
    check("gestor: escala 12x36 repassada", args["p_escala_tipo"] == "12x36")

print("== 3) Gestor NÃO cadastra em outra empresa ==")
adm = FakeAdmin()
r = make_client({"id": MGR, "full_name": "Milena", "role": "manager", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json={**BODY, "company_id": "c2"}
)
check("gestor com company_id alheia -> 403", r.status_code == 403)
check("gestor: nada criado no auth", adm.created == [])

print("== 4) Admin escolhe qualquer empresa ==")
adm = FakeAdmin()
r = make_client({"id": ADM, "full_name": "Admin", "role": "company_admin", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json={**BODY, "company_id": "c2"}
)
check("admin em c2 -> 200", r.status_code == 200)
if adm.rpc_calls:
    check("admin: empresa = c2 (escolhida)", adm.rpc_calls[0][1]["p_company_id"] == "c2")
    check("admin: manager_id nulo", adm.rpc_calls[0][1]["p_manager_id"] is None)

print("== 5) system_admin: todas as empresas ==")
adm = FakeAdmin()
r = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json={**BODY, "company_id": "c2"}
)
check("system_admin em c2 -> 200", r.status_code == 200)

print("== 6) Rollback compensatório: RPC falhou -> apaga usuário auth ==")
adm = FakeAdmin(fail_rpc=True)
r = make_client({"id": ADM, "full_name": "Admin", "role": "company_admin", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json={**BODY, "company_id": "c1"}
)
check("RPC ausente -> 503 (orienta rodar a migration)", r.status_code == 503)
check("rollback: usuário auth apagado", adm.deleted == ["new-user-uuid"])

print("== 7) Validações de formulário ==")
adm = FakeAdmin()
cl = make_client({"id": ADM, "full_name": "Admin", "role": "company_admin", "company_id": "c1"}, adm)
r = cl.post("/api/admin/employees", json={**BODY, "company_id": "c1", "cpf": "123"})
check("CPF curto -> 422", r.status_code == 422)
r = cl.post("/api/admin/employees", json={**BODY, "company_id": "c1", "password": "123"})
check("senha curta -> 422", r.status_code == 422)
r = cl.post("/api/admin/employees", json={**BODY, "company_id": "c1", "email": "invalido"})
check("e-mail inválido -> 400/422", r.status_code in (400, 422))
r = cl.post("/api/admin/employees", json={**BODY, "company_id": "c1", "expected_min": 9999})
check("expected_min fora do intervalo -> 422", r.status_code == 422)

print("== 8) /api/companies/options ==")
cl = make_client({"id": MGR, "full_name": "Milena", "role": "manager", "company_id": "c1"}, FakeAdmin())
r = cl.get("/api/companies/options")
check("gestor: options -> 200", r.status_code == 200)
if r.status_code == 200:
    opts = r.json()
    check("gestor: vê apenas a própria empresa", len(opts) == 1 and opts[0]["id"] == "c1")

cl = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, FakeAdmin())
r = cl.get("/api/companies/options")
check("system_admin: options -> 200", r.status_code == 200)
if r.status_code == 200:
    check("system_admin: vê várias empresas", len(r.json()) >= 2)

cl = make_client({"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"}, FakeAdmin())
r = cl.get("/api/companies/options")
check("employee: options -> 403", r.status_code == 403)

print(f"\nRESULTADO: {OK} ok, {FAIL} falha(s)")
sys.exit(1 if FAIL else 0)
