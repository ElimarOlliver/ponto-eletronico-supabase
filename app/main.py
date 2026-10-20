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
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
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
            .select("company_id,role_in_company,created_at,companies!user_companies_company_id_fkey(cnpj,nome,ativa)")
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
            .select("id,full_name,role,manager_id,company_id,ativo,companies!profiles_company_id_fkey(cnpj,nome,ativa)")
            .eq("id", user_id)
            .single()
            .execute()
        )
        prof = res.data or {}
    except Exception as e:
        # Fallback pré-migração: 'ativo' pode não existir ainda.
        try:
            res = (
                sb.table("profiles")
                .select("id,full_name,role,manager_id,company_id,companies!profiles_company_id_fkey(cnpj,nome,ativa)")
                .eq("id", user_id)
                .single()
                .execute()
            )
            prof = res.data or {}
        except Exception as e2:
            raise HTTPException(status_code=404, detail="Profile not found") from e2
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
    # Soft delete: funcionário inativo não acessa NADA (nem ler o próprio ponto).
    if profile_is_active(prof) is False:
        raise HTTPException(status_code=403, detail="Usuário inativo, contate o administrador")

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
    # Regra de Ouro (legalidade): justificativa OBRIGATÓRIA (mín. 10) — a RPC
    # transacional grava a mesma justificativa no logs_auditoria. Sem ela a
    # alteração é rejeitada com 422 e NADA é gravado (nem ponto, nem log).
    justificativa: str = Field(min_length=10, max_length=500)

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
    # Regra de Ouro (legalidade): mesma exigência do PunchUpdate (mín. 10).
    justificativa: str = Field(min_length=10, max_length=500)


class HolidayCreate(BaseModel):
    date: date
    name: str = Field(min_length=2, max_length=120)
    kind: Literal["state", "city", "company", "optional"] = "company"


# ----------------------------
# App / Static / Templates
# ----------------------------
app = FastAPI(title="Ponto Eletrônico SaaS", docs_url=None, redoc_url=None, openapi_url=None)

# CORS restrito: em produção defina ALLOWED_ORIGINS no .env (lista separada por
# vírgula, ex: https://app.seudominio.com). Sem a variável, cai para localhost —
# nunca libera "*" (um site qualquer poderia ler respostas autenticadas do gestor).
_allowed_origins = [o.strip() for o in (os.environ.get("ALLOWED_ORIGINS") or "").split(",") if o.strip()]
if not _allowed_origins:
    _allowed_origins = [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*", "X-Tenant-CNPJ", "X-Company-ID"],
)

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# CSP: só o próprio domínio + o Supabase (REST/Realtime), os tiles do mapa e as
# fontes. Origens fixas desta aplicação (Leaflet/OSM, Tailwind CDN, Google Fonts,
# BrasilAPI). Se trocar de provedor de mapa/CDN, ajuste aqui.
_SUPABASE_ORIGIN = (SUPABASE_URL or "").rstrip("/")
_CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.tailwindcss.com https://unpkg.com 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; "
    "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; "
    "connect-src 'self' " + _SUPABASE_ORIGIN + " https://*.supabase.co wss://*.supabase.co "
    "https://brasilapi.com.br https://tile.openstreetmap.org https://*.tile.openstreetmap.org; "
    "font-src 'self' data: https://fonts.gstatic.com; "
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
)


@app.middleware("http")
async def security_and_audit(request: Request, call_next):
    """Cabeçalhos de segurança + registro de acesso negado (401/403/429).

    Nunca loga corpo/headers de credencial: apenas status, rota e IP — o
    suficiente para enxergar varredura/força bruta sem vazar segredo.
    """
    resp = await call_next(request)
    resp.headers.setdefault("Content-Security-Policy", _CSP)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    if resp.status_code in (401, 403, 429):
        logger.warning(
            "acesso_negado status=%s rota=%s ip=%s",
            resp.status_code,
            request.url.path,
            request.client.host if request.client else "desconhecido",
        )
    return resp


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


# Estáticos do build React fora de /assets (ex.: /img/logo-pollar.png, favicon).
@app.get("/img/{asset_path:path}")
def web_img(asset_path: str):
    img_dir = (WEB_DIST / "img").resolve()
    try:
        target = (img_dir / asset_path).resolve()
    except ValueError:
        raise HTTPException(status_code=404) from None
    if not target.is_file() or not target.is_relative_to(img_dir):
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


class CreateEmployee(BaseModel):
    """Cadastro de funcionário (Admin/Gestor) — form do painel."""

    email: str = Field(min_length=5, max_length=254)
    full_name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=72)
    role: Literal["employee", "manager"] = "employee"
    # Empresa: Admin escolhe qualquer uma; Gestor é forçado à dele no backend.
    # No fluxo drill-down (Admin dentro de uma loja), o backend recebe o
    # company_id do contexto da página — o formulário não pede a empresa.
    company_id: Optional[str] = None
    # Gestor responsável (Admin pode definir; Gestor = ele mesmo).
    manager_id: Optional[str] = None
    # Dados cadastrais (Anexo II) — opcionais.
    cpf: Optional[str] = None
    pis: Optional[str] = None
    ctps: Optional[str] = None
    cargo: Optional[str] = None
    data_admissao: Optional[date] = None
    # Escala inicial (opcional).
    escala_tipo: Optional[Literal["padrao", "12x36", "personalizada"]] = None
    ancora: Optional[date] = None
    expected_min: Optional[int] = None
    work_days: Optional[list[int]] = None

    @field_validator("cpf")
    @classmethod
    def _check_cpf(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not str(v).strip():
            return None
        d = re.sub(r"\D", "", str(v))
        if len(d) != 11:
            raise ValueError("CPF deve ter 11 dígitos")
        return d

    @field_validator("expected_min")
    @classmethod
    def _check_expected(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return None
        if not (0 <= int(v) <= 1440):
            raise ValueError("expected_min deve estar entre 0 e 1440")
        return int(v)


class CreateCompany(BaseModel):
    """Cadastro de Empresa (tenant) — Admin de plataforma."""

    cnpj: str = Field(min_length=14, max_length=20)
    nome: str = Field(min_length=2, max_length=160)  # Razão Social
    nome_fantasia: Optional[str] = Field(default=None, max_length=160)
    cep: Optional[str] = Field(default=None, max_length=10)
    logradouro: Optional[str] = Field(default=None, max_length=160)
    numero: Optional[str] = Field(default=None, max_length=20)
    bairro: Optional[str] = Field(default=None, max_length=120)
    cidade: Optional[str] = Field(default=None, max_length=120)
    uf: Optional[str] = Field(default=None, max_length=2)

    @field_validator("cnpj")
    @classmethod
    def _check_cnpj(cls, v: str) -> str:
        d = re.sub(r"\D", "", str(v))
        if len(d) != 14:
            raise ValueError("CNPJ deve ter 14 dígitos")
        return d

    @field_validator("uf")
    @classmethod
    def _check_uf(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not str(v).strip():
            return None
        u = re.sub(r"[^A-Za-z]", "", str(v)).upper()
        if len(u) != 2:
            raise ValueError("UF deve ter 2 letras")
        return u

    @field_validator("cep")
    @classmethod
    def _check_cep(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not str(v).strip():
            return None
        d = re.sub(r"\D", "", str(v))
        if len(d) != 8:
            raise ValueError("CEP deve ter 8 dígitos")
        return d


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
# API - cadastro de funcionário (Admin/Gestor)
# ----------------------------
def _admin_delete_user(user_id: str) -> None:
    """Rollback compensatório: remove o usuário auth se a RPC falhar depois."""
    try:
        httpx.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            },
            timeout=15.0,
        )
    except Exception:
        logger.exception("Falha ao desfazer usuário auth %s", user_id)


# Duração do banimento no GoTrue: ~100 anos = "até reativar" (usamos 'none'
# para levantar o ban na reativação). Evita depender de datas absolutas.
_BAN_DURATION = "876000h"


def _admin_set_user_banned(user_id: str, banned: bool) -> None:
    """Bloqueia/libera o login do usuário no Supabase Auth (Admin API/GoTrue).

    - banned=True  : aplica 'ban_duration' longo + revoga sessões (refresh
      tokens) -> o funcionário não loga mais nem mantém a sessão viva.
    - banned=False : remove o ban ('none') ao reativar o funcionário.

    Best-effort: falha aqui NÃO desfaz a inativação no banco (que é a fonte
    da verdade). O backend ainda barra o acesso via profiles.ativo em
    resolve_auth(), então o bloqueio é garantido de qualquer forma.
    """
    if sb_admin is None or not SUPABASE_SERVICE_KEY:
        return
    try:
        if banned:
            # Revoga as sessões ativas primeiro (invalida refresh tokens).
            try:
                httpx.post(
                    f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}/logout",
                    headers={
                        "apikey": SUPABASE_SERVICE_KEY,
                        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                    },
                    timeout=15.0,
                )
            except Exception:
                logger.warning("Falha ao revogar sessões do usuário %s", user_id)
        # GoTrue: PUT /auth/v1/admin/users/{id} com { "ban_duration": "..." }.
        httpx.put(
            f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
            },
            json={"ban_duration": _BAN_DURATION if banned else "none"},
            timeout=15.0,
        )
    except Exception:
        logger.exception("Falha ao %s usuário auth %s", "banir" if banned else "desbanir", user_id)


