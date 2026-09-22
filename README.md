# Ponto Eletrônico — SaaS Multi-tenant (FastAPI + Supabase)

Registro de ponto com geolocalização, gestão de equipe, feriados e folha.
Stack: **FastAPI (Python)** + **Supabase (Auth + Postgres + RLS)** + **Frontend React 19 (TypeScript + Tailwind v4 + Leaflet)**.

> Login por **E-mail + Senha** (a empresa é resolvida no backend, nunca no cliente).
> Dados isolados por empresa (`company_id` + RLS). Gestores multi-empresa
> (ex.: donos de 2 farmácias) alternam o CNPJ ativo via seletor no cabeçalho,
> sem relogin — o backend valida a associação (`user_companies`) e troca o
> escopo por request através do header `X-Company-ID`.

## 1) Setup do Supabase

1. Crie um projeto no Supabase.
2. No Dashboard, abra **SQL Editor** e rode o conteúdo de [`supabase.sql`](./supabase.sql)
   (idempotente; inclui tenants, RLS, triggers e feriados).
   Se `ALTER TYPE ... ADD VALUE` reclamar de transação, rode as 2 linhas do topo
   separadamente primeiro.
3. (Opcional, para multi-empresa) rode [`migration_multi_company.sql`](./migration_multi_company.sql)
   e depois [`seed.sql`](./seed.sql) — cria `user_companies` e as contas de teste
   com senha `Senha123!`.
4. Em **Project Settings → API**, copie (formato novo ou legado — ambos funcionam):
   - `Project URL` → `SUPABASE_URL`
   - `sb_publishable_` (ou `anon`) → `SUPABASE_PUBLISHABLE_KEY` (ou `SUPABASE_ANON_KEY`)
   - `sb_secret_` (ou `service_role`) → `SUPABASE_SECRET_KEY`
     (obrigatória para alternar de empresa — o backend usa service key no modo switched)

### Tabelas & RLS
- **companies**: tenants (`cnpj` único só-dígitos, `nome`, `ativa`).
- **profiles**: `role` (`system_admin|company_admin|manager|employee`, legado `admin`
  equivale a `company_admin`), `manager_id`, `company_id` NOT NULL (empresa padrão).
- **user_companies**: associação `(user_id, company_id, role_in_company)` — todas as
  empresas do usuário. O backend resolve a empresa **ativa** por request e filtra
  explicitamente por ela no modo alternado.
- **punches**: ponto com lat/lon, `company_id` preenchido por trigger, anti-duplicação
  (mesmo tipo em 5 min + lock), auditoria em `punch_audit`.
- **holidays**: `company_id NULL` = nacional (BrasilAPI, via sync); NOT NULL = local
  da empresa (ex: DF 30/11).
- **payroll_closings**: snapshot por empresa/período gerado no fechamento da folha.
- Hierarquia: `system_admin` (plataforma) > `company_admin` (empresa) > `manager` > `employee`.

## 2) Rodar localmente

```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env   # edite com suas chaves
uvicorn app.main:app --reload
```
Acesse: <http://localhost:8000> · Health: `GET /api/health`

### Frontend React (`web/`)
O FastAPI serve o build em `/` quando `web/dist/index.html` existe (fallback:
template Jinja2 legado). A config pública do Supabase vem de
`GET /api/config` (URL + chave `anon` — pública por design).

```powershell
cd web
npm install          # apenas na 1ª vez
npm run build        # gera web/dist → acesse http://localhost:8000
npm run dev          # (opcional) Vite dev em :5173 com proxy /api → :8000
```

- Login por e-mail/senha (tenant resolvido **no backend**).
- `AuthContext` restaura a sessão, carrega `/api/me` e valida a empresa ativa
  salva (se o vínculo sumir, volta para a empresa padrão — sem relogin).
- Troca de empresa grava `localStorage` + header `X-Company-ID` por request.
- Operador: hero relógio + 4 botões + métricas + hoje/semana (sem edição).
- Gestor: equipe (aprovar/recusar, editar horário/obs), feriados (sync
  BrasilAPI + local), folha de ponto com impressão (só o espelho sai no papel)
  e fechamento de período (admin).
- Impressão: `Ctrl+P` com `@media print` isolando o card `#payroll-card`.

Seed de teste (rodar `seed.sql` — idempotente):
- Drogarias Por do Sol 2 LTDA (`66782325000181`):
  - **Milena** `milena@pordosol.com.br` e **José** `jose@pordosol.com.br` →
    `company_admin` nas **duas** farmácias (multi-empresa, sem relogin);
    Edenilza, Mayara, Deusiane, Pablo → `employee`.
