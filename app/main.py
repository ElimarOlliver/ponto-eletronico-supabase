import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from dotenv import load_dotenv

from supabase import create_client, Client

# ----------------------------
# Setup básico
# ----------------------------
load_dotenv()
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    raise RuntimeError("Defina SUPABASE_URL e SUPABASE_ANON_KEY no .env")

# cliente 'anônimo' (sem JWT) - útil para rotas públicas se necessário
sb_base: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

def supabase_with_user(jwt: str) -> Client:
    """
    Retorna um client Supabase com o JWT do usuário aplicado ao Postgrest.
    Isso faz a RLS considerar auth.uid() = usuário do token.
    """
    client: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    client.postgrest.auth(jwt)
    return client

def get_current_user(sb: Client, jwt: str) -> dict:
    """
    Retorna o profile do usuário logado (id, full_name, role, manager_id).
    """
    user = sb.auth.get_user(jwt).user
    if not user:
        raise HTTPException(status_code=401, detail="Token inválido")
    pid = user.id
    prof = (
        sb.table("profiles")
        .select("id,full_name,role,manager_id")
        .eq("id", pid)
        .single()
        .execute()
        .data
    )
    if not prof:
        raise HTTPException(status_code=404, detail="Profile not found")
    return prof

# ----------------------------
# App / Static / Templates
# ----------------------------
app = FastAPI(title="Ponto Eletrônico Supabase")

app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

# ----------------------------
# Rotas de página
# ----------------------------
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    """
    Renderiza a página principal e injeta as envs do supabase no window.*
    """
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "SUPABASE_URL": SUPABASE_URL,
            "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY,
        },
    )

# ----------------------------
# API - PONTOS DO PRÓPRIO USUÁRIO
# ----------------------------
@app.get("/api/my-punches")
def api_my_punches(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)

    # RLS limita ao próprio user
    res = (
        sb.table("punches")
        .select("*")
        .order("occurred_at", desc=True)
        .limit(50)
        .execute()
    )
    return JSONResponse(res.data)

@app.post("/api/clock")
async def api_clock(request: Request, authorization: Optional[str] = Header(default=None)):
    """
    Registra um ponto (type = in/out/break_start/break_end).
    Guarda localização se houver consentimento do navegador.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)
    me = get_current_user(sb, jwt)

    body = await request.json()
    ptype = body.get("type")
    lat = body.get("lat")
    lon = body.get("lon")
    accuracy = body.get("accuracy")

    if ptype not in ("in", "out", "break_start", "break_end"):
        raise HTTPException(status_code=400, detail="type inválido")

    payload = {
        "user_id": me["id"],
        "p_type": ptype,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "latitude": lat,
        "longitude": lon,
        "accuracy": accuracy,
        "source": "web",
        "created_by": me["id"],
    }

    try:
        data = sb.table("punches").insert(payload).execute().data
        return {"ok": True, "punch": data[0] if data else None}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ----------------------------
# API - PERFIL E FUNÇÕES DE GESTOR/ADMIN
# ----------------------------
@app.get("/api/me")
def api_me(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)
    prof = get_current_user(sb, jwt)
    return prof

@app.get("/api/team")
def api_team(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)
    me = get_current_user(sb, jwt)

    if me["role"] not in ("manager", "admin"):
        return []

    if me["role"] == "admin":
        data = (
            sb.table("profiles")
            .select("id,full_name,role,manager_id")
            .neq("id", me["id"])
            .execute()
            .data
        )
    else:
        data = (
            sb.table("profiles")
            .select("id,full_name,role,manager_id")
            .eq("manager_id", me["id"])
            .execute()
            .data
        )
    return data

@app.get("/api/team-punches")
def api_team_punches(
    user_id: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 20,
    authorization: Optional[str] = Header(default=None),
):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)
    me = get_current_user(sb, jwt)

    if me["role"] not in ("manager", "admin"):
        raise HTTPException(status_code=403, detail="Somente manager/admin")

    q = sb.table("punches").select("*")
    if user_id:
        q = q.eq("user_id", user_id)
    if start:
        q = q.gte("occurred_at", start)
    if end:
        q = q.lte("occurred_at", end)

    data = q.order("occurred_at", desc=True).limit(limit).execute().data
    return data

@app.post("/api/punch-update")
async def api_punch_update(request: Request, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)
    me = get_current_user(sb, jwt)

    if me["role"] not in ("manager", "admin"):
        raise HTTPException(status_code=403, detail="Somente manager/admin")

    body = await request.json()
    punch_id = body.get("id")
    note = body.get("note")
    occurred_at = body.get("occurred_at")

    if not punch_id:
        raise HTTPException(status_code=400, detail="id obrigatório")

    patch = {"edited_by": me["id"], "edited_at": datetime.now(timezone.utc).isoformat()}
    if note is not None:
        patch["note"] = note
    if occurred_at is not None:
        patch["occurred_at"] = occurred_at

    try:
        updated = sb.table("punches").update(patch).eq("id", punch_id).execute().data
        if not updated:
            raise HTTPException(status_code=404, detail="Punch não encontrado ou sem permissão")
        return {"ok": True, "punch": updated[0]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/punch-approve")
async def api_punch_approve(request: Request, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)
    me = get_current_user(sb, jwt)

    if me["role"] not in ("manager", "admin"):
        raise HTTPException(status_code=403, detail="Somente manager/admin")

    body = await request.json()
    punch_id = body.get("id")
    decision = body.get("decision")  # 'approved' | 'rejected'
    if not punch_id or decision not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="Campos: id e decision('approved'|'rejected')")

    now_iso = datetime.now(timezone.utc).isoformat()
    patch = {
        "approval_status": decision,
        "approved_by": me["id"],
        "approved_at": now_iso,
        "edited_by": me["id"],
        "edited_at": now_iso,
    }

    try:
        updated = sb.table("punches").update(patch).eq("id", punch_id).execute().data
        if not updated:
            raise HTTPException(status_code=404, detail="Punch não encontrado ou sem permissão")
        return {"ok": True, "punch": updated[0]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