def profile_is_active(profile: dict) -> Optional[bool]:
    """Ativo do funcionário. None = coluna ausente/pré-migração (não bloqueia)."""
    if not isinstance(profile, dict):
        return None
    v = profile.get("ativo")
    return None if v is None else bool(v)



@app.post("/api/admin/employees")
def api_admin_create_employee(
    payload: CreateEmployee,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Cadastra um funcionário de ponta a ponta, de forma transacional.

    Fluxo:
      1) Autoriza (Admin/RH ou Gestor) e resolve a empresa-alvo.
         - Gestor: SEMPRE a própria empresa (company_id ignorado/validado).
         - Admin : qualquer empresa; usa x_company_id/payload.
      2) Cria o usuário em auth.users (Admin API, service key) já com
         user_metadata {company_id, full_name, must_change_password}.
      3) Chama a RPC public.criar_funcionario(...) que grava profile +
         user_companies + escala numa ÚNICA transação.
      4) Se a RPC falhar, apaga o usuário auth (rollback compensatório).
    """
    _, me, _ = resolve_auth(request, authorization, x_company_id)

    role = me.get("role")
    is_admin = role in COMPANY_ADMIN_ROLES
    is_manager = role == "manager"
    if not (is_admin or is_manager):
        raise HTTPException(status_code=403, detail="Somente Administrador ou Gestor cadastra funcionários")

    if sb_admin is None:
        raise HTTPException(
            status_code=500,
            detail="Configure SUPABASE_SERVICE_ROLE_KEY no .env para cadastrar funcionários",
        )

    rate_limit(request, "create-employee", 20, 3600, key=str(me["id"]))
    email = _valid_email(payload.email)

    # 2) Resolve a empresa-alvo conforme a hierarquia.
    if is_manager and not is_admin:
        # Gestor cadastra só para a própria loja.
        company_id = me.get("company_id")
        if not company_id:
            raise HTTPException(status_code=400, detail="Perfil de gestor sem empresa")
        if payload.company_id and str(payload.company_id) != str(company_id):
            raise HTTPException(status_code=403, detail="Gestor só cadastra na própria empresa")
    else:
        # Admin: empresa do payload/header ou a padrão.
        company_id = payload.company_id or _company_scope(me) or me.get("company_id")
        if not company_id:
            raise HTTPException(status_code=400, detail="Informe a empresa do funcionário")

    # manager_id: gestor -> ele mesmo; admin -> o informado (ou nulo).
    if is_manager and not is_admin:
        manager_id = me["id"]
    else:
        manager_id = payload.manager_id or None
        # Valida que o gestor escolhido pertence à mesma empresa.
        if manager_id:
            try:
                chk = (
                    (sb_admin or sb)
                    .table("profiles")
                    .select("id,company_id")
                    .eq("id", manager_id)
                    .limit(1)
                    .execute()
                    .data
                    or []
                )
            except Exception:
                chk = []
            if not chk or str(chk[0].get("company_id")) != str(company_id):
                raise HTTPException(
                    status_code=400,
                    detail="Gestor responsável não pertence à empresa selecionada",
                )

    # 3) Cria o usuário auth (o trigger handle_new_user faz o esqueleto de profile).
    try:
        created = sb_admin.auth.admin.create_user(
            {
                "email": email,
                "password": payload.password,
                "email_confirm": True,
                "user_metadata": {
                    "full_name": payload.full_name.strip(),
                    "company_id": company_id,
                    "role": payload.role,
                    "must_change_password": True,
                },
            }
        )
    except Exception as e:
        msg = str(e).lower()
        if "already" in msg or "registered" in msg or "exists" in msg:
            raise HTTPException(status_code=409, detail="Já existe um usuário com este e-mail") from e
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao criar usuário")) from e

    new_id = getattr(getattr(created, "user", None), "id", None)
    if not new_id:
        raise HTTPException(status_code=500, detail="Usuário criado sem id retornado")

    # 4) RPC transacional: profile + user_companies + escala (tudo ou nada).
    rpc_args: dict[str, Any] = {
        "p_user_id": new_id,
        "p_company_id": company_id,
        "p_full_name": payload.full_name.strip(),
        "p_role": payload.role,
        "p_manager_id": manager_id,
        "p_cpf": payload.cpf,
        "p_pis": payload.pis,
        "p_ctps": payload.ctps,
        "p_cargo": payload.cargo,
        "p_data_admissao": payload.data_admissao.isoformat() if payload.data_admissao else None,
        "p_escala_tipo": payload.escala_tipo,
        "p_ancora": (payload.ancora or date.today()).isoformat() if payload.escala_tipo else None,
        "p_expected_min": payload.expected_min,
        "p_work_days": payload.work_days,
    }
    try:
        res = sb_admin.rpc("criar_funcionario", rpc_args).execute()
    except Exception as e:
        # Rollback compensatório: sem cadastro consistente, remove o usuário auth.
        _admin_delete_user(new_id)
        msg = str(e)
        if "criar_funcionario" in msg and ("does not exist" in msg or "schema cache" in msg):
            raise HTTPException(
                status_code=503,
                detail="Rode migration_cadastro_funcionario.sql no SQL Editor (função criar_funcionario ausente)",
            ) from e
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao gravar o cadastro")) from e

    return {"ok": True, "user_id": new_id, "email": email, "company_id": company_id, "detalhe": res.data}


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
    # SOFT DELETE: funcionário inativo NÃO bate ponto (o resolve_auth já barra,
    # mas reforçamos aqui — defesa em profundidade explícita na rota do ponto).
    if profile_is_active(me) is False:
        raise HTTPException(
            status_code=403,
            detail="Usuário inativo — registro de ponto bloqueado. Contate o administrador.",
        )
    # SOFT DELETE em cascata: empresa inativa bloqueia o ponto de todos.
    if company_active_of(me) is False:
        raise HTTPException(
            status_code=403,
            detail="Empresa inativa — registro de ponto bloqueado. Contate o suporte.",
        )
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
    # Leitura de equipe: 60/min por usuário (anti-varredura/raspagem de dados).
    rate_limit(request, "team-read", 60, 60, key=str(me["id"]))
    role = me.get("role")
    cs = _company_scope(me)
    try:
        if role == "system_admin":
            q = sb.table("profiles").select("id,full_name,role,manager_id,company_id,ativo").neq("id", me["id"])
            if cs:
                q = q.eq("company_id", cs)
            data = q.limit(200).execute().data
        elif role in COMPANY_ADMIN_ROLES:
            # Tenta escopo por empresa; cai para legado se coluna não existir
            try:
                data = (
                    sb.table("profiles")
                    .select("id,full_name,role,manager_id,company_id,ativo")
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
            q = sb.table("profiles").select("id,full_name,role,manager_id,company_id,ativo").eq("manager_id", me["id"])
            if cs:
                q = q.eq("company_id", cs)
            data = q.execute().data
        for m in data or []:
            if "ativo" in m:
                m["ativo"] = True if m.get("ativo") is None else bool(m.get("ativo"))
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
    # Leitura de pontos da equipe: 60/min por usuário.
    rate_limit(request, "team-read", 60, 60, key=str(me["id"]))
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
    # Escrita de ponto (auditada): 20/min por usuário.
    rate_limit(request, "punch-write", 20, 60, key=str(me["id"]))
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

    # 2) Sem a função transacional NÃO há como gravar a justificativa no
    #    logs_auditoria na mesma transação. Em vez de alterar o ponto sem a
    #    auditoria legal (bypass da Regra de Ouro), recusamos a operação.
    raise HTTPException(
        status_code=503,
        detail=(
            "Auditoria indisponível: aplique migration_auditoria_logs.sql "
            "(update_punch_with_audit) no Supabase. Sem ela, a alteração é "
            "recusada para não ficar sem justificativa registrada."
        ),
    )


@app.post("/api/punch-approve")
def api_punch_approve(
    payload: PunchApprove,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_manager(me)
    # Aprovação/recusa (auditada): 20/min por usuário.
    rate_limit(request, "punch-write", 20, 60, key=str(me["id"]))
    _get_punch_or_403(sb, payload.id, me)

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

    # 2) Sem a função transacional NÃO há como gravar a justificativa no
    #    logs_auditoria na mesma transação. Recusamos para não aprovar/recusar
    #    um ponto sem a auditoria legal (bypass da Regra de Ouro).
    raise HTTPException(
        status_code=503,
        detail=(
            "Auditoria indisponível: aplique migration_auditoria_logs.sql "
            "(approve_punch_with_audit) no Supabase. Sem ela, a operação é "
            "recusada para não ficar sem justificativa registrada."
        ),
    )


# ----------------------------
# API - painel do Administrador (Programador/Suporte)
# Instituições/Empresas por CNPJ -> árvore de colaboradores -> pontos + logs.
# Toda alteração feita aqui passa por /api/punch-update e /api/punch-approve,
# que gravam o log de auditoria (logs_auditoria).
# ----------------------------
def _company_public(c: dict, colab: Optional[int]) -> dict:
    """Formata uma empresa para o front (endereço estruturado + texto)."""
    c = c or {}
    return {
        "id": c.get("id"),
        "cnpj": normalize_cnpj(c.get("cnpj")),
        "nome": c.get("nome"),
        "nome_fantasia": c.get("nome_fantasia"),
        "ativa": c.get("ativa", True),
        "created_at": c.get("created_at"),
        "colaborador_count": colab,
        "cep": c.get("cep"),
        "logradouro": c.get("logradouro"),
        "numero": c.get("numero"),
        "bairro": c.get("bairro"),
        "cidade": c.get("cidade"),
        "uf": c.get("uf"),
        "endereco": c.get("endereco"),
    }


def _rpc_message(raw: str) -> str:
    """Extrai a mensagem de negócio de um erro do PostgREST/PLpgSQL."""
    msg = str(raw or "")
    # PostgREST devolve algo como: {... "message":"CNPJ inválido ..."}.
    m = re.search(r'"message"\s*:\s*"([^"]+)"', msg)
    if m:
        return m.group(1)
    # PL/pgSQL puro: pega a última linha não vazia.
    lines = [ln.strip() for ln in msg.splitlines() if ln.strip()]
    return lines[-1] if lines else "Falha ao cadastrar empresa"


@app.get("/api/companies/options")
def api_company_options(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Empresas que o usuário (Admin/Gestor) pode escolher ao cadastrar.

    - system_admin: todas.
    - company_admin: as empresas dele (me.companies).
    - manager: só a própria.
    Retorna o formato mínimo para o <select>.
    """
    _, me, _ = resolve_auth(request, authorization, x_company_id)
    role = me.get("role")
    if role not in MANAGER_ROLES:
        raise HTTPException(status_code=403, detail="Somente Administrador ou Gestor")
    if role in SYSTEM_ADMIN_ROLES:
        src = sb_admin if sb_admin is not None else sb
        try:
            data = (
                src.table("companies")
                .select("id,cnpj,nome,ativa")
                .order("nome")
                .limit(200)
                .execute()
                .data
            ) or []
        except Exception as e:
            raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar empresas")) from e
        return [
            {"id": c.get("id"), "cnpj": normalize_cnpj(c.get("cnpj")), "nome": c.get("nome")}
            for c in data
        ]
    # company_admin/manager: suas empresas (fallback: a padrão).
    comps = me.get("companies") or []
    out = [
        {"id": c.get("id"), "cnpj": normalize_cnpj(c.get("cnpj")), "nome": c.get("nome")}
        for c in comps
        if c.get("id")
    ]
    if not out and me.get("company_id"):
        out = [{"id": me["company_id"], "cnpj": company_cnpj_of(me), "nome": company_name_of(me)}]
    return out


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
            .select(
                "id,cnpj,nome,nome_fantasia,ativa,created_at,"
                "cep,logradouro,numero,bairro,cidade,uf,endereco"
            )
            .order("nome")
            .limit(200)
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
            out.append(_company_public(c, colab))
        return out
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar empresas")) from e