- Drogarias ... Jardim Acropolis LTDA (`58102941000116`):
  - Tamara, Lorena, Jessica → `employee`.
- Senha de **todos**: `Senha123!`.

> ⚠️ Contas criadas via SQL precisam de `instance_id = '00000000-0000-0000-0000-000000000000'`
> em `auth.users` para o GoTrue enxergá-las (o seed já faz isso).

Regras por perfil:
- **employee (Operador)**: tela mínima — nome, cargo, 4 botões
  (Entrada · Saída Almoço/Intervalo · Retorno Almoço/Intervalo · Saída Final),
  registros de hoje e histórico simples da semana. **Sem nenhuma edição.**
- **manager/company_admin (Gestor)**: equipe completa, editar horário/nota de
  batidas, aprovar/rejeitar justificativas, fechar folha antes do PDF.
- **admin/system_admin (Administrador/Suporte)**: não vê botões de marcação
  (só o relógio); a API também rejeita batida desse perfil (`/api/clock` → 403).
  Painel Admin com Instituições/Empresas por CNPJ, árvore de colaboradores,
  marcações e histórico de auditoria.
- **Multi-empresa**: gestores com mais de um vínculo veem o seletor no cabeçalho;
  o backend valida `user_companies` e troca o escopo via `X-Company-ID`.

### Auditoria legal das alterações de ponto (Regra de Ouro)
Toda alteração (editar horário/observação, aprovar/recusar) passa por funções
SQL transacionais (`update_punch_with_audit` / `approve_punch_with_audit`):
`UPDATE` no ponto + `INSERT` em `logs_auditoria` **na mesma transação** do
banco. O log grava quem alterou (e-mail + nível de permissão), quem foi
alterado, valores antigo/novo, data/hora e justificativa obrigatória — sem
policy de escrita para `authenticated` (imutável pelo usuário). O backend
tenta a RPC e cai no caminho legado (trigger `punch_audit`) enquanto a
migração não for aplicada.

1. Rode [`migration_auditoria_logs.sql`](./migration_auditoria_logs.sql) no SQL Editor
   (idempotente; corrige as policies antigas ancoradas em `my_company_id()`,
   que negavam/invisibilizavam os logs de usuários multi-empresa como
   Milena/josé — veja [`docs/auditoria_legal.md`](./docs/auditoria_legal.md)).
2. Diagnóstico: [`queries_investigacao_logs.sql`](./queries_investigacao_logs.sql)
   (perfil × empresa vinculada × policies × testes de RLS).

Isolamento: header `X-Company-ID` de empresa fora do `user_companies` do usuário dá 403.

## 3) Feriados (BrasilAPI, grátis, sem token)

Nacionais via `GET https://brasilapi.com.br/api/feriados/v1/{ano}`.
Como `company_admin`: seção Feriados → **Sincronizar BrasilAPI** (5/hora, exige
service/secret key). Locais (ex: `2026-11-30` Dia do Evangélico DF): form
**Adicionar local** (visível só p/ admin da empresa).

## 4) Variáveis de ambiente
- `SUPABASE_URL` (obrigatória)
- `SUPABASE_ANON_KEY` ou `SUPABASE_PUBLISHABLE_KEY` (obrigatória, legado tem prioridade)
- `SUPABASE_SERVICE_ROLE_KEY` ou `SUPABASE_SECRET_KEY` (obrigatória p/ alternar de empresa e sync de feriados)
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
  main.py            # API + middleware de tenant + feriados + serve do build React
  templates/index.html   # fallback legado (Jinja2) se web/dist não existir
  static/js/app.js       # (legado)
web/                        # Frontend React (Vite + TypeScript + Tailwind v4 + Leaflet)
  src/
    components/             # Header, LoginCard, PunchCard, WeekMetrics, PunchLists,
                            # PunchMap, TeamPanel, AdminPanel, HolidaysPanel, PayrollPanel, Dashboard
    state/AuthContext.tsx   # sessão + empresa ativa (X-Company-ID) sem relogin
    lib/                    # supabase.ts (client via /api/config) + api.ts + utils.ts
    types.ts                # tipos 1:1 com as respostas da API
  dist/                     # build servido em / (gerado por `npm run build`)
supabase.sql                      # schema SaaS (tenants, RLS, triggers, holidays)
migration_multi_company.sql       # user_companies + helpers + RLS (multi-empresa)
migration_auditoria_logs.sql      # logs_auditoria + RPCs transacionais + correção RLS
queries_investigacao_logs.sql     # diagnóstico do bug de auditoria (RLS/escopo)
seed.sql                          # contas de teste (Senha123!) + multi-empresa
docs/auditoria_legal.md           # análise: bug, perfis, modelo de auditoria
requirements.txt
.env.example
```
