import logging
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator
from supabase import Client, create_client

# ----------------------------
# Setup básico
# ----------------------------
load_dotenv()
SUPABASE_URL = os.environ.get("SUPABASE_URL")
# Dashboard novo usa sb_publishable_/sb_secret_; mantém compat com anon/service_role legado.
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_PUBLISHABLE_KEY")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SECRET_KEY")  # opcional

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    raise RuntimeError("Defina SUPABASE_URL e SUPABASE_ANON_KEY no .env")

logger = logging.getLogger("ponto-eletronico")
logging.basicConfig(level=logging.INFO)

BASE_DIR = Path(__file__).resolve().parent

# Build do frontend React (web/dist). Se existir, é servido em "/" com fallback
# para o template Jinja2 legado enquanto o build não for gerado.
WEB_DIST = BASE_DIR.parent / "web" / "dist"
WEB_INDEX = WEB_DIST / "index.html"

sb_base: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
# Service key inválida/ausente não pode derrubar o boot: sync de feriados
# retorna 500 com mensagem clara nesses casos.
try:
    sb_admin: Optional[Client] = (
        create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY) if SUPABASE_SERVICE_KEY else None
    )
except Exception:
    logger.warning("SUPABASE_SERVICE_ROLE/SECRET inválida: sync de feriados desabilitado")
    sb_admin = None

# JWKS para validação local do JWT (P1). Usa a URL do .env ou deriva do projeto.
SUPABASE_JWKS_URL = os.environ.get("SUPABASE_JWKS_URL") or (
    SUPABASE_URL.rstrip("/") + "/auth/v1/.well-known/jwks.json"
)
_jwk_client: Any = None


def _get_jwk_client() -> Any:
    """Singleton PyJWKClient (com cache). None se PyJWT não instalado."""
    global _jwk_client
    if _jwk_client is not None:
        return _jwk_client
    try:
        from jwt import PyJWKClient
    except ImportError:
        return None
    _jwk_client = PyJWKClient(SUPABASE_JWKS_URL, cache_keys=True, max_cached_keys=16)
    return _jwk_client


def validate_jwt_local(token: str) -> tuple[Optional[str], dict]:
    """Valida o access_token localmente via JWKS.

    Retorna (sub, claims) se válido; (None, {}) quando a validação local
    está indisponível/falhou — o chamador cai no `auth.get_user` (server).
    Token expirado vira 401 direto (não adianta consultar o servidor).
    """
    client = _get_jwk_client()
    if client is None:
        return None, {}
    try:
        import jwt as pyjwt

        key = client.get_signing_key_from_jwt(token)
        payload = pyjwt.decode(
            token,
            key.key,
            algorithms=["RS256", "ES256"],
            audience="authenticated",
            options={"verify_exp": True, "verify_aud": True},
        )
        if not isinstance(payload, dict):
            return None, {}
        sub = payload.get("sub")
        return (str(sub) if sub else None), payload
    except HTTPException:
        raise
    except Exception as e:
        if "expired" in str(e).lower():
            raise HTTPException(status_code=401, detail="Sessão expirada, faça login novamente")
        return None, {}


# Rate-limit híbrido: Redis (multi-instância) com fallback em memória (localhost).
# Sem REDIS_URL ou com Redis fora do ar, opera em memória sem derrubar requests.
# Em produção multi-instância, defina REDIS_URL (ex: redis://localhost:6379/0).
_REDIS: Any = None
_REDIS_FAIL_UNTIL = 0.0
_RATE_BUCKETS: dict[tuple[str, str], list[float]] = {}
_RATE_MAX_BUCKETS = 10000


def _get_redis() -> Any:
    """Client Redis singleton. None = indisponível (tenta de novo após 60s)."""
    global _REDIS, _REDIS_FAIL_UNTIL
    if _REDIS is not None:
        return _REDIS
    if time.monotonic() < _REDIS_FAIL_UNTIL:
        return None
    url = (os.environ.get("REDIS_URL") or "").strip()
    if not url:
        return None
    try:
        import redis

        client = redis.Redis.from_url(url, socket_connect_timeout=2, socket_timeout=2, decode_responses=True)
        client.ping()
        _REDIS = client
        logger.info("rate-limit backend: redis")
        return _REDIS
    except Exception as e:
        logger.warning("Redis indisponível (%s): rate-limit em memória", str(e)[:120])
        _REDIS_FAIL_UNTIL = time.monotonic() + 60
        return None


def _rate_limit_memory(scope: str, ident: str, max_hits: int, window_s: int) -> None:
    now = time.monotonic()
    if len(_RATE_BUCKETS) > _RATE_MAX_BUCKETS:
        _RATE_BUCKETS.clear()
    bkey = (scope, ident)
    hits = [t for t in _RATE_BUCKETS.get(bkey, []) if now - t < window_s]
    if len(hits) >= max_hits:
        raise HTTPException(status_code=429, detail="Muitas requisições, tente novamente em instantes")
    hits.append(now)
    _RATE_BUCKETS[bkey] = hits


def _rate_limit_redis(r: Any, scope: str, ident: str, max_hits: int, window_s: int) -> None:
    now = time.time()
    bkey = f"ratelimit:{scope}:{ident}"
    member = f"{now:.6f}:{os.getpid()}"
    pipe = r.pipeline()
    pipe.zremrangebyscore(bkey, 0, now - window_s)
    pipe.zcard(bkey)
    _, count = pipe.execute()
    if int(count) >= max_hits:
        raise HTTPException(status_code=429, detail="Muitas requisições, tente novamente em instantes")
    pipe = r.pipeline()
    pipe.zadd(bkey, {member: now})
    pipe.expire(bkey, int(window_s) + 1)
    pipe.execute()


def rate_limit(request: Request, scope: str, max_hits: int, window_s: int, key: str = "") -> None:
    ident = key or (request.client.host if request.client else "unknown")
    r = _get_redis()
    if r is None:
        _rate_limit_memory(scope, ident, max_hits, window_s)
        return
    try:
        _rate_limit_redis(r, scope, ident, max_hits, window_s)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("rate-limit redis falhou (%s): usando memória", str(e)[:120])
        _rate_limit_memory(scope, ident, max_hits, window_s)

MANAGER_ROLES = {"manager", "company_admin", "system_admin", "admin"}
COMPANY_ADMIN_ROLES = {"company_admin", "system_admin", "admin"}
# Perfil "Administrador (Programador/Suporte)": enxerga TODAS as empresas.
SYSTEM_ADMIN_ROLES = {"system_admin", "admin"}
VALID_PUNCH_TYPES = {"in", "out", "break_start", "break_end"}


