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
   Para o **Espelho de Ponto oficial** (Anexo II Portaria 1510), rode
   [`migration_espelho_mte.sql`](./migration_espelho_mte.sql) (idempotente; adiciona
   endereço da empresa e CPF/PIS/CTPS/cargo/admissão do empregado).
   Para o **Cadastro de Funcionário** (formulário + RPC transacional), rode
   [`migration_cadastro_funcionario.sql`](./migration_cadastro_funcionario.sql)
   (idempotente; cria a função `criar_funcionario` e garante as colunas cadastrais).
   Para o **Cadastro de Empresas** (endereço estruturado + RPC transacional), rode
   [`migration_empresas_cadastro.sql`](./migration_empresas_cadastro.sql)
   (idempotente; cria a função `criar_empresa` e adiciona `nome_fantasia`, `cep`,
   `logradouro`, `numero`, `bairro`, `cidade`, `uf` em `companies`).
   Para **Ativar/Desativar (Soft Delete)** de empresas e funcionários, rode
   [`migration_soft_delete.sql`](./migration_soft_delete.sql) (idempotente; adiciona
   `profiles.ativo` + trilha de inativação e as RPCs `atualizar_funcionario_status` /
   `atualizar_empresa_status` com cascata reversível).
4. Em **Project Settings → API**, copie (formato novo ou legado — ambos funcionam):
   - `Project URL` → `SUPABASE_URL`
   - `sb_publishable_` (ou `anon`) → `SUPABASE_PUBLISHABLE_KEY` (ou `SUPABASE_ANON_KEY`)
   - `sb_secret_` (ou `service_role`) → `SUPABASE_SECRET_KEY`
     (obrigatória para alternar de empresa — o backend usa service key no modo switched)

### Tabelas & RLS
- **companies**: tenants (`cnpj` único só-dígitos, `nome` = razão social, `nome_fantasia`,
  endereço estruturado `cep/logradouro/numero/bairro/cidade/uf`, `endereco` em texto
  livre usado no cabeçalho do Espelho MTE, `ativa`).
- **profiles**: `role` (`system_admin|company_admin|manager|employee`, legado `admin`
  equivale a `company_admin`), `manager_id`, `company_id` NOT NULL (empresa padrão),
  `ativo` (soft delete: `false` = funcionário desligado, sem acesso nem ponto).
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
- Logout usa `signOut({ scope: 'local' })`: encerra **só** a sessão deste
  navegador e limpa o estado local mesmo se o servidor recusar (evita o `403`
  do `/logout?scope=global` quando o token expirou). O cliente Supabase
  (`lib/supabase.ts`) define `persistSession`/`autoRefreshToken` explícitos.
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

### Relatório de Fechamento de Ponto (PDF + JSON)
Componente `ClosingReportPanel` (Dashboard, visível a **todos** os perfis) com
seletor de mês/ano obrigatório e exportação em **PDF** (conferência/impressão) e
**JSON** (integração direta com a folha do RH). Traz o espelho do mês com horas,
batidas **aprovadas/pendentes/recusadas** e **faltas justificadas x não
justificadas** (base de pagamento e desconto). Endpoints:

- `GET /api/reports/monthly.json?month=AAAA-MM[&user_id=][&cnpj=]`
  (lote: todos os colaboradores do escopo; inclui `espelhos_mte[]`)
- `GET /api/reports/monthly.json?month=AAAA-MM&format=mte[&user_id=]`
  (**Espelho oficial MTE** — Anexo II da Portaria 1510, **um** empregado)
- `GET /api/reports/monthly.pdf?month=AAAA-MM[&user_id=][&cnpj=]`
  (layout Anexo II + folha comercial: Marcações | Entrada | Início/Fim
  intervalo | Saída | CH | H.Extra | Tratamentos)

Hierarquia de acesso (validada no backend, `_report_targets`):
- **Funcionário**: só o próprio mês (`user_id` alheio → 403).
- **Gerente**: só a própria equipe (subordinados diretos via `manager_id`).
- **Administrador/RH** (`company_admin`/`system_admin`/`admin`): toda a empresa,
  com filtro por CNPJ (admin de plataforma pode escolher qualquer empresa).

**Tratamentos (Anexo II):** cada batida tratada vira uma linha `Horário ·
Ocorrência · Motivo`, com a ocorrência `D` (desconsiderada/recusada), `I`
(incluída com nota) ou `P` (pendente de aprovação do gestor).

