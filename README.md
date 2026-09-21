# Ponto Eletrônico — SaaS Multi-tenant (FastAPI + Supabase)

Registro de ponto com geolocalização, gestão de equipe e feriados.
Stack: **FastAPI (Python)** + **Supabase (Auth + Postgres + RLS)** + **Tailwind/Leaflet**.

> Login por **CNPJ + E-mail + Senha**. Dados isolados por empresa (`company_id` + RLS).
> Backend valida o JWT (local via JWKS, fallback server) e confere o header
> `X-Tenant-CNPJ` contra a empresa do profile em toda request.

## 1) Setup do Supabase

1. Crie um projeto no Supabase.
2. No Dashboard, abra **SQL Editor** e rode o conteúdo de [`supabase.sql`](./supabase.sql)
   (idempotente; inclui tenants, RLS, triggers e feriados).
   Se `ALTER TYPE ... ADD VALUE` reclamar de transação, rode as 2 linhas do topo
   separadamente primeiro.
3. Em **Project Settings → API**, copie (formato novo ou legado — ambos funcionam):
   - `Project URL` → `SUPABASE_URL`
   - `sb_publishable_` (ou `anon`) → `SUPABASE_PUBLISHABLE_KEY` (ou `SUPABASE_ANON_KEY`)
   - `sb_secret_` (ou `service_role`, só p/ sync de feriados) → `SUPABASE_SECRET_KEY`

### Tabelas & RLS
- **companies**: tenants (`cnpj` único só-dígitos, `nome`, `ativa`).
- **profiles**: `role` (`system_admin|company_admin|manager|employee`, legado `admin`
  equivale a `company_admin`), `manager_id`, `company_id` NOT NULL.
- **punches**: ponto com lat/lon, `company_id` preenchido por trigger, anti-duplicação
  (mesmo tipo em 5 min + lock), auditoria em `punch_audit`.
- **holidays**: `company_id NULL` = nacional (BrasilAPI, via sync); NOT NULL = local
  da empresa (ex: DF 30/11).
- Hierarquia: `system_admin` (plataforma) > `company_admin` (empresa) > `manager` > `employee`.

## 2) Rodar localmente

```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env   # edite com suas chaves
uvicorn app.main:app --reload
```
Acesse: <http://localhost:8000> · Health: `GET /api/health`

Seed de teste (2 empresas, CNPJs válidos p/ checksum do form):
```sql
INSERT INTO companies (cnpj, nome) VALUES
 ('11222333000181','Empresa A Teste'),
 ('04252011000110','Empresa B Teste')
ON CONFLICT (cnpj) DO NOTHING;
```
Crie os usuários em **Authentication → Add user** e vincule:
```sql
UPDATE profiles SET company_id=(SELECT id FROM companies WHERE cnpj='11222333000181'),
  role='company_admin' WHERE id='<UUID_A>';
UPDATE profiles SET company_id=(SELECT id FROM companies WHERE cnpj='04252011000110'),
  role='employee' WHERE id='<UUID_B>';
```
Isolamento: login cruzado (`CNPJ A` + usuário B) deve dar 403.

## 3) Feriados (BrasilAPI, grátis, sem token)

Nacionais via `GET https://brasilapi.com.br/api/feriados/v1/{ano}`.
Como `company_admin`: seção Feriados → **Sincronizar BrasilAPI** (5/hora, exige
service/secret key). Locais (ex: `2026-11-30` Dia do Evangélico DF): form
**Adicionar local** (visível só p/ admin da empresa).

## 4) Variáveis de ambiente
- `SUPABASE_URL` (obrigatória)
- `SUPABASE_ANON_KEY` ou `SUPABASE_PUBLISHABLE_KEY` (obrigatória, legado tem prioridade)
- `SUPABASE_SERVICE_ROLE_KEY` ou `SUPABASE_SECRET_KEY` (opcional; sync de feriados)
- `SUPABASE_JWKS_URL` (opcional; default `{URL}/auth/v1/.well-known/jwks.json`)
- `TZ=America/Sao_Paulo`

## 5) Rate-limits (Redis com fallback em memória)
- `resolve-company`: 30/min por IP · `clock`: 20/min por usuário
- `holidays/sync`: 5/hora por admin · `payroll/close`: 10/hora por admin
- Localhost: funciona sem nada (memória). Produção multi-instância:
  suba um Redis e defina `REDIS_URL=redis://host:6379/0`. Com Redis fora do ar,
  o limiter cai para memória com warning no log (fail-open, nunca 500).

## 6) Estrutura
```
app/
  main.py            # API + middleware de tenant + feriados
  templates/index.html
  static/js/app.js   # login CNPJ, anti-XSS, equipe, feriados
supabase.sql         # schema SaaS (tenants, RLS, triggers, holidays)
requirements.txt
.env.example
```
