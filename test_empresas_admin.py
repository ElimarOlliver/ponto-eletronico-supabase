"""Testes do cadastro de EMPRESA e do fluxo drill-down do Admin.

Cobre:
  POST /api/admin/companies        (cadastro transacional via RPC criar_empresa)
  GET  /api/admin/companies/{id}   (ficha cadastral da loja)
  GET  /api/admin/companies        (catálogo com endereço estruturado)
  POST /api/admin/employees        (company_id herdado + manager_id do Admin)

Supabase e auth são substituídos por stubs (sem rede).

Rodar: .venv\\Scripts\\python.exe test_empresas_admin.py
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


EMP = "11111111-0000-0000-0000-000000000001"
MGR = "22222222-0000-0000-0000-000000000002"
PLAT = "44444444-0000-0000-0000-000000000004"
CNPJ1 = "66782325000181"

COMPANIES = [
    {
        "id": "c1",
        "nome": "Por do Sol 2 LTDA",
        "nome_fantasia": "Por do Sol 2",
        "cnpj": CNPJ1,
        "ativa": True,
        "cep": "70000000",
        "logradouro": "Rua das Flores",
        "numero": "100",
        "bairro": "Centro",
        "cidade": "Brasilia",
        "uf": "DF",
        "endereco": "Rua das Flores, 100 - Centro - Brasilia/DF - CEP 70000000",
    },
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
        return types.SimpleNamespace(data=rows, count=len(rows))


class FakeClient:
    def table(self, name):
        if name == "companies":
            return FakeQuery(name, [dict(c) for c in COMPANIES])
        if name == "profiles":
            return FakeQuery(name, [{"id": MGR, "company_id": "c1", "full_name": "Milena"}])
        return FakeQuery(name, [])


class FakeAdmin:
    def __init__(self, fail_rpc=False, rpc_error=None):
        self.fail_rpc = fail_rpc
        self.rpc_error = rpc_error
        self.deleted = []
        self.created = []
        self.rpc_calls = []
        self.auth = types.SimpleNamespace(admin=self)

    def create_user(self, payload):
        self.created.append(payload)
        return types.SimpleNamespace(user=types.SimpleNamespace(id="new-user-uuid"))

    def rpc(self, fn, args):
        self.rpc_calls.append((fn, args))
        fail_rpc = self.fail_rpc
        rpc_error = self.rpc_error
        should_fail = fail_rpc or bool(rpc_error)

        class _Exec:
            def execute(_self):
                if should_fail:
                    raise RuntimeError(rpc_error or 'function public.criar_empresa(...) does not exist')
                if fn == "criar_empresa":
                    return types.SimpleNamespace(
                        data={**COMPANIES[0], "cnpj": args["p_cnpj"], "nome": args["p_nome"]}
                    )
                return types.SimpleNamespace(data={"profile": {"id": args.get("p_user_id")}})

        return _Exec()

    def table(self, name):
        return FakeClient().table(name)


def fake_resolve_auth(me):
    def _inner(request, authorization, x_company_id=None):
        prof = dict(me)
        prof.setdefault("active_company_id", prof.get("company_id"))
        prof.setdefault("is_switched", False)
        prof.setdefault("companies", [dict(c) for c in COMPANIES if c["id"] == me.get("company_id")])
        return FakeClient(), prof, "jwt"

    return _inner


def make_client(me, admin):
    m.resolve_auth = fake_resolve_auth(me)
    m.rate_limit = lambda *a, **k: None  # noqa: ARG005
    m.sb_admin = admin

    def _fake_delete(url, **kwargs):
        if "/auth/v1/admin/users/" in url:
            admin.deleted.append(url.rsplit("/", 1)[-1])
        return types.SimpleNamespace(status_code=200)

    m.httpx = types.SimpleNamespace(delete=_fake_delete)
    from fastapi.testclient import TestClient

    return TestClient(m.app)


COMPANY_BODY = {
    "cnpj": "11.222.333/0001-81",
    "nome": "Farmacia Nova LTDA",
    "nome_fantasia": "Farmacia Nova",
    "cep": "70000-000",
    "logradouro": "Rua das Flores",
    "numero": "100",
    "bairro": "Centro",
    "cidade": "Brasilia",
    "uf": "df",
}

print("== 1) Hierarquia: quem pode cadastrar empresa ==")
adm = FakeAdmin()
r = make_client({"id": EMP, "full_name": "Edenilza", "role": "employee", "company_id": "c1"}, adm).post(
    "/api/admin/companies", json=COMPANY_BODY
)
check("employee -> 403", r.status_code == 403)
check("employee: nada criado", adm.created == [] and adm.rpc_calls == [])

adm = FakeAdmin()
r = make_client({"id": MGR, "full_name": "Milena", "role": "manager", "company_id": "c1"}, adm).post(
    "/api/admin/companies", json=COMPANY_BODY
)
check("gestor -> 403 (só Super Admin cadastra empresas)", r.status_code == 403)
check("gestor: RPC não chamada", adm.rpc_calls == [])

print("== 2) system_admin cadastra empresa (RPC transacional) ==")
adm = FakeAdmin()
r = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm).post(
    "/api/admin/companies", json=COMPANY_BODY
)
check("system_admin -> 200", r.status_code == 200)
check("RPC criar_empresa chamada", adm.rpc_calls and adm.rpc_calls[0][0] == "criar_empresa")
if adm.rpc_calls:
    args = adm.rpc_calls[0][1]
    check("CNPJ normalizado (só dígitos)", args["p_cnpj"] == "11222333000181")
    check("UF maiúscula", args["p_uf"] == "DF")
    check("CEP só dígitos", args["p_cep"] == "70000000")
if r.status_code == 200:
    body = r.json()
    check("resposta ok=true", body.get("ok") is True)
    check("empresa retornada com id", bool(body.get("empresa", {}).get("id")))

print("== 3) Validações de CNPJ / endereço ==")
adm = FakeAdmin()
cl = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm)
check("CNPJ curto -> 422", cl.post("/api/admin/companies", json={**COMPANY_BODY, "cnpj": "123"}).status_code == 422)
check("UF longa -> 422", cl.post("/api/admin/companies", json={**COMPANY_BODY, "uf": "DFX"}).status_code == 422)
check("CEP curto -> 422", cl.post("/api/admin/companies", json={**COMPANY_BODY, "cep": "123"}).status_code == 422)
check("razão social curta -> 422", cl.post("/api/admin/companies", json={**COMPANY_BODY, "nome": "X"}).status_code == 422)

print("== 4) Erros de negócio da RPC repassados com clareza ==")
adm = FakeAdmin(rpc_error='{"message":"CNPJ inválido (dígitos verificadores não conferem): 11222333000182"}')
r = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm).post(
    "/api/admin/companies", json=COMPANY_BODY
)
check("CNPJ inválido -> 400", r.status_code == 400)
if r.status_code == 400:
    check("mensagem de negócio visível", "CNPJ inválido" in r.json().get("detail", ""))

adm = FakeAdmin(rpc_error='{"message":"Já existe uma empresa cadastrada com este CNPJ (11222333000181)."}')
r = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm).post(
    "/api/admin/companies", json=COMPANY_BODY
)
check("CNPJ duplicado -> 400", r.status_code == 400)
if r.status_code == 400:
    check("mensagem de duplicidade visível", "Já existe" in r.json().get("detail", ""))

print("== 5) RPC ausente -> 503 orientando a migration ==")
adm = FakeAdmin(fail_rpc=True)
r = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm).post(
    "/api/admin/companies", json=COMPANY_BODY
)
check("RPC ausente -> 503", r.status_code == 503)
if r.status_code == 503:
    check("orienta rodar migration_empresas_cadastro.sql", "migration_empresas_cadastro" in r.json().get("detail", ""))

print("== 6) Catálogo de empresas (GET /api/admin/companies) ==")
cl = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, FakeAdmin())
r = cl.get("/api/admin/companies")
check("system_admin: catálogo -> 200", r.status_code == 200)
if r.status_code == 200:
    c = r.json()[0]
    check("catálogo traz nome_fantasia", c.get("nome_fantasia") == "Por do Sol 2")
    check("catálogo traz endereço estruturado", c.get("logradouro") == "Rua das Flores" and c.get("uf") == "DF")
    check("catálogo traz contagem de colaboradores", c.get("colaborador_count") is not None)

cl = make_client({"id": MGR, "full_name": "Milena", "role": "manager", "company_id": "c1"}, FakeAdmin())
check("gestor: catálogo de empresas -> 403", cl.get("/api/admin/companies").status_code == 403)

print("== 7) Ficha cadastral (GET /api/admin/companies/{id}) ==")
cl = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, FakeAdmin())
r = cl.get("/api/admin/companies/c1")
check("detalhe -> 200", r.status_code == 200)
if r.status_code == 200:
    d = r.json()
    check("detalhe: razão social", d.get("nome") == "Por do Sol 2 LTDA")
    check("detalhe: cidade/UF", d.get("cidade") == "Brasilia" and d.get("uf") == "DF")
r = cl.get("/api/admin/companies/nao-existe")
check("detalhe inexistente -> 404", r.status_code == 404)

print("== 8) Drill-down: Admin cadastra funcionário com empresa herdada ==")
adm = FakeAdmin()
BODY = {
    "email": "nova@empresa.com.br",
    "full_name": "Nova Funcionária",
    "password": "Provisoria123",
    "role": "employee",
    "company_id": "c1",
    "manager_id": MGR,
    "escala_tipo": "12x36",
    "ancora": "2026-09-01",
    "expected_min": 660,
}
r = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json=BODY
)
check("system_admin -> 200", r.status_code == 200)
if adm.rpc_calls:
    args = adm.rpc_calls[0][1]
    check("empresa herdada = c1", args["p_company_id"] == "c1")
    check("gestor responsável repassado", args["p_manager_id"] == MGR)

print("== 9) Admin escolhendo gestor de OUTRA empresa -> bloqueado ==")
adm = FakeAdmin()
r = make_client({"id": PLAT, "full_name": "Suporte", "role": "system_admin", "company_id": "c1"}, adm).post(
    "/api/admin/employees", json={**BODY, "manager_id": "gestor-de-outra-empresa"}
)
check("gestor fora da empresa -> 400", r.status_code == 400)
check("nada criado no auth", adm.created == [])

print(f"\nRESULTADO: {OK} ok, {FAIL} falha(s)")
sys.exit(1 if FAIL else 0)
