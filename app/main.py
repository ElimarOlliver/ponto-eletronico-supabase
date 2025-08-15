import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment.")

app = FastAPI(title="Ponto Eletrônico — Python + Supabase")

# static & templates
BASE_DIR = os.path.dirname(__file__)
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


# --------- helpers ---------
def supabase_with_user(jwt: str) -> Client:
    """Create a Supabase client and attach the user's JWT so RLS is applied."""
    sb: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    # Validate token (raises if invalid/expired)
    sb.auth.get_user(jwt)
    # Attach JWT for PostgREST so policies apply
    sb.postgrest.auth(jwt)
    return sb


def get_current_user(sb: Client, jwt: str) -> dict:
    """Return the profile of the logged-in user (id, full_name, role, manager_id)."""
    user = sb.auth.get_user(jwt).user
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


# --------- routes ---------
@app.get("/health")
def health():
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat()}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "supabase_url": SUPABASE_URL,
            "supabase_anon_key": SUPABASE_ANON_KEY,
        },
    )


# ---- fluxo do colaborador (já existente) ----
@app.get("/api/my-punches")
def my_punches(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    sb = supabase_with_user(jwt)
    data = (
        sb.table("punches")
        .select("*")
        .order("occurred_at", desc=True)
        .limit(20)
        .execute()
        .data
    )
    return JSONResponse(data)


@app.post("/api/clock")
async def clock(request: Request, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    jwt = authorization.split(" ", 1)[1]
    body = await request.json()
    p_type = body.get("type")
    lat = body.get("lat")
    lon = body.get("lon")
    acc = body.get("accuracy")
    note = body.get("note")

    if p_type not in ("in", "out", "break_start", "break_end"):
        raise HTTPException(status_code=400, detail="Invalid punch type")

    sb = supabase_with_user(jwt)

    user = sb.auth.get_user(jwt).user
    user_id = user.id

    payload = {
        "user_id": user_id,
        "p_type": p_type,
        "latitude": lat,
        "longitude": lon,
        "accuracy": acc,
        "source": "web",
        "note": note,
        "created_by": user_id,
    }
    try:
        res = sb.table("punches").insert(payload).execute()
        return {"ok": True, "punch": res.data[0] if res.data else None}
    except Exception as e:
        # devolve erro do banco (ex.: trigger anti-duplicação)
        raise HTTPException(status_code=400, detail=str(e))


# ---- modo gestor/admin ----
@app.get("/api/me")
def api_me(authorization: Optional[str] = Header(default=None))_