# ----------------------------
# Helpers de tenant / auth
# ----------------------------
def normalize_cnpj(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def is_valid_cnpj(value: Any) -> bool:
    d = normalize_cnpj(value)
    if len(d) != 14 or re.fullmatch(r"(\d)\1{13}", d):
        return False

    def calc(base: str, weights: list[int]) -> int:
        s = sum(int(b) * w for b, w in zip(base, weights))
        r = s % 11
        return 0 if r < 2 else 11 - r

    d1 = calc(d[:12], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    d2 = calc(d[:12] + str(d1), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    return d1 == int(d[12]) and d2 == int(d[13])


def supabase_with_user(jwt: str) -> Client:
    """Client com JWT do usuário para a RLS considerar auth.uid()."""
    client: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    client.postgrest.auth(jwt)
    return client


def extract_bearer(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    return token


def company_cnpj_of(profile: dict) -> str:
    if not isinstance(profile, dict):
        return ""
    for cand in (
        profile.get("company_cnpj"),
        profile.get("cnpj"),
        (profile.get("company") or {}).get("cnpj")
        if isinstance(profile.get("company"), dict)
        else None,
        (profile.get("companies") or {}).get("cnpj")
        if isinstance(profile.get("companies"), dict)
        else None,
    ):
        n = normalize_cnpj(cand)
        if n:
            return n
    return ""


def company_name_of(profile: dict) -> str:
    if not isinstance(profile, dict):
        return ""
    comp = profile.get("company") or profile.get("companies") or {}
    if isinstance(comp, list) and comp:
        comp = comp[0]
    if isinstance(comp, dict):
        return str(comp.get("nome") or comp.get("name") or profile.get("company_nome") or "")
    return str(profile.get("company_nome") or "")


def company_active_of(profile: dict) -> Optional[bool]:
    """Ativa/inativa da empresa. None = desconhecido (não bloqueia)."""
    if not isinstance(profile, dict):
        return None
    comp = profile.get("company") or profile.get("companies") or {}
    if isinstance(comp, list) and comp:
        comp = comp[0]
    if isinstance(comp, dict) and "ativa" in comp:
        return None if comp.get("ativa") is None else bool(comp.get("ativa"))
    v = profile.get("company_ativa")
    return None if v is None else bool(v)


def user_safe_error(exc: Exception, fallback: str) -> str:
    """Expõe só mensagens seguras (triggers de negócio); resto vira genérico."""
    msg = str(exc)
    if "5 minutos" in msg or "batida" in msg.lower():
        return "Já existe uma batida nos últimos 5 minutos"
    if "CNPJ" in msg and len(msg) < 200:
        return msg
    logger.exception("supabase error: %s", msg[:500])
    return fallback


# ----------------------------
# Multi-empresa (migration_multi_company.sql)
# ----------------------------
def _default_company_entry(me: dict) -> dict:
    """Entrada de empresa padrão do profile (fallback pré/pós-migração)."""
    return {
        "id": me.get("company_id"),
        "cnpj": company_cnpj_of(me),
        "nome": company_name_of(me),
        "ativa": company_active_of(me),
        "role_in_company": me.get("role"),
    }


def _membership_of(me: dict) -> list[dict]:
    """Todas as empresas do usuário via user_companies (multi-tenant §12).

    Usa service key: o backend é a autoridade de associação (namespace
    multi-empresa não cabe na RLS ancorada em profiles.company_id).
    Pré-migração (tabela ausente) -> fallback: só a empresa padrão.
    """
    if sb_admin is None:
        return [_default_company_entry(me)]
    try:
        res = (
            sb_admin.table("user_companies")
            .select("company_id,role_in_company,created_at,companies(cnpj,nome,ativa)")
            .eq("user_id", me["id"])
            .order("created_at")
            .execute()
        )
        rows = res.data or []
    except Exception:
        logger.warning("user_companies indisponível (pré-migração?): fallback single-company")
        return [_default_company_entry(me)]
    comps = []
    for r in rows:
        comp = r.get("companies") or {}
        comps.append(
            {
                "id": r["company_id"],
                "cnpj": normalize_cnpj(comp.get("cnpj")),
                "nome": comp.get("nome"),
                "ativa": comp.get("ativa") if comp.get("ativa") is not None else True,
                "role_in_company": r.get("role_in_company"),
            }
        )
    return comps or [_default_company_entry(me)]


def _resolve_active_company(me: dict, x_company_id: Optional[str]) -> tuple[str, bool]:
    """Resolve a empresa ativa do request.

    Retorna (company_id ativa, switched?) — switched=True significa que o
    usuário pediu uma empresa DIFERENTE da padrão (exige service key + escopo
    explícito em toda query). Header inválido = 403 (anti cross-tenant oracle).
    """
    default = str(me.get("company_id") or "")
    ids = {str(c.get("id")) for c in (me.get("companies") or []) if c.get("id")}
    req = (x_company_id or "").strip()
    if req:
        if req not in ids:
            raise HTTPException(status_code=403, detail="Você não tem acesso a esta empresa")
        if req != default:
            return req, True
    return default, False


def _apply_active_company(prof: dict, active: str) -> None:
    """Alinha os campos flat (company_id, cnpj, nome, ativa) à empresa ATIVA."""
    for c in prof.get("companies") or []:
        if str(c.get("id")) == active:
            prof["company_id"] = active
            prof["company_cnpj"] = normalize_cnpj(c.get("cnpj"))
            prof["company_nome"] = c.get("nome")
            prof["company_ativa"] = c.get("ativa", True)
            break


def _company_scope(me: dict) -> Optional[str]:
    """company_id p/ filtro EXPLÍCITO quando a RLS não garante o escopo.

    - Em modo switched (service key em uso): sempre filtra (RLS fora).
    - system_admin no tenant padrão: RLS cobre tudo -> None (sem filtro).
    """
    if me.get("is_switched") or me.get("role") != "system_admin":
        return me.get("company_id")
    return None


def fetch_profile(sb: Client, user_id: str) -> dict:
    """Busca profile + empresa (schema multi-tenant §3-§9 obrigatório)."""
    try:
        res = (
            sb.table("profiles")
            .select("id,full_name,role,manager_id,company_id,companies(cnpj,nome,ativa)")
            .eq("id", user_id)
            .single()
            .execute()
        )
        prof = res.data or {}
    except Exception as e:
        raise HTTPException(status_code=404, detail="Profile not found") from e
    if not prof:
        raise HTTPException(status_code=404, detail="Profile not found")
    # Normaliza: expõe company_cnpj/company_nome/company_ativa flat para o frontend
    companies = prof.get("companies")
    if isinstance(companies, list) and companies:
        companies = companies[0]
    if isinstance(companies, dict):
        prof["company"] = {
            "cnpj": companies.get("cnpj"),
            "nome": companies.get("nome"),
            "ativa": companies.get("ativa"),
        }
        prof["company_cnpj"] = normalize_cnpj(companies.get("cnpj"))
        prof["company_nome"] = companies.get("nome")
        prof["company_ativa"] = companies.get("ativa")
    return prof


def resolve_auth(
    request: Request,
    authorization: Optional[str],
    x_company_id: Optional[str] = None,
) -> tuple[Client, dict, str]:
    """Middleware de tenant: JWT validado -> profile -> empresa ativa.

    Identidade vem do JWT (100% servidor). O tenant PADRÃO vem do
    profile.company_id; gestores multi-empresa podem alternar a empresa
    ATIVA por request via header X-Company-ID (validado contra user_companies).
    Em modo switched o client retornado usa service key (a RLS ancorada em
    profiles.company_id não cobre a empresa alternada) e todas as queries
    ganham filtro explícito de company_id via _company_scope().
    """
    jwt = extract_bearer(authorization)
    sb = supabase_with_user(jwt)
    # P1: validação local economiza 1 roundtrip ao Auth por request.
    # (None, {}) = indisponível/falhou -> valida no servidor.
    user_id, claims = validate_jwt_local(jwt)
    if user_id is None:
        try:
            user = sb.auth.get_user(jwt).user
        except Exception as e:
            logger.exception("get_user failed")
            raise HTTPException(status_code=401, detail="Token inválido") from e
        if not user:
            raise HTTPException(status_code=401, detail="Token inválido")
        user_id = user.id
        claims = {}

    prof = fetch_profile(sb, user_id)

    # Exceções de roteamento: sem empresa ou empresa desativada
    if not prof.get("company_id"):
        raise HTTPException(status_code=403, detail="Usuário sem empresa vinculada")
    if company_active_of(prof) is False:
        raise HTTPException(status_code=403, detail="Empresa desativada, contate o suporte")

    # Claims do hook (quando o plano tem Auth Hooks): divergência = sessão obsoleta.
    # Tokens sem claims (hook desligado) passam — a RLS + profile continuam valendo.
    if claims.get("company_id") and str(claims["company_id"]) != str(prof.get("company_id")):
        raise HTTPException(status_code=401, detail="Sessão desatualizada, faça login novamente")

    # Multi-empresa: associação completa + empresa ativa do request
    need_membership = bool(x_company_id) or prof.get("role") in MANAGER_ROLES
    prof["companies"] = _membership_of(prof) if need_membership else [_default_company_entry(prof)]
    active, switched = _resolve_active_company(prof, x_company_id)
    prof["active_company_id"] = active
    prof["is_switched"] = switched
    _apply_active_company(prof, active)

    client: Client = sb
    if switched:
        if sb_admin is None:
            raise HTTPException(
                status_code=500,
                detail="Configure SUPABASE_SERVICE_ROLE/SECRET_KEY no .env para alternar de empresa",
            )
        client = sb_admin
    return client, prof, jwt


# ----------------------------
# Schemas (validação de entrada)
# ----------------------------
class ClockIn(BaseModel):
    type: Literal["in", "out", "break_start", "break_end"]
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lon: Optional[float] = Field(default=None, ge=-180, le=180)
    accuracy: Optional[float] = Field(default=None, ge=0, le=100000)


class PunchUpdate(BaseModel):
    id: int
    note: Optional[str] = Field(default=None, max_length=500)
    occurred_at: Optional[datetime] = None
    # Regra de Ouro (legalidade): toda alteração exige justificativa que acompanha o log.
    justificativa: Optional[str] = Field(default=None, max_length=500)

    @field_validator("occurred_at")
    @classmethod
    def _check_occurred_at(cls, v: Optional[datetime]) -> Optional[datetime]:
        if v is None:
            return v
        if v.tzinfo is None:
            raise ValueError("occurred_at exige timezone (ISO-8601 com offset, ex: 2026-09-21T08:00:00-03:00)")
        now = datetime.now(timezone.utc)
        if v > now + timedelta(minutes=5):
            raise ValueError("occurred_at não pode ser no futuro")
        if v < now - timedelta(days=365):
            raise ValueError("occurred_at fora da janela editável (máx. 365 dias)")
        return v


class PunchApprove(BaseModel):
    id: int
    decision: Literal["approved", "rejected"]
    justificativa: Optional[str] = Field(default=None, max_length=500)


class HolidayCreate(BaseModel):
    date: date
    name: str = Field(min_length=2, max_length=120)
    kind: Literal["state", "city", "company", "optional"] = "company"


# ----------------------------
# App / Static / Templates
# ----------------------------
app = FastAPI(title="Ponto Eletrônico SaaS")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local + mobile (Bearer, sem cookies); restrinja domínios em produção
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*", "X-Tenant-CNPJ", "X-Company-ID"],
)

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


# Assets do build React (web/dist/assets). Rota em vez de mount para resolver
# em tempo de requisição: funciona mesmo se o build for feito depois do boot.
@app.get("/assets/{asset_path:path}")
def web_assets(asset_path: str):
    assets_dir = (WEB_DIST / "assets").resolve()
    try:
        target = (assets_dir / asset_path).resolve()
    except ValueError:
        raise HTTPException(status_code=404) from None
    if not target.is_file() or not target.is_relative_to(assets_dir):
        raise HTTPException(status_code=404)
    return FileResponse(target)


@app.get("/api/health")
def health():
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat()}


# Config pública consumida pelo frontend React (URL + chave anon — pública por design).
@app.get("/api/config")
def api_config():
    return {"supabase_url": SUPABASE_URL, "supabase_anon_key": SUPABASE_ANON_KEY}


# Alguns monitores/abas usam "/health" (sem /api) — alias para não gerar 404.
@app.get("/health")
def health_alias():
    return health()


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if WEB_INDEX.is_file():
        return FileResponse(WEB_INDEX, media_type="text/html")
    return templates.TemplateResponse(
        request,
        "index.html",
        {"SUPABASE_URL": SUPABASE_URL, "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY},
    )


@app.get("/reset", response_class=HTMLResponse)
def reset_page(request: Request):
    """Página de redefinição de senha (destino do link de recovery)."""
    return templates.TemplateResponse(
        request,
        "reset.html",
        {"SUPABASE_URL": SUPABASE_URL, "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY},
    )


# ----------------------------
# API pública: resolver empresa por CNPJ (p/ login)
# ----------------------------
@app.get("/api/resolve-company")
def api_resolve_company(request: Request, cnpj: str = ""):
    # S5: endpoint anônimo enumerável -> 30/min por IP.
    rate_limit(request, "resolve-company", 30, 60)
    digits = normalize_cnpj(cnpj)
    if not is_valid_cnpj(digits):
        raise HTTPException(status_code=400, detail="CNPJ inválido (checksum)")
    try:
        res = sb_base.rpc("get_company_by_cnpj", {"p_cnpj": digits}).execute()
        data = res.data
        row = data[0] if isinstance(data, list) and data else data
        if not row:
            raise HTTPException(status_code=404, detail="Empresa não encontrada")
        if isinstance(row, dict) and row.get("ativa") is False:
            raise HTTPException(status_code=403, detail="Empresa inativa")
        return {"ok": True, "company": {"nome": row.get("nome")}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao resolver empresa")) from e


# ----------------------------
# API - perfil
# ----------------------------
@app.get("/api/me")
def api_me(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    _, prof, _ = resolve_auth(request, authorization, x_company_id)
    prof["company_cnpj"] = company_cnpj_of(prof)
    prof["company_nome"] = company_name_of(prof)
    prof["company_ativa"] = company_active_of(prof)
    prof["companies"] = prof.get("companies") or [_default_company_entry(prof)]
    prof.pop("active_company_id", None)
    prof.pop("is_switched", None)
    return prof


class ForgotPassword(BaseModel):
    email: str = Field(min_length=5, max_length=254)


class InviteUser(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    full_name: str = Field(min_length=2, max_length=120)
    role: Literal["manager", "employee"] = "employee"


def _valid_email(value: str) -> str:
    email = str(value or "").strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(status_code=400, detail="E-mail inválido")
    return email


@app.post("/api/auth/forgot-password")
def api_forgot_password(payload: ForgotPassword, request: Request):
    """Dispara e-mail de redefinição. Sempre 200 (anti-enumeração de contas)."""
    rate_limit(request, "forgot-password", 5, 3600)
    email = _valid_email(payload.email)
    try:
        # O Supabase envia o link com redirect para a Site URL do painel.
        # Configure em Auth -> URL Configuration: Site URL + Redirect URLs (ex: http://localhost:8000/reset).
        sb_base.auth.reset_password_for_email(email)
    except Exception:
        logger.exception("forgot-password failed")
    return {"ok": True}


@app.post("/api/auth/invite")
def api_invite(
    payload: InviteUser,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """RH convida funcionário: e-mail com link para definir a senha inicial.

    O user_metadata carrega company_id, e o trigger handle_new_user vincula
    o profile à empresa automaticamente. Exige service key válida.
    """
    _, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_company_admin(me)
    rate_limit(request, "invite", 10, 3600, key=str(me["id"]))
    if sb_admin is None:
        raise HTTPException(
            status_code=500,
            detail="Configure SUPABASE_SERVICE_ROLE_KEY no .env para convidar usuários",
        )
    email = _valid_email(payload.email)
    try:
        sb_admin.auth.admin.invite_user_by_email(
            email,
            options={
                "data": {
                    "full_name": payload.full_name.strip(),
                    "company_id": me["company_id"],
                    "role": payload.role,
                }
            },
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao enviar convite")) from e
    return {"ok": True}


# ----------------------------
# API - pontos do próprio usuário
# ----------------------------
@app.get("/api/my-punches")
def api_my_punches(
    request: Request,
    limit: int = 50,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    limit = max(1, min(limit, 100))
    try:
        q = sb.table("punches").select("*")
        cs = _company_scope(me)
        if cs:
            q = q.eq("company_id", cs)
        res = q.order("occurred_at", desc=True).limit(limit).execute()
        return JSONResponse(res.data or [])
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar pontos")) from e


@app.post("/api/clock")
def api_clock(
    payload: ClockIn,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    # Perfil Admin (Programador/Suporte) não bate ponto: os botões ficam
    # ocultos no front e esta guarda protege a API também (defesa em
    # profundidade — só o relógio/leitura interessa para esse perfil).
    if me.get("role") in SYSTEM_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Administrador/Suporte não registra ponto")
    # S6: anti-spam de batida via API (20/min por usuário; trigger cobre o resto).
    rate_limit(request, "clock", 20, 60, key=str(me["id"]))
    body = {
        "user_id": me["id"],
        "p_type": payload.type,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "latitude": payload.lat,
        "longitude": payload.lon,
        "accuracy": payload.accuracy,
        "source": "web",
        "created_by": me["id"],
    }
    # company_id é preenchido pelo trigger fill_punch_company; enviar também
    # quando conhecido acelera e documenta o tenant (coluna é NOT NULL).
    if me.get("company_id"):
        body["company_id"] = me["company_id"]
    try:
        data = sb.table("punches").insert(body).execute().data
        return {"ok": True, "punch": data[0] if data else None}
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Erro ao registrar ponto")) from e


# ----------------------------
# API - gestor / admin da empresa
# ----------------------------
def _require_manager(prof: dict) -> None:
    if prof.get("role") not in MANAGER_ROLES:
        raise HTTPException(status_code=403, detail="Somente manager/admin")


def _require_system_admin(prof: dict) -> None:
    """Middleware de perfil Admin (Programador/Suporte): enxerga todas as empresas."""
    if prof.get("role") not in SYSTEM_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Somente admin do sistema")


@app.get("/api/team")
def api_team(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_manager(me)
    role = me.get("role")
    cs = _company_scope(me)
    try:
        if role == "system_admin":
            q = sb.table("profiles").select("id,full_name,role,manager_id,company_id").neq("id", me["id"])
            if cs:
                q = q.eq("company_id", cs)
            data = q.limit(200).execute().data
        elif role in COMPANY_ADMIN_ROLES:
            # Tenta escopo por empresa; cai para legado se coluna não existir
            try:
                data = (
                    sb.table("profiles")
                    .select("id,full_name,role,manager_id,company_id")
                    .eq("company_id", (cs or me["company_id"]))
                    .neq("id", me["id"])
                    .limit(200)
                    .execute()
                    .data
                )
            except Exception:
                data = (
                    sb.table("profiles")
                    .select("id,full_name,role,manager_id")
                    .neq("id", me["id"])
                    .limit(200)
                    .execute()
                    .data
                )
        else:  # manager: só subordinados diretos (RLS já restringe)
            q = sb.table("profiles").select("id,full_name,role,manager_id,company_id").eq("manager_id", me["id"])
            if cs:
                q = q.eq("company_id", cs)
            data = q.execute().data
        return data or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar equipe")) from e


def _parse_filter_dt(value: Optional[str], name: str) -> Optional[str]:
    if not value:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Filtro {name} inválido (use ISO-8601)") from e
    return value


@app.get("/api/team-punches")
def api_team_punches(
    request: Request,
    user_id: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 20,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_manager(me)
    limit = max(1, min(limit, 100))
    start = _parse_filter_dt(start, "start")
    end = _parse_filter_dt(end, "end")
    if start and end and start > end:
        raise HTTPException(status_code=400, detail="Filtro start deve ser anterior ao end")

    # Se filtrar por colaborador, garante mesma empresa (anti cross-tenant oracle)
    if user_id and me.get("role") != "system_admin" and me.get("company_id"):
        try:
            target = (
                sb.table("profiles")
                .select("id,company_id")
                .eq("id", user_id)
                .single()
                .execute()
                .data
            )
        except Exception:
            target = None
        if not target or target.get("company_id") != me.get("company_id"):
            raise HTTPException(status_code=403, detail="Colaborador fora da sua empresa")

    try:
        q = sb.table("punches").select("*")
        cs = _company_scope(me)
        if cs:
            q = q.eq("company_id", cs)
        if user_id:
            q = q.eq("user_id", user_id)
        if start:
            q = q.gte("occurred_at", start)
        if end:
            q = q.lte("occurred_at", end)
        data = q.order("occurred_at", desc=True).limit(limit).execute().data
        return data or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar pontos")) from e


def _get_punch_or_403(sb: Client, punch_id: int, me: dict) -> dict:
    try:
        row = sb.table("punches").select("*").eq("id", punch_id).single().execute().data
    except Exception:
        row = None
    if not row:
        raise HTTPException(status_code=404, detail="Punch não encontrado ou sem permissão")
    if (
        me.get("role") not in ("system_admin", "admin")
        and me.get("company_id")
        and row.get("company_id")
        and row.get("company_id") != me.get("company_id")
    ):
        raise HTTPException(status_code=403, detail="Punch de outra empresa")
    return row


def _rpc_audit(sb: Client, fn: str, params: dict) -> Any:
    """Invoca uma função SQL de auditoria transacional (RPC).

    Garantia do caminho "auditado": o UPDATE do ponto e o INSERT no
    logs_auditoria rodam na MESMA transação dentro do Postgres —
    ou os dois acontecem, ou nenhum (atomicidade).

    - Função inexistente (migração_auditoria_logs.sql ainda não aplicada):
      retorna None -> o chamador usa o caminho legado (trigger punch_audit).
    - Função existente com erro de negócio: relança como HTTP 400 (não mascara).
    """
    if sb is None:
        return None
    try:
        res = sb.rpc(fn, params).execute()
        return res.data
    except Exception as e:
        # PGRST202 = função não existe no banco (migração ainda não aplicada).
        # A checagem é pela mensagem/código, não por .status (nem todo APIError
        # do postgrest expõe `status` de forma confiável).
        msg = str(e).lower()
        if "pgrst202" in msg or ("could not find the function" in msg and "schema cache" in msg):
            logger.warning("Auditoria SQL ausente no banco (RPC %s) — caminho legado ativo", fn)
            return None
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha na operação de auditoria")) from e


def _as_punch(data: Any) -> Optional[dict]:
    """Normaliza o retorno da RPC (jsonb único ou lista) para um dict de ponto."""
    if isinstance(data, list):
        return data[0] if data else None
    if isinstance(data, dict):
        return data
    return None


@app.post("/api/punch-update")
def api_punch_update(
    payload: PunchUpdate,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_manager(me)
    _get_punch_or_403(sb, payload.id, me)

    occurred = payload.occurred_at.isoformat() if payload.occurred_at is not None else None

    # 1) Caminho transacional com auditoria legal: update_punch_with_audit(...)
    #    faz UPDATE + INSERT em logs_auditoria na mesma transação do banco,
    #    gravando quem (e-mail + nível de permissão), o quê (antigo/novo) e a
    #    justificativa — funciona também na empresa alternada (multi-empresa).
    updated = _rpc_audit(
        sb,
        "update_punch_with_audit",
        {
            "p_punch_id": payload.id,
            "p_occurred_at": occurred,
            "p_note": payload.note,
            "p_justificativa": payload.justificativa,
            "p_actor_id": me["id"],
        },
    )
    row = _as_punch(updated)
    if row:
        return {"ok": True, "punch": row}

    # 2) Fallback pré-migração (função SQL não aplicada): update direto, com o
    #    trigger punch_audit continuando a registrar old/new/actor.
    patch: dict[str, Any] = {
        "edited_by": me["id"],
        "edited_at": datetime.now(timezone.utc).isoformat(),
    }
    if payload.note is not None:
        patch["note"] = payload.note
    if occurred is not None:
        patch["occurred_at"] = occurred

    try:
        updated = sb.table("punches").update(patch).eq("id", payload.id).execute().data
        if not updated:
            raise HTTPException(status_code=404, detail="Punch não encontrado ou sem permissão")
        return {"ok": True, "punch": updated[0]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao atualizar")) from e


@app.post("/api/punch-approve")
def api_punch_approve(
    payload: PunchApprove,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_manager(me)
    _get_punch_or_403(sb, payload.id, me)

    now_iso = datetime.now(timezone.utc).isoformat()

    # 1) Caminho transacional com auditoria legal: aprovação/recusa + log na
    #    mesma transação (funciona também na empresa alternada / multi-empresa).
    approved = _rpc_audit(
        sb,
        "approve_punch_with_audit",
        {
            "p_punch_id": payload.id,
            "p_decision": payload.decision,
            "p_justificativa": payload.justificativa,
            "p_actor_id": me["id"],
        },
    )
    row = _as_punch(approved)
    if row:
        return {"ok": True, "punch": row}

    # 2) Fallback pré-migração (função SQL não aplicada).
    patch = {
        "approval_status": payload.decision,
        "approved_by": me["id"],
        "approved_at": now_iso,
        "edited_by": me["id"],
        "edited_at": now_iso,
    }
    try:
        updated = sb.table("punches").update(patch).eq("id", payload.id).execute().data
        if not updated:
            raise HTTPException(status_code=404, detail="Punch não encontrado ou sem permissão")
        return {"ok": True, "punch": updated[0]}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao aprovar/rejeitar")) from e


# ----------------------------
# API - painel do Administrador (Programador/Suporte)
# Instituições/Empresas por CNPJ -> árvore de colaboradores -> pontos + logs.
# Toda alteração feita aqui passa por /api/punch-update e /api/punch-approve,
# que gravam o log de auditoria (logs_auditoria).
# ----------------------------
@app.get("/api/admin/companies")
def api_admin_companies(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Lista todas as Instituições/Empresas cadastradas por CNPJ (Admin)."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_system_admin(me)
    src = sb_admin if sb_admin is not None else sb
    try:
        data = (
            src.table("companies")
            .select("id,cnpj,nome,ativa,created_at")
            .order("nome")
            .limit(100)
            .execute()
            .data
        )
        out = []
        for c in data or []:
            colab = None
            try:
                res = (
                    src.table("profiles")
                    .select("id", count="exact")
                    .eq("company_id", c.get("id"))
                    .execute()
                )
                colab = res.count
            except Exception:
                colab = None
            out.append(
                {
                    "id": c.get("id"),
                    "cnpj": normalize_cnpj(c.get("cnpj")),
                    "nome": c.get("nome"),
                    "ativa": c.get("ativa", True),
                    "created_at": c.get("created_at"),
                    "colaborador_count": colab,
                }
            )
        return out
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar empresas")) from e


@app.get("/api/admin/companies/{company_id}/team")
def api_admin_company_team(
    company_id: str,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Árvore de colaboradores atrelados a um CNPJ (Admin)."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_system_admin(me)
    src = sb_admin if sb_admin is not None else sb
    try:
        comp = (
            src.table("companies")
            .select("id,nome,cnpj,ativa")
            .eq("id", company_id)
            .single()
            .execute()
            .data
        )
    except Exception:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")
    if not comp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")

    try:
        profiles = (
            src.table("profiles")
            .select("id,full_name,role,manager_id,company_id")
            .eq("company_id", company_id)
            .order("full_name")
            .limit(500)
            .execute()
            .data
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar equipe")) from e

    # E-mails: auth.users só é legível com service key (best-effort).
    # Usa o Admin API do GoTrue (/auth/v1/admin/users) — confiável com service key.
    emails: dict[str, str] = {}
    if sb_admin is not None and profiles:
        try:
            uids = {p["id"] for p in profiles}
            r = httpx.get(
                f"{SUPABASE_URL}/auth/v1/admin/users?per_page=1000",
                headers={"apikey": SUPABASE_SERVICE_KEY, "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"},
                timeout=15.0,
            )
            if r.status_code == 200:
                body = r.json()
                users = body.get("users", body) if isinstance(body, dict) else body
                for u in users or []:
                    if isinstance(u, dict) and u.get("id") in uids:
                        emails[u["id"]] = u.get("email") or ""
        except Exception:
            logger.warning("Falha ao resolver e-mails via Admin API (service key?)")
    for p in profiles or []:
        p["email"] = emails.get(p.get("id"))

    return {"company": comp, "team": profiles or []}


@app.get("/api/admin/companies/{company_id}/punches")
def api_admin_company_punches(
    company_id: str,
    request: Request,
    user_id: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 50,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Pontos de colaboradores de um CNPJ (Admin), com edição via /api/punch-update."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_system_admin(me)
    src = sb_admin if sb_admin is not None else sb
    limit = max(1, min(limit, 200))
    start = _parse_filter_dt(start, "start")
    end = _parse_filter_dt(end, "end")
    try:
        q = src.table("punches").select("*").eq("company_id", company_id)
        if user_id:
            q = q.eq("user_id", user_id)
        if start:
            q = q.gte("occurred_at", start)
        if end:
            q = q.lte("occurred_at", end)
        data = q.order("occurred_at", desc=True).limit(limit).execute().data
        return data or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar pontos")) from e


@app.get("/api/admin/companies/{company_id}/logs")
def api_admin_company_logs(
    company_id: str,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Histórico de auditoria de uma empresa (Admin/gestor com acesso).

    serve os logs_auditoria (função transacional) com e-mail, permissão,
    valores antigo/novo e justificativa; pré-migração cai no punch_audit.
    """
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_manager(me)
    ids = {str(c.get("id")) for c in (me.get("companies") or []) if c.get("id")}
    if me.get("role") not in SYSTEM_ADMIN_ROLES and company_id not in ids:
        raise HTTPException(status_code=403, detail="Sem acesso aos logs desta empresa")

    logs = _rpc_audit(sb, "get_audit_logs", {"p_empresa_id": company_id})
    if logs is not None:
        return logs if isinstance(logs, list) else [logs]

    # Fallback pré-migração: punch_audit da empresa (old/new/actor/created_at).
    try:
        src = sb
        if me.get("is_switched") and sb_admin is not None:
            src = sb_admin
        rows = (
            src.table("punch_audit")
            .select("punch_id,action,old_row,new_row,actor,company_id,at")
            .eq("company_id", company_id)
            .order("at", desc=True)
            .limit(500)
            .execute()
            .data
        )
        return rows or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao consultar auditoria")) from e


# ----------------------------
# API - feriados (BrasilAPI + locais por empresa)
# ----------------------------
BRASILAPI_URL = "https://brasilapi.com.br/api/feriados/v1/{year}"
HOLIDAY_KINDS = {"national", "state", "city", "company", "optional"}


def _require_company_admin(prof: dict) -> None:
    if prof.get("role") not in COMPANY_ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Somente admin da empresa")


def fetch_brasilapi_holidays(year: int) -> list[dict]:
    """Busca feriados nacionais na BrasilAPI (gratuita, sem token)."""
    try:
        r = httpx.get(BRASILAPI_URL.format(year=year), timeout=15.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail="Falha ao contatar BrasilAPI") from e
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"BrasilAPI retornou {r.status_code}")
    try:
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail="Resposta inválida da BrasilAPI") from e
    if not isinstance(data, list):
        raise HTTPException(status_code=502, detail="Resposta inválida da BrasilAPI")
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        d, name = item.get("date"), (item.get("name") or "").strip()
        kind = (item.get("type") or "national").strip().lower()
        if kind not in HOLIDAY_KINDS:
            kind = "national"
        try:
            date.fromisoformat(str(d))
        except Exception:
            continue
        if d and name:
            out.append({"date": str(d), "name": name[:120], "kind": kind})
    return out


@app.get("/api/holidays")
def api_holidays(
    request: Request,
    year: int = 2026,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Lista nacionais (company_id NULL) + locais da empresa ativa."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Ano inválido")
    try:
        q = (
            sb.table("holidays")
            .select("id,company_id,h_date,name,kind,source,active")
            .gte("h_date", f"{year}-01-01")
            .lte("h_date", f"{year}-12-31")
            .eq("active", True)
        )
        cs = _company_scope(me)
        if cs:
            q = q.or_(f"company_id.is.null,company_id.eq.{cs}")
        res = q.order("h_date").execute()
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar feriados")) from e


@app.post("/api/holidays/sync")
def api_holidays_sync(
    request: Request,
    year: int = 2026,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Sincroniza nacionais da BrasilAPI. Exige SERVICE_ROLE (bypass RLS p/ company_id NULL)."""
    _, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_company_admin(me)
    # Sync é caro e global: 5/hora por admin.
    rate_limit(request, "holidays-sync", 5, 3600, key=str(me["id"]))
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="Ano inválido")
    if sb_admin is None:
        raise HTTPException(
            status_code=500,
            detail="Configure SUPABASE_SERVICE_ROLE_KEY no .env para sincronizar nacionais",
        )
    items = fetch_brasilapi_holidays(year)
    # P2 (batch): 1 SELECT dos nacionais do ano + 1 INSERT em massa +
    # UPDATE só nas linhas que mudaram (normalmente zero após o 1º sync).
    # Antes: 2 queries por feriado (~24/ano).
    try:
        existing = (
            sb_admin.table("holidays")
            .select("id,h_date,name,kind")
            .is_("company_id", "null")
            .gte("h_date", f"{year}-01-01")
            .lte("h_date", f"{year}-12-31")
            .execute()
            .data
        ) or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao ler feriados")) from e
    by_date = {r["h_date"]: r for r in existing if r.get("h_date")}
    to_insert: list[dict] = []
    to_update: list[tuple[int, dict]] = []
    for it in items:
        row = {
            "company_id": None,
            "h_date": it["date"],
            "name": it["name"],
            "kind": it["kind"],
            "source": "brasilapi",
            "active": True,
        }
        cur = by_date.get(it["date"])
        if cur is None:
            to_insert.append(row)
        elif cur.get("name") != row["name"] or cur.get("kind") != row["kind"]:
            to_update.append((cur["id"], row))
    created, updated = 0, 0
    try:
        if to_insert:
            sb_admin.table("holidays").insert(to_insert).execute()
            created = len(to_insert)
        for hid, row in to_update:
            sb_admin.table("holidays").update(row).eq("id", hid).execute()
            updated += 1
    except Exception as e:
        logger.exception("holiday sync write failed: %s", str(e)[:300])
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao gravar feriados")) from e
    return {"ok": True, "year": year, "created": created, "updated": updated, "total": len(items)}


@app.post("/api/holidays")
def api_holidays_create(
    payload: HolidayCreate,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Cadastra feriado local da empresa (ex: DF 30/11 Dia do Evangélico)."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_company_admin(me)
    if not me.get("company_id"):
        raise HTTPException(status_code=400, detail="Perfil sem empresa")
    try:
        data = (
            sb.table("holidays")
            .insert(
                {
                    "company_id": me["company_id"],
                    "h_date": payload.date.isoformat(),
                    "name": payload.name.strip(),
                    "kind": payload.kind,
                    "source": "manual",
                    "active": True,
                }
            )
            .execute()
            .data
        )
        return {"ok": True, "holiday": data[0] if data else None}
    except Exception as e:
        msg = str(e).lower()
        if "duplicate" in msg or "unique" in msg or "ux_holidays" in msg:
            raise HTTPException(status_code=409, detail="Já existe feriado nesta data") from e
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao criar feriado")) from e


@app.delete("/api/holidays/{holiday_id}")
def api_holidays_delete(
    holiday_id: int,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_company_admin(me)
    try:
        row = sb.table("holidays").select("*").eq("id", holiday_id).single().execute().data
    except Exception:
        row = None
    if not row:
        raise HTTPException(status_code=404, detail="Feriado não encontrado ou sem permissão")
    # Nacional (NULL) só system_admin remove; local só da própria empresa
    if row.get("company_id") is None and me.get("role") != "system_admin":
        raise HTTPException(status_code=403, detail="Só system_admin remove feriado nacional")
    if row.get("company_id") and row.get("company_id") != me.get("company_id"):
        raise HTTPException(status_code=403, detail="Feriado de outra empresa")
    try:
        sb.table("holidays").delete().eq("id", holiday_id).execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao excluir")) from e


# ----------------------------
# API - folha (jornada, fechamento, espelho) — B7
# ----------------------------
# Fuso fixo -03:00 (horário de Brasília; sem horário de verão desde 2019).
TZ_SP = timezone(timedelta(hours=-3))


class PayrollClose(BaseModel):
    period_start: date
    period_end: date

    @field_validator("period_end")
    @classmethod
    def _check_period(cls, v: date, info: Any) -> date:
        start = (info.data or {}).get("period_start")
        if start and v < start:
            raise ValueError("period_end deve ser >= period_start")
        if start and (v - start).days > 62:
            raise ValueError("período máximo de 62 dias")
        return v


def _parse_day(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"{name} inválida (use AAAA-MM-DD)") from e


def _pair_day_punches(day_punches: list[dict]) -> tuple[int, bool]:
    """Emparelha batidas do dia. Retorna (minutos trabalhados, incompleto?).

    Regras: in abre, out fecha e soma o bruto; break_start/break_end desconta
    a pausa do acumulado. in sem out, out sem in ou break órfão marcam o dia
    como incompleto para revisão do gestor (sem inventar horas).
    """
    worked = 0
    open_in: Optional[datetime] = None
    on_break = False
    break_start: Optional[datetime] = None
    incomplete = False
    for p in sorted(day_punches, key=lambda x: x["ts"]):
        t, ts = p["type"], p["ts"]
        if t == "in":
            if open_in is not None:
                incomplete = True
            open_in = ts
            on_break = False
            break_start = None
        elif t == "out":
            if open_in is None:
                incomplete = True
            else:
                worked += int((ts - open_in).total_seconds() // 60)
                open_in = None
            on_break = False
            break_start = None
        elif t == "break_start":
            if open_in is not None and not on_break:
                on_break = True
                break_start = ts
            else:
                incomplete = True
        elif t == "break_end":
            if on_break and break_start is not None:
                worked -= int((ts - break_start).total_seconds() // 60)
                on_break = False
                break_start = None
            else:
                incomplete = True
    if open_in is not None or on_break:
        incomplete = True
    return max(worked, 0), incomplete


def _compute_timesheet(
    punches: list[dict],
    holiday_dates: set[str],
    start_d: date,
    end_d: date,
    expected_daily_min: int,
) -> tuple[list[dict], dict]:
    """Calcula jornada dia a dia. Rejeitados não contam; pendentes contam e sinalizam."""
    by_day: dict[str, list[dict]] = {}
    for p in punches or []:
        if (p.get("approval_status") or "pending") == "rejected":
            continue
        try:
            ts = datetime.fromisoformat(str(p["occurred_at"]).replace("Z", "+00:00"))
        except Exception:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        local = ts.astimezone(TZ_SP)
        if not (start_d <= local.date() <= end_d):
            continue
        by_day.setdefault(local.date().isoformat(), []).append(
            {"type": p.get("p_type"), "ts": ts, "pending": (p.get("approval_status") or "pending") == "pending"}
        )
    days: list[dict] = []
    t_worked = t_expected = t_ot = t_def = 0
    has_pending = has_incomplete = False
    cur = start_d
    while cur <= end_d:
        key = cur.isoformat()
        is_weekend = cur.weekday() >= 5
        is_holiday = key in holiday_dates
        expected = 0 if (is_weekend or is_holiday) else expected_daily_min
        day_list = by_day.get(key, [])
        if not day_list:
            worked, incomplete = 0, False
            status = "holiday" if is_holiday else ("weekend" if is_weekend else "absent")
        else:
            worked, incomplete = _pair_day_punches(day_list)
            status = "incomplete" if incomplete else "ok"
        pending = any(d["pending"] for d in day_list)
        has_pending = has_pending or pending
        has_incomplete = has_incomplete or incomplete
        ot = max(0, worked - expected)
        deficit = max(0, expected - worked)
        t_worked += worked
        t_expected += expected
        t_ot += ot
        t_def += deficit
        days.append(
            {
                "date": key,
                "weekday": cur.weekday(),
                "holiday": is_holiday,
                "expected_min": expected,
                "worked_min": worked,
                "overtime_min": ot,
                "deficit_min": deficit,
                "status": status,
                "pending": pending,
                "punches": len(day_list),
            }
        )
        cur += timedelta(days=1)
    totals = {
        "expected_min": t_expected,
        "worked_min": t_worked,
        "overtime_min": t_ot,
        "deficit_min": t_def,
        "balance_min": t_worked - t_expected,
        "has_pending": has_pending,
        "has_incomplete": has_incomplete,
    }
    return days, totals


def _timesheet_for_user(
    sb: Client, me: dict, target_id: str, start_d: date, end_d: date, expected_daily_min: int, company_id: Optional[str] = None
) -> dict:
    if (end_d - start_d).days > 62:
        raise HTTPException(status_code=400, detail="Período máximo de 62 dias")
    try:
        q = (
            sb.table("punches")
            .select("p_type,occurred_at,approval_status")
            .eq("user_id", target_id)
        )
        if company_id:
            q = q.eq("company_id", company_id)
        punches = (
            q.gte("occurred_at", datetime(start_d.year, start_d.month, start_d.day, tzinfo=timezone.utc).isoformat())
            .lt("occurred_at", datetime(end_d.year, end_d.month, end_d.day, tzinfo=timezone.utc).isoformat())
            .order("occurred_at")
            .limit(5000)
            .execute()
            .data
        ) or []
        hq = (
            sb.table("holidays")
            .select("h_date")
            .gte("h_date", start_d.isoformat())
            .lte("h_date", end_d.isoformat())
            .eq("active", True)
        )
        if company_id:
            hq = hq.or_(f"company_id.is.null,company_id.eq.{company_id}")
        hols = hq.execute().data or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao calcular jornada")) from e
    holiday_dates = {h["h_date"] for h in hols if h.get("h_date")}
    days, totals = _compute_timesheet(punches, holiday_dates, start_d, end_d, expected_daily_min)
    return {"user_id": target_id, "period": {"start": start_d.isoformat(), "end": end_d.isoformat()}, "days": days, "totals": totals}


@app.get("/api/timesheet")
def api_timesheet(
    request: Request,
    user_id: Optional[str] = None,
    start: str = "",
    end: str = "",
    expected_daily_min: int = 480,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Jornada calculada. Sem user_id = próprio (espelho do funcionário)."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    if not start or not end:
        raise HTTPException(status_code=400, detail="Informe start e end (AAAA-MM-DD)")
    start_d, end_d = _parse_day(start, "start"), _parse_day(end, "end")
    if start_d > end_d:
        raise HTTPException(status_code=400, detail="start deve ser anterior ao end")
    expected_daily_min = max(0, min(expected_daily_min, 1440))
    target = user_id or me["id"]
    if target != me["id"]:
        _require_manager(me)
        if me.get("role") != "system_admin" and me.get("company_id"):
            try:
                t = sb.table("profiles").select("id,company_id").eq("id", target).single().execute().data
            except Exception:
                t = None
            if not t or t.get("company_id") != me.get("company_id"):
                raise HTTPException(status_code=403, detail="Colaborador fora da sua empresa")
    return _timesheet_for_user(sb, me, target, start_d, end_d, expected_daily_min, _company_scope(me))


@app.get("/api/mirror")
def api_mirror(
    request: Request,
    start: str = "",
    end: str = "",
    expected_daily_min: int = 480,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Espelho de ponto do próprio usuário (cabeçalho + jornada)."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    if not start or not end:
        raise HTTPException(status_code=400, detail="Informe start e end (AAAA-MM-DD)")
    start_d, end_d = _parse_day(start, "start"), _parse_day(end, "end")
    if start_d > end_d:
        raise HTTPException(status_code=400, detail="start deve ser anterior ao end")
    expected_daily_min = max(0, min(expected_daily_min, 1440))
    sheet = _timesheet_for_user(sb, me, me["id"], start_d, end_d, expected_daily_min, _company_scope(me))
    sheet["employee"] = {"full_name": me.get("full_name"), "role": me.get("role")}
    sheet["company"] = {"cnpj": company_cnpj_of(me), "nome": company_name_of(me)}
    return sheet


@app.post("/api/payroll/close")
def api_payroll_close(
    payload: PayrollClose,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Fecha a folha do período: snapshot por colaborador da empresa."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_company_admin(me)
    if not me.get("company_id"):
        raise HTTPException(status_code=400, detail="Perfil sem empresa")
    rate_limit(request, "payroll-close", 10, 3600, key=str(me["id"]))
    start_d, end_d = payload.period_start, payload.period_end
    cs = _company_scope(me)
    try:
        team = (
            sb.table("profiles")
            .select("id,full_name,role")
            .eq("company_id", me["company_id"])
            .limit(500)
            .execute()
            .data
        ) or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar equipe")) from e
    totals = []
    for member in team:
        sheet = _timesheet_for_user(sb, me, member["id"], start_d, end_d, 480, cs)
        totals.append(
            {
                "user_id": member["id"],
                "full_name": member.get("full_name"),
                "role": member.get("role"),
                **sheet["totals"],
            }
        )
    row = {
        "company_id": me["company_id"],
        "period_start": start_d.isoformat(),
        "period_end": end_d.isoformat(),
        "status": "closed",
        "totals": totals,
        "closed_by": me["id"],
    }
    try:
        data = sb.table("payroll_closings").upsert(row, on_conflict="company_id,period_start,period_end").execute().data
        return {"ok": True, "closing": data[0] if data else row}
    except Exception as e:
        msg = str(e).lower()
        if "duplicate" in msg or "unique" in msg or "ux_closings" in msg:
            raise HTTPException(status_code=409, detail="Período já fechado") from e
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao fechar folha")) from e


@app.get("/api/payroll/closings")
def api_payroll_closings(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Lista fechamentos da empresa (RLS filtra; gestor vê, admin gerencia)."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    if me.get("role") not in MANAGER_ROLES:
        raise HTTPException(status_code=403, detail="Somente manager/admin")
    try:
        q = (
            sb.table("payroll_closings")
            .select("id,period_start,period_end,status,closed_by,created_at")
        )
        cs = _company_scope(me)
        if cs:
            q = q.eq("company_id", cs)
        res = q.order("period_start", desc=True).limit(60).execute()
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar fechamentos")) from e