**Faltas justificadas x não justificadas:** dia previsto de trabalho sem horas
trabalhadas. Se houver justificativa (`punches.note`) em qualquer batida do dia
(inclusive recusada), é **justificada** (não descontar); caso contrário, é
**não justificada** (desconto salarial).

**Cadastro exigido pelo Anexo II:** rode
[`migration_espelho_mte.sql`](./migration_espelho_mte.sql) (idempotente) para
habilitar `companies.endereco` e `profiles.cpf/.pis/.ctps/.cargo/.data_admissao`.
Sem esses dados, o PDF/JSON exibem `—`; nada quebra.

Dependência nova: `reportlab` (PDF). Sem ela, o endpoint PDF responde 501 com
mensagem clara, sem derrubar o resto.

### Home do Administrador e Cadastro de Empresas (Super Admin)

O Administrador (`system_admin`/`admin`) **não** vê funcionários soltos na home.
Ele vê um **catálogo de Empresas (CNPJs)** em cards, com busca por CNPJ/razão
social/fantasia/cidade e a contagem de colaboradores por loja.

- **Lista de Empresas**: cards com razão social, nome fantasia, CNPJ formatado,
  endereço e status (Ativa/Inativa). Botão azul **"Cadastrar Empresa"** em
  destaque abre o formulário.
- **Formulário de Empresa** (modal): CNPJ (com dígitos verificadores), Razão
  Social, Nome Fantasia e Endereço Completo (CEP, Logradouro, Número, Bairro,
  Cidade, UF). O backend valida e grava via RPC transacional `criar_empresa`;
  o endereço estruturado também alimenta o texto livre `companies.endereco`
  usado no cabeçalho do Espelho MTE.
- **Drill-down**: clicar num card abre o **Painel da Loja** (abas
  *Colaboradores · Cadastrar Usuário/Funcionário · Marcações · Auditoria*).
  O cadastro de funcionário feito aqui **não pede a empresa**: o `company_id`
  é herdado da loja aberta (estado da página), garantindo que o usuário nasça
  exatamente naquele CNPJ.

Endpoints: `GET/POST /api/admin/companies`,
`GET /api/admin/companies/{id}`, `POST /api/admin/employees`.
Requer [`migration_empresas_cadastro.sql`](./migration_empresas_cadastro.sql).

### Cadastro de Funcionário (Gestor + Drill-down do Admin)

O cadastro **não** é mais um atalho global no cabeçalho:

- **Gestor de loja**: vê a aba **"Cadastrar funcionário"** no topo (só ele);
  a empresa é travada na dele e o novo funcionário entra com `manager_id` = o
  próprio gestor.
- **Administrador**: cadastra **de dentro de uma loja** (Dashboard → Empresa →
  aba *Cadastrar Usuário/Funcionário*). A empresa é herdada e o campo some.
  O Admin pode ainda indicar um **Gestor responsável** (validado na mesma
  empresa); sem isso, o funcionário entra sem gestor.
- Funcionário comum não vê nenhuma dessas telas; o endpoint responde 403.

- **Formulário**: nome, CPF, e-mail (login), senha provisória, perfil
  (Funcionário/Gestor), escala inicial (Padrão 5x2 · 12x36 · Personalizada) +
  vigência e carga diária. Dados do Anexo II opcionais (PIS, CTPS, cargo,
  admissão).
- **Transacional (tudo ou nada)**: o backend cria o usuário em `auth.users`
  (Admin API) e chama a RPC `public.criar_funcionario(...)`, que grava
  `profiles` + `user_companies` + `escalas` numa **única transação**. Se a RPC
  falhar, o backend **apaga o usuário auth** (rollback compensatório) — nunca
  fica um cadastro pela metade.
- **Senha provisória**: definida pelo Admin/Gestor; `user_metadata`
  `must_change_password=true` (troca no 1º login).
- **Escala**: a RPC encerra a escala vigente anterior (`valid_to`) e insere a
  nova, preservando o histórico (uma vigente por usuário).

Endpoints: `POST /api/admin/employees` e `GET /api/companies/options`.
Requer [`migration_cadastro_funcionario.sql`](./migration_cadastro_funcionario.sql).

### Ativar / Desativar (Soft Delete) — Empresas e Funcionários

**Regra de negócio: nunca existe `DELETE`.** A legislação trabalhista exige
guardar o histórico de ponto por anos; apagar um funcionário ou uma empresa
destruiria provas legais. Portanto, "excluir" aqui é sempre **inativar**
(soft delete): apenas o status muda, o dado permanece.

**Onde fica o status**
- **Empresa**: `companies.ativa` (já existia) + trilha `inativado_em`,
  `inativado_por`.
