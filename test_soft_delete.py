"""Testes do SOFT DELETE (Ativar/Desativar) de Empresas e Funcionários.

Cobre:
  POST /api/admin/companies/{id}/status     (empresa + cascata nos funcionários)
  POST /api/admin/employees/{id}/status     (funcionário + ban no Auth)
  Guards de acesso (inativo não bate ponto; empresa inativa bloqueia)
  Hierarquia (gestor só na própria empresa; ninguém desativa a si mesmo)

Supabase e auth são substituídos por stubs (sem rede).

Rodar: .venv\\Scripts\\python.exe test_soft_delete.py
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


ADMIN = "00000000-0000-0000-0000-0000000000aa"   # system_admin
MGR = "22222222-0000-0000-0000-0000000000bb"     # company_admin (gestor)
EMP = "11111111-0000-0000-0000-0000000000cc"     # employee da c1
EMP2 = "11111111-0000-0000-0000-0000000000dd"    # employee da c2
C1 = "c1"
C2 = "c2"

COMPANIES = [
    {"id": C1, "nome": "Por do Sol 2 LTDA", "cnpj": "66782325000181", "ativa": True},
    {"id": C2, "nome": "Outra LTDA", "cnpj": "11222333000181", "ativa": True},
]

PROFILES = [
    {"id": ADMIN, "full_name": "Programador", "role": "system_admin", "company_id": C1, "ativo": True},
    {"id": MGR, "full_name": "Milena", "role": "company_admin", "company_id": C1, "ativo": True},
    {"id": EMP, "full_name": "Colab Um", "role": "employee", "company_id": C1, "ativo": True},
    {"id": EMP2, "full_name": "Colab Dois", "role": "employee", "company_id": C2, "ativo": True},
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

    def neq(self, col, val):
        self._filters.append((col + "__ne", val))
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = [dict(r) for r in self.rows]
        for col, val in self._filters:
            if col.endswith("__ne"):
                real = col[:-4]
                rows = [r for r in rows if str(r.get(real)) != str(val)]
            else:
                rows = [r for r in rows if str(r.get(col)) == str(val)]
        if self._limit:
            rows = rows[: self._limit]
        return types.SimpleNamespace(data=rows, count=len(rows))


class Store:
    """Estado mutável compartilhado (profiles/companies) para simular o banco."""

    def __init__(self):
        self.companies = [dict(c) for c in COMPANIES]
        self.profiles = [dict(p) for p in PROFILES]
        self.rpc_calls = []

    def table(self, name):
        if name == "companies":
            return FakeQuery(name, self.companies)
        if name == "profiles":
            return FakeQuery(name, self.profiles)
        return FakeQuery(name, [])

    def get_profile(self, uid):
        for p in self.profiles:
            if p["id"] == uid:
                return p
        return None

    def get_company(self, cid):
        for c in self.companies:
            if c["id"] == cid:
                return c
        return None


class FakeAdmin:
    def __init__(self, store, rpc_error=None):
        self.store = store
        self.rpc_error = rpc_error
        self.auth = types.SimpleNamespace(admin=self)
        self.banned = []  # (user_id, banned)
        self.logouts = []

    def rpc(self, fn, args):
        self.store.rpc_calls.append((fn, args))
        store = self.store
        rpc_error = self.rpc_error

        class _Exec:
            def execute(_self):
                if rpc_error:
                    raise RuntimeError(rpc_error)
                if fn == "atualizar_funcionario_status":
                    p = store.get_profile(args["p_user_id"])
                    if not p:
                        raise RuntimeError("Funcionário não encontrado.")
                    p["ativo"] = bool(args["p_ativo"])
                    return types.SimpleNamespace(data=dict(p))
                if fn == "atualizar_empresa_status":
                    c = store.get_company(args["p_company_id"])
                    if not c:
                        raise RuntimeError("Empresa não encontrada.")
                    ativa = bool(args["p_ativa"])
                    c["ativa"] = ativa
                    afetados = 0
                    for p in store.profiles:
                        if str(p.get("company_id")) != str(args["p_company_id"]):
                            continue
                        if not ativa and p["ativo"] is True:
                            p["ativo"] = False
                            p["reativar_em_cascata"] = True
                            afetados += 1
                        elif ativa and p.get("reativar_em_cascata"):
                            p["ativo"] = True
                            p["reativar_em_cascata"] = False
                            afetados += 1
                    return types.SimpleNamespace(
                        data={"company": dict(c), "funcionarios_afetados": afetados, "cascata": True}
                    )
                return types.SimpleNamespace(data={})

        return _Exec()

    def table(self, name):
        return self.store.table(name)


def fake_resolve_auth(store, me):
    def _inner(request, authorization, x_company_id=None):
        prof = dict(me)
        prof.setdefault("active_company_id", prof.get("company_id"))
        prof.setdefault("is_switched", False)
        prof.setdefault("companies", [])
        return store.table("__"), prof, "jwt"

    return _inner


def make_client(store, me, admin):
    m.resolve_auth = fake_resolve_auth(store, me)
    m.rate_limit = lambda *a, **k: None  # noqa: ARG005
    m.sb_admin = admin
    m.sb_base = store

    def _fake_put(url, **kwargs):
        if "/auth/v1/admin/users/" in url:
            uid = url.rsplit("/", 1)[-1]
            ban = (kwargs.get("json") or {}).get("ban_duration")
            admin.banned.append((uid, ban != "none" and ban is not None))
        return types.SimpleNamespace(status_code=200)

    def _fake_post(url, **kwargs):
        if "/logout" in url:
            admin.logouts.append(url)
        return types.SimpleNamespace(status_code=200)

    m.httpx = types.SimpleNamespace(put=_fake_put, post=_fake_post, delete=lambda *a, **k: types.SimpleNamespace(status_code=200))
    from fastapi.testclient import TestClient

    return TestClient(m.app)


ADMIN_ME = {"id": ADMIN, "role": "system_admin", "company_id": C1}
MGR_ME = {"id": MGR, "role": "company_admin", "company_id": C1}
EMP_ME = {"id": EMP, "role": "employee", "company_id": C1}


print("== 1) Admin DESATIVA uma empresa (cascata nos funcionários) ==")
store = Store()
admin = FakeAdmin(store)
cli = make_client(store, ADMIN_ME, admin)
r = cli.post(f"/api/admin/companies/{C1}/status", json={"ativo": False, "cascata": True})
check("HTTP 200", r.status_code == 200)
check("empresa ficou inativa", store.get_company(C1)["ativa"] is False)
check("funcionário EMP foi inativado", store.get_profile(EMP)["ativo"] is False)
check("marca reativar_em_cascata=true", store.get_profile(EMP).get("reativar_em_cascata") is True)
check("funcionário de OUTRA empresa não foi tocado", store.get_profile(EMP2)["ativo"] is True)
check("ban aplicado no Auth", any(u == EMP and b for u, b in admin.banned))
check("revogou sessões (logout)", len(admin.logouts) >= 1)

print("\n== 2) Admin REATIVA a empresa (só quem a cascata desligou volta) ==")
# Inativa manualmente o MGR por conta própria ANTES de reativar a empresa:
store.get_profile(MGR)["ativo"] = False
store.get_profile(MGR)["reativar_em_cascata"] = False
admin.banned.clear()
r = cli.post(f"/api/admin/companies/{C1}/status", json={"ativo": True, "cascata": True})
check("HTTP 200", r.status_code == 200)
check("empresa voltou a ativa", store.get_company(C1)["ativa"] is True)
check("EMP (cascata) foi reativado", store.get_profile(EMP)["ativo"] is True)
check("MGR (inativo manual) CONTINUA inativo", store.get_profile(MGR)["ativo"] is False)
check("EMP desbanido no Auth", any(u == EMP and not b for u, b in admin.banned))
check("MGR segue banido (não foi desbanido)", not any(u == MGR and not b for u, b in admin.banned))

print("\n== 3) Admin DESATIVA um funcionário (soft delete + ban) ==")
admin.banned.clear()
r = cli.post(f"/api/admin/employees/{EMP}/status", json={"ativo": False})
check("HTTP 200", r.status_code == 200)
check("profiles.ativo=false", store.get_profile(EMP)["ativo"] is False)
check("ban aplicado", any(u == EMP and b for u, b in admin.banned))
# Reativar
admin.banned.clear()
r = cli.post(f"/api/admin/employees/{EMP}/status", json={"ativo": True})
check("reativar -> HTTP 200", r.status_code == 200)
check("profiles.ativo=true", store.get_profile(EMP)["ativo"] is True)
check("desbanido", any(u == EMP and not b for u, b in admin.banned))

print("\n== 4) Ninguém desativa a si mesmo ==")
r = cli.post(f"/api/admin/employees/{ADMIN}/status", json={"ativo": False})
check("HTTP 400 (auto-lockout bloqueado)", r.status_code == 400)

print("\n== 5) Gestor só mexe em funcionário da PRÓPRIA empresa ==")
cli_mgr = make_client(store, MGR_ME, admin)
r = cli_mgr.post(f"/api/admin/employees/{EMP}/status", json={"ativo": False})
check("gestor desativa subordinado da própria empresa -> 200", r.status_code == 200)
store.get_profile(EMP)["ativo"] = True  # restaura
r = cli_mgr.post(f"/api/admin/employees/{EMP2}/status", json={"ativo": False})
check("gestor NÃO desativa funcionário de outra empresa -> 403", r.status_code == 403)

print("\n== 6) Gestor NÃO altera status de empresa (só Admin) ==")
r = cli_mgr.post(f"/api/admin/companies/{C1}/status", json={"ativo": False, "cascata": True})
check("HTTP 403", r.status_code == 403)

print("\n== 7) Migration ausente -> 503 orientando ==")
store2 = Store()
admin2 = FakeAdmin(store2, rpc_error="function public.atualizar_empresa_status(...) does not exist")
cli2 = make_client(store2, ADMIN_ME, admin2)
r = cli2.post(f"/api/admin/companies/{C1}/status", json={"ativo": False})
check("HTTP 503", r.status_code == 503)
check("mensagem cita a migration", "migration_soft_delete" in r.json().get("detail", ""))

print("\n== 8) Funcionário INATIVO não bate ponto ==")
store3 = Store()
admin3 = FakeAdmin(store3)
inactive_me = {"id": EMP, "role": "employee", "company_id": C1, "ativo": False}
cli3 = make_client(store3, inactive_me, admin3)
r = cli3.post("/api/clock", json={"type": "in", "lat": -15.7, "lon": -47.9})
check("HTTP 403", r.status_code == 403)
check("mensagem menciona inativo", "inativo" in r.json().get("detail", "").lower())

print("\n== 9) Empresa INATIVA bloqueia o ponto de todos ==")
store4 = Store()
admin4 = FakeAdmin(store4)
comp_inativa = {"id": EMP, "role": "employee", "company_id": C1, "ativo": True, "company_ativa": False}
cli4 = make_client(store4, comp_inativa, admin4)
r = cli4.post("/api/clock", json={"type": "in", "lat": -15.7, "lon": -47.9})
check("HTTP 403", r.status_code == 403)
check("mensagem menciona empresa", "empresa" in r.json().get("detail", "").lower())

print("\n== 10) Helpers de status reconhecem ausência da coluna (pré-migração) ==")
check("profile_is_active(None) -> None", m.profile_is_active(None) is None)
check("profile_is_active({}) -> None", m.profile_is_active({}) is None)
check("profile_is_active(ativo=False) -> False", m.profile_is_active({"ativo": False}) is False)
check("profile_is_active(ativo=True) -> True", m.profile_is_active({"ativo": True}) is True)

print(f"\nRESULTADO: {OK} ok, {FAIL} falha(s)")
sys.exit(1 if FAIL else 0)
