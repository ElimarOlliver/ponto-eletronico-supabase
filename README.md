# Ponto Eletrônico — Python + Supabase (Starter)

Web app gratuito para registro de ponto com geolocalização.  
Stack: **FastAPI (Python)** + **Supabase (Auth + Postgres + RLS)** + **HTMX/Tailwind/Leaflet**.

> **Como funciona**: o login é feito via Supabase Auth no navegador. O token do usuário é enviado ao backend Python, que executa operações no banco **com o contexto desse usuário**, respeitando 100% as *Row-Level Security (RLS) policies*.

## 1) Setup do Supabase

1. Crie um projeto no Supabase.
2. No Dashboard, abra **SQL Editor** e rode o conteúdo de [`supabase.sql`](./supabase.sql).
3. Em **Project Settings → API**, copie:
   - `Project URL` → `SUPABASE_URL`
   - `anon public` key → `SUPABASE_ANON_KEY`

### Tabelas & RLS
O arquivo `supabase.sql` cria:
- **profiles**: cada usuário (ligado a `auth.users`), com `role` (`admin|manager|employee`) e `manager_id`.
- **punches**: registros de ponto (entrada/saída/pausa), com lat/lon e auditoria.
- Funções auxiliares: `is_admin(uuid)`, `is_manager_of(uuid, uuid)`.
- **Policies** garantindo:
  - Funcionário vê/insere **apenas seus** pontos.
  - Funcionário **não** atualiza/exclui pontos.
  - Gestor pode **ver/editar** pontos **dos seus** colaboradores.
  - Admin pode tudo.
  - Trigger anti-duplicação (evita 2 batidas em <5 min).

> RLS baseada em `auth.uid()` (ID do usuário no JWT do Supabase).

## 2) Rodar localmente

```bash
python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env  # edite com suas chaves
uvicorn app.main:app --reload
```
Acesse: <http://localhost:8000>

## 3) Deploy grátis (opções)

- **Render Free Web Service**: conecta seu GitHub e define `Build/Start` (abaixo).
- **Vercel (Funções Python)**: também funciona com FastAPI serverless.

### Build/Start (Render ou outro)
```bash
# Build
pip install -r requirements.txt

# Start
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

## 4) Variáveis de ambiente
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

> **Nunca** exponha `SERVICE_ROLE_KEY` no frontend. Não é necessário neste starter.

## 5) Estrutura
```
app/
  main.py
  templates/
    index.html
  static/js/
    app.js
requirements.txt
supabase.sql
.env.example
```

## 6) Commits
Faça commits pequenos e objetivos (ex.: `feat: add punch anti-duplicate trigger`, `docs: setup steps`).

Boa construção! 🚀