- **Funcionário**: `profiles.ativo` (`true`/`false`) + `inativado_em`,
  `inativado_por` e `reativar_em_cascata`.

**Interface (anti-erro)**
- Cards de empresa e a tabela de colaboradores têm botões **Desativar/Ativar**.
- **Desativar** nunca é um clique só: abre um **modal de confirmação** que exige
  **digitar o nome** (funcionário/empresa) e lista as consequências. **Reativar**
  também pede confirmação (mais simples), evitando clique duplo acidental.
- Filtro **Todas / Ativas / Inativas** e selo de status (Ativa/Inativa) nas
  listagens do Administrador.

**Respostas de arquitetura (casos de uso)**

1. **Login / Supabase Auth**: ao desativar, o backend chama a **Admin API do
   GoTrue** (`PUT /auth/v1/admin/users/{id}` com `ban_duration`) e **revoga as
   sessões** (`.../logout`). O funcionário **não loga mais nem mantém sessão**.
   Ao reativar, o ban é removido (`ban_duration: "none"`). O banco é a fonte da
   verdade — mesmo sem service key, o `resolve_auth` barra o acesso pelo
   `profiles.ativo`.

2. **Registro de ponto**: `/api/clock` recusa (HTTP 403) quando o funcionário
   está inativo **ou** quando a empresa está inativa. Além disso, o próprio
   `resolve_auth` já nega qualquer request de usuário inativo (defesa em
   profundidade).

3. **Cascata Empresa → Funcionários**: desativar a empresa **inativa em cascata**
   todos os funcionários que ainda estavam ativos e marca neles
   `reativar_em_cascata=true`. Ao **reativar** a empresa, **só** esses voltam —
   quem já estava inativo por conta própria **continua inativo**. Nada é
   apagado, e a operação é reversível e auditável.

Endpoints: `POST /api/admin/companies/{id}/status` (empresa, com cascata) e
`POST /api/admin/employees/{id}/status` (funcionário). O Gestor só altera
funcionários da própria empresa e ninguém pode desativar a si mesmo.
Requer [`migration_soft_delete.sql`](./migration_soft_delete.sql).

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
                            # PunchMap, TeamPanel, AdminPanel (home do Admin: empresas),
                            # CompanyPanel (painel da loja), CompanyFormModal (cadastrar
                            # empresa), HolidaysPanel, PayrollPanel,
                            # ClosingReportPanel (relatório PDF/JSON),
                            # RegisterEmployeePanel (cadastro de funcionário), Dashboard
    state/AuthContext.tsx   # sessão + empresa ativa (X-Company-ID) sem relogin
    lib/                    # supabase.ts (client via /api/config) + api.ts + utils.ts
    types.ts                # tipos 1:1 com as respostas da API
  dist/                     # build servido em / (gerado por `npm run build`)
supabase.sql                      # schema SaaS (tenants, RLS, triggers, holidays)
migration_multi_company.sql       # user_companies + helpers + RLS (multi-empresa)
migration_auditoria_logs.sql      # logs_auditoria + RPCs transacionais + correção RLS
migration_espelho_mte.sql         # endereço da empresa + CPF/PIS/CTPS/cargo/admissão
migration_cadastro_funcionario.sql # RPC criar_funcionario (cadastro transacional)
migration_empresas_cadastro.sql   # cadastro de empresa: endereço estruturado + RPC criar_empresa
migration_soft_delete.sql         # Ativar/Desativar (soft delete) empresas + funcionários
migration_escalas.sql             # escalas com vigência + dias_esperados() (12x36)
seed_massa_12x36.sql              # massa de teste 12x36 (auto-curativa)
relatorio_mensal.sql              # relatório mensal via SQL Editor (somente leitura)
diag_escalas.sql                  # diagnóstico das escalas cadastradas
queries_investigacao_logs.sql     # diagnóstico do bug de auditoria (RLS/escopo)
seed.sql                          # contas de teste (Senha123!) + multi-empresa
docs/auditoria_legal.md           # análise: bug, perfis, modelo de auditoria
test_timesheet_12x36.py           # testes do motor de jornada/escala 12x36
test_relatorio_fechamento.py      # testes do relatório (faltas, contagens, PDF)
test_relatorio_endpoints.py       # testes dos endpoints + hierarquia de acesso
test_espelho_mte.py               # testes do Espelho MTE (Anexo II Portaria 1510)
test_cadastro_funcionario.py      # testes do cadastro (hierarquia + rollback)
test_soft_delete.py               # testes de Ativar/Desativar (cascata + bloqueios)
requirements.txt
.env.example
```