@app.get("/api/admin/companies/{company_id}")
def api_admin_company_detail(
    company_id: str,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Ficha cadastral completa de uma empresa (Admin) — cabeçalho da loja."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_system_admin(me)
    rate_limit(request, "admin-read", 60, 60, key=str(me["id"]))
    src = sb_admin if sb_admin is not None else sb
    try:
        rows = (
            src.table("companies")
            .select(
                "id,cnpj,nome,nome_fantasia,ativa,created_at,"
                "cep,logradouro,numero,bairro,cidade,uf,endereco"
            )
            .eq("id", company_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not rows:
            raise HTTPException(status_code=404, detail="Empresa não encontrada")
        return _company_public(rows[0], None)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao carregar empresa")) from e


@app.post("/api/admin/companies")
def api_admin_create_company(
    payload: CreateCompany,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Cadastra uma Empresa (tenant) de forma transacional (Super Admin).

    Valida CNPJ (14 dígitos + dígitos verificadores) e duplicidade na RPC
    public.criar_empresa(...); o endereço estruturado também alimenta o
    texto livre companies.endereco (usado no Espelho de Ponto).
    """
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_system_admin(me)
    if sb_admin is None:
        raise HTTPException(
            status_code=500,
            detail="Configure SUPABASE_SERVICE_ROLE_KEY no .env para cadastrar empresas",
        )
    rate_limit(request, "create-company", 20, 3600, key=str(me["id"]))

    args = {
        "p_cnpj": payload.cnpj,
        "p_nome": payload.nome.strip(),
        "p_nome_fantasia": payload.nome_fantasia,
        "p_cep": payload.cep,
        "p_logradouro": payload.logradouro,
        "p_numero": payload.numero,
        "p_bairro": payload.bairro,
        "p_cidade": payload.cidade,
        "p_uf": payload.uf,
    }
    try:
        res = sb_admin.rpc("criar_empresa", args).execute()
    except Exception as e:
        msg = str(e)
        if "criar_empresa" in msg and ("does not exist" in msg or "schema cache" in msg):
            raise HTTPException(
                status_code=503,
                detail="Rode migration_empresas_cadastro.sql no SQL Editor (função criar_empresa ausente)",
            ) from e
        # Repassa mensagens de negócio (CNPJ inválido/duplicado) com clareza.
        if "CNPJ" in msg or "empresa" in msg.lower():
            raise HTTPException(status_code=400, detail=_rpc_message(msg)) from e
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao cadastrar empresa")) from e

    created = res.data if isinstance(res.data, dict) else (res.data or [{}])[0]
    return {"ok": True, "empresa": _company_public(created, 0)}


class StatusUpdate(BaseModel):
    """Payload de ativar/desativar (soft delete)."""

    ativo: bool
    # Cascata: aplica também aos funcionários (default true) — usado só na empresa.
    cascata: bool = True


def _toggle_rpc_or_503(fn: str, args: dict, migration: str) -> Any:
    """Executa uma RPC de status e traduz erros (função ausente -> 503)."""
    try:
        return sb_admin.rpc(fn, args).execute()
    except Exception as e:
        msg = str(e)
        if fn in msg and ("does not exist" in msg or "schema cache" in msg):
            raise HTTPException(
                status_code=503,
                detail=f"Rode {migration} no SQL Editor (função {fn} ausente)",
            ) from e
        lower = msg.lower()
        if "não encontrad" in msg or "não informado" in msg:
            raise HTTPException(status_code=404, detail=_rpc_message(msg)) from e
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao atualizar status")) from e


@app.post("/api/admin/companies/{company_id}/status")
def api_admin_company_status(
    company_id: str,
    payload: StatusUpdate,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Ativa/Desativa uma EMPRESA (soft delete). Nunca apaga.

    Regra de negócio: desativar uma empresa derruba (em cascata) o acesso de
    TODOS os funcionários dela e bloqueia o registro de ponto. A cascata marca
    quem foi desligado por causa dela, para que a reativação restaure apenas
    esses (quem já estava inativo antes continua inativo).
    """
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    _require_system_admin(me)
    if sb_admin is None:
        raise HTTPException(
            status_code=500,
            detail="Configure SUPABASE_SERVICE_ROLE_KEY no .env para alterar status de empresas",
        )
    rate_limit(request, "company-status", 30, 3600, key=str(me["id"]))

    try:
        res = _toggle_rpc_or_503(
            "atualizar_empresa_status",
            {
                "p_company_id": company_id,
                "p_ativa": payload.ativo,
                "p_ator": me["id"],
                "p_cascata": payload.cascata,
            },
            "migration_soft_delete.sql",
        )
    except HTTPException:
        raise
    data = res.data or {}
    company = data.get("company", {}) if isinstance(data, dict) else {}

    # Cascata no Auth: bloqueia/libera o login dos funcionários afetados.
    if payload.cascata:
        _reconcile_company_auth_bans(company_id, payload.ativo)

    logger.info(
        "status empresa company=%s ativo=%s cascata=%s afetados=%s",
        company_id,
        payload.ativo,
        payload.cascata,
        data.get("funcionarios_afetados") if isinstance(data, dict) else None,
    )
    return {"ok": True, "empresa": _company_public(company, None), "resultado": data}


@app.post("/api/admin/employees/{user_id}/status")
def api_admin_employee_status(
    user_id: str,
    payload: StatusUpdate,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Ativa/Desativa um FUNCIONÁRIO (soft delete). Nunca apaga.

    Ao DESATIVAR: marca profiles.ativo=false e aplica ban no Supabase Auth
    (o funcionário não loga mais nem mantém sessão). Ao REATIVAR: ativo=true
    e remove o ban. Admin (system_admin) e Gestor da própria empresa podem.
    """
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    role = me.get("role")
    is_admin = role in SYSTEM_ADMIN_ROLES
    is_manager = role in COMPANY_ADMIN_ROLES or role == "manager"
    if not (is_admin or is_manager):
        raise HTTPException(status_code=403, detail="Somente Administrador ou Gestor")
    if sb_admin is None:
        raise HTTPException(
            status_code=500,
            detail="Configure SUPABASE_SERVICE_ROLE_KEY no .env para alterar status de funcionários",
        )
    rate_limit(request, "employee-status", 60, 3600, key=str(me["id"]))

    # Escopo: gestor só mexe em funcionário da própria empresa; ninguém desativa
    # a si mesmo (evita auto-lockout).
    if str(user_id) == str(me["id"]):
        raise HTTPException(status_code=400, detail="Você não pode desativar o próprio usuário")
    target = _profile_scope_row(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Funcionário não encontrado")
    if not is_admin:
        if not me.get("company_id") or str(target.get("company_id")) != str(me.get("company_id")):
            raise HTTPException(status_code=403, detail="Funcionário fora da sua empresa")
        # Gestor não desativa admin/gestor (evita escalada).
        if target.get("role") in SYSTEM_ADMIN_ROLES.union(COMPANY_ADMIN_ROLES):
            raise HTTPException(status_code=403, detail="Sem permissão para alterar este perfil")

    _toggle_rpc_or_503(
        "atualizar_funcionario_status",
        {"p_user_id": user_id, "p_ativo": payload.ativo, "p_ator": me["id"]},
        "migration_soft_delete.sql",
    )
    # Bloqueio/liberação no Auth (best-effort; o banco já é a fonte da verdade).
    _admin_set_user_banned(user_id, banned=not payload.ativo)

    logger.info(
        "status funcionario user=%s ativo=%s por=%s", user_id, payload.ativo, me["id"]
    )
    return {"ok": True, "ativo": payload.ativo}


def _profile_scope_row(user_id: str) -> dict:
    """Lê o essencial do funcionário-alvo (service key p/ escopo confiável)."""
    src = sb_admin if sb_admin is not None else sb
    try:
        rows = (
            src.table("profiles")
            .select("id,full_name,role,company_id,ativo")
            .eq("id", user_id)
            .limit(1)
            .execute()
            .data
            or []
        )
    except Exception:
        return {}
    return rows[0] if rows else {}


def _reconcile_company_auth_bans(company_id: str, company_active: bool) -> None:
    """Aplica o ban do Auth coerente com o status REAL de cada funcionário.

    - Empresa desativada: bane todos os funcionários da empresa.
    - Empresa reativada: desbane apenas quem ficou com ativo=true no banco
      (a RPC de cascata já decidiu quem volta); quem segue inativo permanece
      banido.
    """
    src = sb_admin if sb_admin is not None else sb
    try:
        rows = (
            src.table("profiles")
            .select("id,ativo")
            .eq("company_id", company_id)
            .limit(2000)
            .execute()
            .data
            or []
        )
    except Exception:
        logger.warning("Falha ao reconciliar bans da empresa %s", company_id)
        return
    for r in rows:
        uid = r.get("id")
        if not uid:
            continue
        if not company_active:
            _admin_set_user_banned(uid, banned=True)
        else:
            # Só desbane quem ficou ativo; inativo continua banido.
            if r.get("ativo") is not False:
                _admin_set_user_banned(uid, banned=False)


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
    # Painel Admin: 60/min por admin (anti-varredura das empresas).
    rate_limit(request, "admin-read", 60, 60, key=str(me["id"]))
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
            .select("id,full_name,role,manager_id,company_id,ativo")
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
        # Pré-migração: 'ativo' pode vir ausente -> trata como ativo.
        p["ativo"] = True if p.get("ativo") is None else bool(p.get("ativo"))

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
    rate_limit(request, "admin-read", 60, 60, key=str(me["id"]))
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
    rate_limit(request, "admin-read", 60, 60, key=str(me["id"]))
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


def _hhmm(local_dt: datetime) -> str:
    """'HH:MM' do horário local (BRT) de uma batida."""
    return local_dt.strftime("%H:%M")


def _mte_jornada(punches: list[dict]) -> list[Optional[str]]:
    """Monta a 'Jornada realizada' do Anexo II: até 4 slots por dia.

    A folha oficial tem a grade Entrada | Saída | Entrada | Saída (+ até 3
    pares extra de batidas). Mapeamos o padrão da farmácia:
      [0] Entrada        = 1ª batida 'in'
      [1] Início interval = 'break_start'
      [2] Fim intervalo   = 'break_end'
      [3] Saída           = 1ª batida 'out'
    Batidas a mais (2º turno no mesmo dia) seguem preenchendo os slots
    seguintes na ordem cronológica. Slot sem batida fica None (— no PDF).
    """
    order: list[Optional[str]] = [None, None, None, None]
    ins = [p for p in punches if p["type"] == "in"]
    outs = [p for p in punches if p["type"] == "out"]
    bs = [p for p in punches if p["type"] == "break_start"]
    be = [p for p in punches if p["type"] == "break_end"]
    if ins:
        order[0] = _hhmm(ins[0]["local"])
    if bs:
        order[1] = _hhmm(bs[0]["local"])
    if be:
        order[2] = _hhmm(be[0]["local"])
    if outs:
        order[3] = _hhmm(outs[0]["local"])
    # Pares adicionais (2º turno): anexa os que sobraram em ordem de horário.
    extra: list[Optional[str]] = []
    for p in sorted(punches, key=lambda x: x["local"]):
        if p["type"] == "break_end":
            continue
        if p["type"] == "in" and (ins and p is ins[0]):
            continue
        if p["type"] == "out" and (outs and p is outs[0]):
            continue
        if p["type"] == "break_start" and (bs and p is bs[0]):
            continue
        extra.append(_hhmm(p["local"]))
    return order + extra


def _mte_tratamentos(punches: list[dict]) -> list[dict]:
    """Lista os 'Tratamentos efetuados' (ocorrência I/D/P + motivo).

    Mapeamento:
      * recusada (rejected)        -> ocorrência 'D' (desconsiderada)
        motivo: a nota da batida, ou "Batida desconsiderada pelo gestor".
      * pendente (pending)         -> ocorrência 'P' (pendente de aprovação)
        motivo: "Aguardando aprovação do gestor" (+ nota, se houver).
      * aprovada COM nota          -> ocorrência 'I' (incluída/justificada)
        motivo: a nota registrada.
      * aprovada sem nota          -> sem tratamento (não é uma alteração).
    Devolve uma entrada por batida tratada, com horário original e autor.
    """
    out: list[dict] = []
    for p in sorted(punches, key=lambda x: x["local"]):
        status = p.get("status")
        note = p.get("note")
        occ = None
        motivo = ""
        if status == "rejected":
            occ = "D"
            motivo = note or "Batida desconsiderada pelo gestor"
        elif status == "pending":
            occ = "P"
            motivo = ("Nota: " + note) if note else "Aguardando aprovação do gestor"
        elif note:
            occ = "I"
            motivo = "Nota: " + note
        if occ:
            out.append(
                {
                    "horario_original": _hhmm(p["local"]),
                    "ocorrencia": occ,
                    "motivo": motivo,
                    "aprovado_por": p.get("approved_by_name"),
                }
            )
    return out


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
    expected_days: Optional[dict[str, dict]] = None,
    approver_names: Optional[dict[str, str]] = None,
) -> tuple[list[dict], dict]:
    """Calcula jornada dia a dia. Rejeitados não contam; pendentes contam e sinalizam.

    ``expected_days`` (opcional) vem de public.dias_esperados(user, início, fim):
    para cada data ISO traz {"is_work": bool, "expected_min": int, "is_holiday": bool}.
    Quando presente, ele define o que é dia de trabalho (escala 12x36, padrão,
    personalizada). Sem ele, cai no comportamento antigo (seg-sex 8h, feriado
    folga) — mantém compatibilidade enquanto a migração não estiver aplicada.
    """
    approver_names = approver_names or {}
    # by_day  = batidas CONTADAS (aprovadas + pendentes; recusadas fora).
    # raw_by_day = TODAS as batidas do dia, inclusive recusadas, para o
    # espelho MTE ("Marcações registradas" + "Tratamentos efetuados").
    by_day: dict[str, list[dict]] = {}
    raw_by_day: dict[str, list[dict]] = {}
    # Datas com justificativa registrada em QUALQUER batida (inclusive
    # recusada) — é o que separa "falta justificada" de "falta não
    # justificada" (base de desconto do RH). Rejeitados não contam horas,
    # mas a justificativa permanece como evidência.
    justified_days: set[str] = set()
    for p in punches or []:
        try:
            ts = datetime.fromisoformat(str(p["occurred_at"]).replace("Z", "+00:00"))
        except Exception:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        local = ts.astimezone(TZ_SP)
        if not (start_d <= local.date() <= end_d):
            continue
        status = p.get("approval_status") or "pending"
        note = (p.get("note") or "").strip() or None
        if note:
            justified_days.add(local.date().isoformat())
        # Guarda TODAS as batidas do dia (inclusive recusadas) para o espelho
        # MTE: "Marcações registradas no ponto eletrônico" lista o que foi
        # batido, e "Tratamentos efetuados" explica o que foi desconsiderado.
        raw_entry = {
            "type": p.get("p_type"),
            "ts": ts,
            "local": local,
            "status": status,
            "pending": status == "pending",
            "note": note,
            "approved_by_name": approver_names.get(str(p.get("approved_by") or "")),
        }
        raw_by_day.setdefault(local.date().isoformat(), []).append(raw_entry)
        if status == "rejected":
            # Recusada não conta horas nem entra no cálculo de jornada, mas
            # permanece em raw_by_day para a coluna de marcações/tratamentos.
            continue
        by_day.setdefault(local.date().isoformat(), []).append(raw_entry)
    days: list[dict] = []
    t_worked = t_expected = t_ot = t_def = 0
    t_approved = t_pending_p = t_rejected = t_abs_j = t_abs_u = 0
    has_pending = has_incomplete = False
    cur = start_d
    while cur <= end_d:
        key = cur.isoformat()
        is_weekend = cur.weekday() >= 5
        is_holiday = key in holiday_dates
        scheduled = (expected_days or {}).get(key)
        if scheduled is not None:
            # Escala define o dia: is_work + expected_min.
            is_work = bool(scheduled.get("is_work"))
            expected = int(scheduled.get("expected_min") or 0)
            is_holiday = bool(scheduled.get("is_holiday", is_holiday))
        else:
            is_work = not (is_weekend or is_holiday)
            expected = expected_daily_min if is_work else 0
        day_list = by_day.get(key, [])
        raw_list = raw_by_day.get(key, [])
        approved = sum(1 for d in day_list if d.get("status") == "approved")
        pending_n = sum(1 for d in day_list if d.get("status") == "pending")
        rejected = sum(1 for d in raw_list if d.get("status") == "rejected")
        has_justified_note = key in justified_days
        # Vista MTE: marcações brutas (todas) + jornada realizada + tratamentos.
        # raw_list preserva TODAS as batidas, inclusive as recusadas.
        marcacoes = [_hhmm(p["local"]) for p in sorted(raw_list, key=lambda x: x["local"])]
        jornada_realizada = _mte_jornada(day_list)
        tratamentos = _mte_tratamentos(raw_list)
        if not day_list:
            worked, incomplete = 0, False
            if is_holiday:
                status = "holiday"
            elif not is_work:
                # Folga de escala: distingue fim de semana de folga 12x36.
                status = "weekend" if is_weekend else "off"
            else:
                status = "absent"
        else:
            worked, incomplete = _pair_day_punches(day_list)
            status = "incomplete" if incomplete else "ok"
        # Falta = dia previsto de trabalho sem horas trabalhadas. Classifica em
        # justificada (existia justificativa registrada numa batida) x não
        # justificada (o que o RH usa para desconto).
        is_absence = is_work and worked == 0 and status not in ("holiday",)
        absent_justified = bool(is_absence and has_justified_note)
        absent_unjustified = bool(is_absence and not has_justified_note)
        pending = any(d["pending"] for d in day_list)
        has_pending = has_pending or pending
        has_incomplete = has_incomplete or incomplete
        ot = max(0, worked - expected)
        deficit = max(0, expected - worked)
        t_worked += worked
        t_expected += expected
        t_ot += ot
        t_def += deficit
        t_approved += approved
        t_pending_p += pending_n
        t_rejected += rejected
        t_abs_j += 1 if absent_justified else 0
        t_abs_u += 1 if absent_unjustified else 0
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
                "approved_count": approved,
                "pending_count": pending_n,
                "rejected_count": rejected,
                "absent_justified": absent_justified,
                "absent_unjustified": absent_unjustified,
                # --- Vista MTE (Anexo II Portaria 1510) ---
                "marcacoes_eletronicas": marcacoes,
                "jornada_realizada": jornada_realizada,
                "tratamentos_efetuados": tratamentos,
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
        "approved_count": t_approved,
        "pending_count": t_pending_p,
        "rejected_count": t_rejected,
        "absences_justified": t_abs_j,
        "absences_unjustified": t_abs_u,
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
            .select("p_type,occurred_at,approval_status,note,approved_by")
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

        # Escala do colaborador (12x36 / padrão / personalizada) via função SQL.
        # Se a migração de escalas ainda não foi aplicada, cai no comportamento
        # antigo (seg-sex 8h) sem quebrar o relatório.
        expected_days: Optional[dict[str, dict]] = None
        try:
            rpc = sb.rpc(
                "dias_esperados",
                {"p_user": target_id, "p_start": start_d.isoformat(), "p_end": end_d.isoformat()},
            ).execute()
            rows = rpc.data or []
            if rows:
                expected_days = {
                    (r.get("dia") if isinstance(r.get("dia"), str) else str(r.get("dia")))[:10]: {
                        "is_work": r.get("is_work"),
                        "expected_min": r.get("expected_min"),
                        "is_holiday": r.get("is_holiday"),
                    }
                    for r in rows
                    if r.get("dia")
                }
        except Exception:
            expected_days = None
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao calcular jornada")) from e
    # Resolve nome de quem aprovou as batidas (coluna "aprovado_por" do MTE).
    approver_ids = sorted({str(p.get("approved_by")) for p in punches if p.get("approved_by")})
    approver_names: dict[str, str] = {}
    if approver_ids:
        try:
            rows = (
                sb.table("profiles")
                .select("id,full_name")
                .in_("id", approver_ids)
                .execute()
                .data
            ) or []
            approver_names = {str(r["id"]): (r.get("full_name") or "") for r in rows}
        except Exception:
            approver_names = {}
    holiday_dates = {h["h_date"] for h in hols if h.get("h_date")}
    days, totals = _compute_timesheet(
        punches, holiday_dates, start_d, end_d, expected_daily_min, expected_days, approver_names
    )
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


# ----------------------------
# RELATÓRIO DE FECHAMENTO DE PONTO (PDF + JSON)
# ----------------------------
# Hierarquia de acesso:
#   employee -> só o próprio (user_id forçado a si mesmo)
#   manager  -> a própria equipe (subordinados diretos via manager_id)
#   company_admin / system_admin / admin -> toda a empresa, com filtro por CNPJ
# O relatório traz o espelho do mês: horas, batidas aprovadas/pendentes/
# recusadas, faltas justificadas e não justificadas (base para pagamento e
# desconto do RH).

REPORT_MAX_MONTHS = 12  # período máximo do relatório (1 ano)


def _month_range(month: str) -> tuple[date, date]:
    """'2026-09' -> (2026-09-01, 2026-09-30). Valida o formato."""
    try:
        y, m = month.split("-")
        start_d = date(int(y), int(m), 1)
    except Exception as e:
        raise HTTPException(status_code=400, detail="month inválido (use AAAA-MM)") from e
    if start_d.month == 12:
        next_m = date(start_d.year + 1, 1, 1)
    else:
        next_m = date(start_d.year, start_d.month + 1, 1)
    return start_d, next_m - timedelta(days=1)


def _report_targets(sb: Client, me: dict, user_id: Optional[str], cnpj: Optional[str]) -> list[dict]:
    """Resolve QUEM entra no relatório, respeitando a hierarquia de acesso.

    Retorna a lista de colaboradores (id, full_name, role, company_id).
    """
    role = me.get("role")
    cs = _company_scope(me)

    # Admin de plataforma pode filtrar por CNPJ de qualquer empresa.
    if role in SYSTEM_ADMIN_ROLES and cnpj:
        cnpj_digits = normalize_cnpj(cnpj)
        comp = sb.table("companies").select("id,nome,cnpj").eq("cnpj", cnpj_digits).limit(1).execute().data
        if not comp:
            raise HTTPException(status_code=404, detail="Empresa (CNPJ) não encontrada")
        company_id = comp[0]["id"]
    else:
        company_id = cs or me.get("company_id")

    # 1) Funcionário: sempre o próprio, ignora qualquer user_id externo.
    if role == "employee":
        target = user_id or me["id"]
        if target != me["id"]:
            raise HTTPException(status_code=403, detail="Você só pode gerar o seu próprio relatório")
        return [
            {
                "id": me["id"],
                "full_name": me.get("full_name"),
                "role": role,
                "company_id": me.get("company_id"),
            }
        ]

    # 2) Gestor/admin: um colaborador específico (validando o escopo).
    if user_id:
        try:
            t = (
                sb.table("profiles")
                .select("id,full_name,role,manager_id,company_id")
                .eq("id", user_id)
                .limit(1)
                .execute()
                .data
            )
        except Exception:
            t = None
        # .single()/.limit(1) varia entre dict e lista conforme o client;
        # normaliza para um único registro.
        if isinstance(t, list):
            t = t[0] if t else None
        if not t or not isinstance(t, dict):
            raise HTTPException(status_code=404, detail="Colaborador não encontrado")
        if role == "manager" and t.get("manager_id") != me["id"]:
            raise HTTPException(status_code=403, detail="Colaborador não pertence à sua equipe")
        if role in COMPANY_ADMIN_ROLES and not SYSTEM_ADMIN_ROLES:
            if company_id and t.get("company_id") != company_id:
                raise HTTPException(status_code=403, detail="Colaborador fora da sua empresa")
        return [t]

    # 3) Gestor/admin sem user_id: todos do escopo (equipe ou empresa).
    q = sb.table("profiles").select("id,full_name,role,manager_id,company_id")
    if role == "manager":
        q = q.eq("manager_id", me["id"])
    else:
        if company_id:
            q = q.eq("company_id", company_id)
    try:
        data = q.limit(1000).execute().data or []
    except Exception as e:
        raise HTTPException(status_code=400, detail=user_safe_error(e, "Falha ao listar colaboradores")) from e
    # Nunca inclui o próprio admin de plataforma (ele não bate ponto).
    return [p for p in data if p["id"] != me["id"] or role == "manager"]


def _fmt_cpf(digits: Optional[str]) -> str:
    """'12345678901' -> '123.456.789-01'. Vazio -> '' (vira — no PDF)."""
    d = re.sub(r"\D", "", str(digits or ""))
    if len(d) != 11:
        return str(digits or "")
    return f"{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}"


def _fmt_pis(digits: Optional[str]) -> str:
    """'12345678901' -> '123.45678.90-1' (formato PIS/NIS)."""
    d = re.sub(r"\D", "", str(digits or ""))
    if len(d) != 11:
        return str(digits or "")
    return f"{d[:3]}.{d[3:8]}.{d[8:10]}-{d[10:]}"


def _fmt_cnpj(digits: Optional[str]) -> str:
    d = re.sub(r"\D", "", str(digits or ""))
    if len(d) != 14:
        return str(digits or "")
    return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"


def _employee_contract(sb: Client, target_id: str) -> dict:
    """Busca os dados cadastrais do empregado para o cabeçalho do espelho.

    Tolerante à ausência das colunas (migração_espelho_mte não aplicada):
    retorna o que existir; o restante vira travessão.
    """
    base = {"full_name": None, "cpf": None, "pis": None, "ctps": None, "cargo": None, "data_admissao": None}
    try:
        row = (
            sb.table("profiles")
            .select("id,full_name,role,cpf,pis,ctps,cargo,data_admissao")
            .eq("id", target_id)
            .limit(1)
            .execute()
            .data
        )
        if isinstance(row, list):
            row = row[0] if row else None
        if isinstance(row, dict):
            base.update(row)
    except Exception:
        # Colunas ainda não existem: tenta só o essencial.
        try:
            row = (
                sb.table("profiles")
                .select("id,full_name,role")
                .eq("id", target_id)
                .limit(1)
                .execute()
                .data
            )
            if isinstance(row, list):
                row = row[0] if row else None
            if isinstance(row, dict):
                base.update(row)
        except Exception:
            pass
    return base


def _company_header(sb: Client, company_id: Optional[str], me: dict) -> dict:
    """CNPJ + razão social + endereço do empregador (cabeçalho do espelho)."""
    cnpj = company_cnpj_of(me)
    nome = company_name_of(me)
    endereco = None
    cid = company_id or me.get("company_id")
    if cid:
        try:
            row = (
                sb.table("companies")
                .select("cnpj,nome,endereco")
                .eq("id", cid)
                .limit(1)
                .execute()
                .data
            )
            if isinstance(row, list):
                row = row[0] if row else None
            if isinstance(row, dict):
                cnpj = row.get("cnpj") or cnpj
                nome = row.get("nome") or nome
                endereco = row.get("endereco")
        except Exception:
            pass
    return {"cnpj": cnpj, "razao_social": nome, "endereco": endereco}


def _contract_schedule(sb: Client, target_id: str, start_d: date) -> dict:
    """Horário contratual (CH) do empregado, derivado da escala vigente.

    A escala guarda apenas os minutos esperados; reconstruímos uma grade
    coerente (Portaria 1510, coluna CH) a partir do tipo:
      * 12x36  -> entrada 07:00, intervalo 12:00-13:00, saída 19:00 (660 min)
      * padrão/personalizada -> entrada 08:00, intervalo 12:00-13:00,
        saída derivada dos minutos esperados (ex.: 480 -> 17:00).
    Código CH: '001'. Sem escala -> grade padrão seg-sex 8h.
    """
    tipo = "padrao"
    expected_min = 480
    try:
        row = sb.rpc("escala_vigente", {"p_user": target_id, "p_date": start_d.isoformat()}).execute().data
        if isinstance(row, list):
            row = row[0] if row else None
        if isinstance(row, dict) and row:
            tipo = row.get("tipo") or "padrao"
            expected_min = int(row.get("expected_min") or 480)
    except Exception:
        pass
    if tipo == "12x36":
        return {
            "codigo_ch": "001",
            "escala_trabalho": "12x36",
            "jornada_prevista": {
                "entrada": "07:00",
                "inicio_intervalo": "12:00",
                "fim_intervalo": "13:00",
                "saida": "19:00",
            },
        }
    # Grade padrão: entrada 08:00, intervalo 12:00-13:00, saída calculada.
    day_min = max(0, expected_min)
    total_saida = 8 * 60 + day_min  # saída relativa às 08:00, sem contar o almoço
    saida = f"{(total_saida // 60) % 24:02d}:{total_saida % 60:02d}"
    return {
        "codigo_ch": "001",
        "escala_trabalho": "5x2" if tipo == "padrao" else tipo,
        "jornada_prevista": {
            "entrada": "08:00",
            "inicio_intervalo": "12:00",
            "fim_intervalo": "13:00",
            "saida": saida,
        },
    }


def _status_dia_mte(day: dict) -> str:
    """Rótulo humano do dia, no vocabulário do RH (resumo mensal)."""
    if day.get("absent_unjustified"):
        return "Falta Não Justificada"
    if day.get("absent_justified"):
        return "Falta Justificada"
    if day.get("holiday"):
        return "Feriado"
    if day["status"] == "weekend":
        return "Folga (Fim de Semana)"
    if day["status"] == "off":
        return "Folga (Escala)"
    if day["status"] == "incomplete":
        return "Presença Incompleta (revisar)"
    if day["worked_min"] > 0:
        if day.get("overtime_min", 0) > 0:
            return "Presença Completa (com hora extra)"
        return "Presença Completa"
    return "Sem Registro"


def _build_espelho_mte(emp: dict, company: dict, start_d: date, end_d: date) -> dict:
    """Monta o JSON oficial 'relatorio_espelho_ponto' (Anexo II Portaria 1510).

    Um documento por EMPREGADO (o modelo que o RH integra na folha). Lê tudo
    do próprio registro enriquecido do empregado (cadastro + escala + dias).
    """
    days = emp["days"]
    totals = emp["totals"]
    cad = emp.get("cadastro") or {}
    registros: list[dict] = []
    for d in days:
        registros.append(
            {
                "dia": d["date"][8:10],
                "data": d["date"],
                "marcacoes_eletronicas": d.get("marcacoes_eletronicas", []),
                "jornada_realizada": d.get("jornada_realizada", []),
                "horas_extras": _min_to_hhmm(d["overtime_min"]),
                "tratamentos_efetuados": d.get("tratamentos_efetuados", []),
                "status_dia": _status_dia_mte(d),
            }
        )
    status_fechamento = (
        "Aprovado (sem pendências)"
        if not totals.get("has_pending")
        else "Pendente de aprovação"
    )
    return {
        "relatorio_espelho_ponto": {
            "metadados": {
                "data_emissao": datetime.now(TZ_SP).isoformat(),
                "periodo_referencia": start_d.strftime("%m/%Y"),
                "data_inicial": start_d.isoformat(),
                "data_final": end_d.isoformat(),
            },
            "empregador": {
                "identificador_cnpj": _fmt_cnpj(company.get("cnpj")),
                "razao_social": company.get("razao_social") or "—",
                "endereco": company.get("endereco") or "—",
            },
            "empregado": {
                "nome": emp.get("full_name") or "—",
                "cpf": cad.get("cpf") or "—",
                "pis": cad.get("pis") or "—",
                "cargo": cad.get("cargo") or emp.get("role") or "—",
                "ctps": cad.get("ctps") or "—",
                "data_admissao": cad.get("data_admissao") or "—",
                "escala_trabalho": emp.get("escala_trabalho") or "—",
            },
            "horarios_contratuais": {
                "codigo_ch": emp.get("codigo_ch") or "001",
                "jornada_prevista": emp.get("jornada_prevista") or {},
            },
            "registros_diarios": registros,
            "resumo_mensal_rh": {
                "total_horas_trabalhadas": _min_to_hhmm(totals["worked_min"]),
                "total_horas_extras": _min_to_hhmm(totals["overtime_min"]),
                "dias_trabalhados": sum(1 for d in days if d["worked_min"] > 0),
                "faltas_justificadas_dias": totals.get("absences_justified", 0),
                "faltas_nao_justificadas_dias": totals.get("absences_unjustified", 0),
                "dias_para_desconto_salarial": totals.get("absences_unjustified", 0),
                "status_fechamento_mes": status_fechamento,
            },
        }
    }


def _min_to_hhmm(v: int) -> str:
    """Minutos -> 'HH:MM' (aceita negativo: '-01:30')."""
    v = int(v or 0)
    sign = "-" if v < 0 else ""
    a = abs(v)
    return f"{sign}{a // 60:02d}:{a % 60:02d}"


def _build_report(sb: Client, me: dict, start_d: date, end_d: date, targets: list[dict]) -> dict:
    """Monta o relatório (JSON) com o espelho de cada colaborador do escopo."""
    cs = _company_scope(me)
    employees: list[dict] = []
    agg = {
        "expected_min": 0,
        "worked_min": 0,
        "overtime_min": 0,
        "deficit_min": 0,
        "balance_min": 0,
        "absences_justified": 0,
        "absences_unjustified": 0,
        "approved_count": 0,
        "pending_count": 0,
        "rejected_count": 0,
    }
    for t in targets:
        sheet = _timesheet_for_user(sb, me, t["id"], start_d, end_d, 480, cs)
        totals = sheet["totals"]
        for k in agg:
            agg[k] += int(totals.get(k, 0) or 0)
        days_worked = sum(1 for d in sheet["days"] if d["worked_min"] > 0)
        contract = _employee_contract(sb, t["id"])
        ch = _contract_schedule(sb, t["id"], start_d)
        emp = {
            "user_id": t["id"],
            "full_name": contract.get("full_name") or t.get("full_name"),
            "role": t.get("role"),
            "company_id": t.get("company_id"),
            "days": sheet["days"],
            "totals": totals,
            "summary": {
                "days_worked": days_worked,
                "absences_justified": totals.get("absences_justified", 0),
                "absences_unjustified": totals.get("absences_unjustified", 0),
            },
            # Dados cadastrais + horário contratual (cabeçalho do espelho MTE).
            "cadastro": {
                "cpf": _fmt_cpf(contract.get("cpf")),
                "pis": _fmt_pis(contract.get("pis")),
                "ctps": contract.get("ctps"),
                "cargo": contract.get("cargo") or t.get("role"),
                "data_admissao": contract.get("data_admissao"),
            },
            "escala_trabalho": ch.get("escala_trabalho"),
            "codigo_ch": ch.get("codigo_ch"),
            "jornada_prevista": ch.get("jornada_prevista"),
        }
        employees.append(emp)
    now = datetime.now(TZ_SP)
    company = _company_header(sb, cs or me.get("company_id"), me)
    return {
        "kind": "folha_fechamento_ponto",
        "generated_at": now.isoformat(),
        "period": {"month": start_d.strftime("%Y-%m"), "start": start_d.isoformat(), "end": end_d.isoformat()},
        "company": {
            "id": cs or me.get("company_id"),
            "cnpj": company_cnpj_of(me),
            "nome": company_name_of(me),
            "razao_social": company.get("razao_social"),
            "endereco": company.get("endereco"),
        },
        "generated_by": {"id": me["id"], "full_name": me.get("full_name"), "role": me.get("role")},
        "employees": employees,
        # Espelho oficial MTE (um documento por empregado) — pronto para o RH.
        "espelhos_mte": [_build_espelho_mte(e, company, start_d, end_d) for e in employees],
        "totals": agg,
        "count": len(employees),
    }


def _report_filename(report: dict, ext: str) -> str:
    cnpj = re.sub(r"\D", "", str(report["company"].get("cnpj") or "empresa")) or "empresa"
    return f"fechamento-ponto-{report['period']['month']}-{cnpj}.{ext}"


def _report_pdf_bytes(report: dict) -> bytes:
    """Gera o PDF de conferência/impressão. Usa reportlab (puro Python)."""
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4, landscape
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            Paragraph,
            SimpleDocTemplate,
            Spacer,
            Table,
            TableStyle,
        )
    except Exception as e:  # pragma: no cover - dependência opcional
        raise HTTPException(
            status_code=501,
            detail="Geração de PDF indisponível: instale 'reportlab' (pip install reportlab)",
        ) from e

    import io

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=10 * mm,
        rightMargin=10 * mm,
        topMargin=10 * mm,
        bottomMargin=10 * mm,
        title=f"Espelho de Ponto {report['period']['month']}",
    )
    styles = getSampleStyleSheet()
    h1 = styles["Title"]
    h2 = styles["Heading2"]
    small = ParagraphStyle("SmallText", parent=styles["Normal"], fontSize=8, leading=10)
    cell = ParagraphStyle("Cell", parent=styles["Normal"], fontSize=6.5, leading=8)

    def fmin(v: int) -> str:
        v = int(v or 0)
        sign = "-" if v < 0 else ""
        a = abs(v)
        return f"{sign}{a // 60:02d}:{a % 60:02d}"

    def dash(v: Any) -> str:
        s = "" if v is None else str(v)
        return s or "—"

    comp = report["company"]
    period = report["period"]
    story = []
    story.append(Paragraph("Relatório Espelho de Ponto Eletrônico", h1))
    story.append(
        Paragraph(
            f"<b>Empregador:</b> {dash(comp.get('razao_social') or comp.get('nome'))} "
            f"— CNPJ {_fmt_cnpj(comp.get('cnpj')) or '—'}<br/>"
            f"<b>Endereço:</b> {dash(comp.get('endereco'))}<br/>"
            f"<b>Período:</b> {period['start']} a {period['end']} ({period['month']}) &nbsp;·&nbsp; "
            f"<b>Relatório emitido em:</b> {report['generated_at'][:19]} &nbsp;·&nbsp; "
            f"<b>Por:</b> {dash(report['generated_by'].get('full_name'))} "
            f"({dash(report['generated_by'].get('role'))})",
            small,
        )
    )
    story.append(Spacer(1, 5 * mm))

    for emp in report["employees"]:
        t = emp["totals"]
        cad = emp.get("cadastro") or {}
        jp = emp.get("jornada_prevista") or {}
        story.append(Paragraph(f"Empregado: {dash(emp.get('full_name'))}", h2))
        story.append(
            Paragraph(
                f"CPF: <b>{dash(cad.get('cpf'))}</b> · PIS: <b>{dash(cad.get('pis'))}</b> · "
                f"Cargo: <b>{dash(cad.get('cargo'))}</b> · CTPS: <b>{dash(cad.get('ctps'))}</b> · "
                f"Admissão: <b>{dash(cad.get('data_admissao'))}</b> · "
                f"Escala: <b>{dash(emp.get('escala_trabalho'))}</b><br/>"
                f"Horário contratual (CH {dash(emp.get('codigo_ch'))}): "
                f"Entrada {dash(jp.get('entrada'))} · Int. {dash(jp.get('inicio_intervalo'))}"
                f"–{dash(jp.get('fim_intervalo'))} · Saída {dash(jp.get('saida'))}",
                small,
            )
        )
        story.append(Spacer(1, 2 * mm))

        header = [
            "Dia",
            "Marcações registradas",
            "Entrada",
            "Iní. Int.",
            "Fim Int.",
            "Saída",
            "CH",
            "H. Extra",
            "Tratamentos (Hor. · Ocor. · Motivo)",
        ]
        rows = [header]
        for d in emp["days"]:
            # Mostra o dia quando há algo relevante (trabalho, falta, feriado).
            if d["expected_min"] == 0 and d["worked_min"] == 0 and not d["holiday"] and not d.get("marcacoes_eletronicas"):
                continue
            jr = d.get("jornada_realizada") or []
            jr = (jr + [None] * 4)[:4]
            marc = " ".join(d.get("marcacoes_eletronicas") or []) or "—"
            trats = d.get("tratamentos_efetuados") or []
            trat_txt = (
                "<br/>".join(
                    f"{x.get('horario_original')} {x.get('ocorrencia')} — {x.get('motivo')}"
                    for x in trats
                )
                or "—"
            )
            label = d["date"][8:10]
            if d.get("absent_unjustified"):
                label += " FALTA"
            elif d.get("absent_justified"):
                label += " JUSTIF."
            rows.append(
                [
                    label,
                    Paragraph(marc, cell),
                    dash(jr[0]),
                    dash(jr[1]),
                    dash(jr[2]),
                    dash(jr[3]),
                    dash(emp.get("codigo_ch")),
                    fmin(d["overtime_min"]),
                    Paragraph(trat_txt, cell),
                ]
            )
        rows.append(
            [
                "TOTAL",
                "",
                "",
                "",
                "",
                fmin(t["worked_min"]),
                "",
                fmin(t["overtime_min"]),
                "",
            ]
        )
        table = Table(
            rows,
            repeatRows=1,
            hAlign="LEFT",
            colWidths=[16 * mm, 42 * mm, 15 * mm, 15 * mm, 15 * mm, 15 * mm, 12 * mm, 16 * mm, 100 * mm],
        )
        table.setStyle(
            TableStyle(
                [
                    ("FONT", (0, 0), (-1, -1), "Helvetica", 6.5),
                    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 6.5),
                    ("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 7),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e2e8f0")),
                    ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cbd5e1")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ]
            )
        )
        story.append(table)

        # Rodapé de fechamento (crítico para o RH).
        status = "Pendente de aprovação" if t.get("has_pending") else "Aprovado"
        story.append(Spacer(1, 2 * mm))
        story.append(
            Paragraph(
                f"<b>Resumo mensal (RH)</b> — "
                f"Total trabalhado: <b>{fmin(t['worked_min'])}</b> · "
                f"Horas extras: <b>{fmin(t['overtime_min'])}</b> · "
                f"Dias trabalhados: <b>{sum(1 for d in emp['days'] if d['worked_min'] > 0)}</b> · "
                f"Faltas justificadas (NÃO descontar): <b>{t.get('absences_justified', 0)}</b> · "
                f"Faltas NÃO justificadas (DESCONTO): <b>{t.get('absences_unjustified', 0)}</b> · "
                f"Dias p/ desconto salarial: <b>{t.get('absences_unjustified', 0)}</b> · "
                f"Status do fechamento: <b>{status}</b> · "
                f"Saldo: <b>{fmin(t['balance_min'])}</b>",
                small,
            )
        )
        story.append(Spacer(1, 7 * mm))

    agg = report["totals"]
    story.append(
        Paragraph(
            f"<b>Total geral</b> · Trabalhado {fmin(agg['worked_min'])} · "
            f"Extras {fmin(agg['overtime_min'])} · Saldo {fmin(agg['balance_min'])} · "
            f"Faltas justificadas {agg['absences_justified']} · "
            f"Faltas não justificadas {agg['absences_unjustified']}",
            small,
        )
    )
    doc.build(story)
    return buf.getvalue()


@app.get("/api/reports/monthly.json")
def api_report_monthly_json(
    request: Request,
    month: str = "",
    user_id: Optional[str] = None,
    cnpj: Optional[str] = None,
    format: str = "full",
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Relatório mensal em JSON (integração com a folha do RH).

    format=full (padrão) -> lote com todos os colaboradores do escopo.
    format=mte           -> modelo oficial Anexo II (Portaria 1510):
                            {'relatorio_espelho_ponto': {...}} por empregado.
                            Exige escopo de UM colaborador (user_id).
    """
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    rate_limit(request, "report", 30, 60, key=str(me["id"]))
    if not month:
        raise HTTPException(status_code=400, detail="Informe month (AAAA-MM)")
    start_d, end_d = _month_range(month)
    targets = _report_targets(sb, me, user_id, cnpj)
    report = _build_report(sb, me, start_d, end_d, targets)
    if (format or "").lower() == "mte":
        espelhos = report.get("espelhos_mte") or []
        if len(espelhos) != 1:
            raise HTTPException(
                status_code=400,
                detail="O formato MTE exige UM colaborador. Selecione um e tente novamente.",
            )
        payload = espelhos[0]
        return JSONResponse(
            payload,
            headers={"Content-Disposition": f'attachment; filename="{_report_filename(report, "mte.json")}"'},
        )
    return JSONResponse(
        report,
        headers={"Content-Disposition": f'attachment; filename="{_report_filename(report, "json")}"'},
    )


@app.get("/api/reports/monthly.pdf")
def api_report_monthly_pdf(
    request: Request,
    month: str = "",
    user_id: Optional[str] = None,
    cnpj: Optional[str] = None,
    authorization: Optional[str] = Header(default=None),
    x_company_id: Optional[str] = Header(default=None),
):
    """Relatório mensal em PDF (conferência/impressão)."""
    sb, me, _ = resolve_auth(request, authorization, x_company_id)
    rate_limit(request, "report", 30, 60, key=str(me["id"]))
    if not month:
        raise HTTPException(status_code=400, detail="Informe month (AAAA-MM)")
    start_d, end_d = _month_range(month)
    targets = _report_targets(sb, me, user_id, cnpj)
    report = _build_report(sb, me, start_d, end_d, targets)
    pdf = _report_pdf_bytes(report)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{_report_filename(report, "pdf")}"'},
    )
