# Auditoria Legal de Marcações de Ponto

> Análise, diagnóstico e solução da separação de perfis (Colaborador, Gestor,
> Administrador) + sistema de auditoria imutável de alterações de ponto.

---

## 1. Diagnóstico do bug — "o banco não registra ações de Milena/josé"

### Causa raiz (confirmada por investigação)

As policies de RLS de `punches`, `punch_audit` e `profiles` estão ancoradas em
`company_id = my_company_id()`, onde `my_company_id()` lê **apenas**
`profiles.company_id` (a empresa *padrão* do usuário). A tabela de associação
multi-empresa criada na migração (`user_companies`) é **ignorada** pelas
políticas antigas.

Consequência para usuários multi-empresa (Milena é `company_admin` da
Pordosol 2, mas também opera na Pordosol 1; "jose" é gestor de outra empresa):

1. Ao operar na **empresa alternada**, o `UPDATE` em `punches` com o JWT do
   usuário é **negado silenciosamente** pela RLS (`my_company_id()` aponta
   para a empresa padrão, que não é a do punch). O PostgREST devolve 0 linhas
   → a API respondia `404 "Punch não encontrado"` — e o **log nunca nasce**.
2. Quando a alteração era feita pela **service key** (modo "switched" do
   backend), o `INSERT` em `punch_audit` pelo trigger **até acontecia**, mas a
   policy de *leitura* do `punch_audit` também usa `my_company_id()` — os
   registros existiam e ficavam **invisíveis** para o usuário na empresa
   alternada. Ou seja: "não registra" = era negado **ou** invisível.
3. O `punch_audit` (tabela legada) registrava apenas `old_row / new_row /
   actor` — **sem justificativa, sem e-mail do autor e sem o nível de
   permissão** — insuficiente para a exigência legal de registros de
   alteração.

### Por que o trigger não era o problema

O trigger `audit_punch()` é `SECURITY DEFINER`: o `INSERT` no `punch_audit`
nunca foi bloqueado por RLS. O que falta é a **transação atômica** entre o
UPDATE do ponto e a gravação do log, e o **escopo correto por empresa**.

### Provas (queries em `queries_investigacao_logs.sql`)

- Seção 1/2: empresa padrão vs. `user_companies` de Milena/josé (a divergência).
- Seção 3: registros de `punch_audit` que existem mas ficam invisíveis.
- Seção 5: policies ativas com `my_company_id()` (as que negam).
- Seção 6: dados sujos que podem quebrar INSERT de log (órfãos/ator sem profile).

---

## 2. Arquitetura de perfis

| Perfil (role) | Bate ponto | Gerencia equipe | Altera/aprova pontos | Painel Admin (todas as empresas) |
|---|---|---|---|---|
| `employee` (Colaborador) | ✅ | ❌ | ❌ | ❌ |
| `manager` (Gestor) | ✅ | ✅ | ✅ (com justificativa) | ❌ |
| `company_admin` (Milena) | ✅ | ✅ | ✅ (com justificativa) | ❌ |
| `admin` / `system_admin` (Administrador/Suporte) | ❌ * | ✅ | ✅ (com justificativa) | ✅ |

\* O perfil Administrador **não vê os botões de marcação** — apenas o relógio
ao vivo e o Painel Admin. (Regra: admin bate ponto via API em casos
excepcionais; a UI não expõe a marcação.)

**Middlewares de perfil no backend** (`app/main.py`):
- `_require_manager(prof)` → `manager, company_admin, system_admin, admin`.
- `_require_company_admin(prof)` → `company_admin, system_admin, admin`.
- `_require_system_admin(prof)` → `system_admin, admin` (Painel Admin).

---

## 3. Modelo de dados da auditoria

Nova tabela `logs_auditoria` (imutável, somente leitura após escrita):

```sql
logs_auditoria (
  id bigserial PRIMARY KEY,
  punch_id bigint,                  -- ponte com o punch alterado
  empresa_id uuid,                  -- empresa do punch (escopo)
  alterado_por uuid,                -- quem alterou (authenticated via RPC)
  alterado_por_email text,          -- e-mail/login (gravado via SQL)
  alterado_por_role text,           -- nível de permissão (ex.: system_admin)
  usuario_alterado uuid,            -- de quem era o ponto
  usuario_alterado_nome text,
  valor_antigo jsonb,               -- linha antes (occurred_at, note, ...)
  valor_novo   jsonb,               -- linha depois
  acao text,                        -- insert | update | approve | reject | delete
  justificativa text,               -- obrigatória para gestor/admin
  created_at timestamptz NOT NULL DEFAULT now()
)
```

### Escrita 100% via funções SQL transacionais (`SECURITY DEFINER`)

As únicas portas de escrita são as funções `update_punch_with_audit(...)` e
`approve_punch_with_audit(...)`:

- **Atomicidade (Regra de Ouro):** `UPDATE punches` + `INSERT logs_auditoria`
  na **mesma transação** dentro do Postgres — ou acontecem os dois, ou nenhum.
  O frontend/backend nunca mais dependem de "update de um lado, log de outro".
- **Integridade do autor:** o log grava `auth.uid()` vindo da sessão (validação
  interna `is_member_company` + `can_edit_punch`), nunca um parâmetro forjado
  pela API.
- **Imutabilidade:** não há policy `INSERT/UPDATE/DELETE` para `authenticated`
  em `logs_auditoria` — usuário logado (nem o gestor) consegue apagar ou forjar
  um registro. Apenas `service_role` (superusuário) pode, e só via SQL direto.

### Acesso (RLS SELECT)

- `system_admin` (e `admin` = suporte/desenvolvedor): vê logs de **todas** as
  empresas.
- `company_admin` / `manager`: vê apenas os logs das empresas em que é membro
  (`is_member_company` via `user_companies` OU `profiles.company_id` — cobre
  pré e pós-migração).

---

## 4. Como aplicar no Supabase

1. Abra o **SQL Editor** do projeto.
2. Rode `migration_multi_company.sql` e `seed.sql` (se ainda não rodou — cria a
   estrutura multi-empresa e as 2 farmácias + usuários de teste).
3. Rode `migration_auditoria_logs.sql` — é **idempotente** e **não quebra** o
   schema atual:
   - ajusta `companies`/`profiles`/`punches` com `ADD COLUMN IF NOT EXISTS`;
   - cria `helpers is_member_company` (com fallback para `user_companies`);
   - cria `logs_auditoria` + policies;
   - cria `can_edit_punch`, `update_punch_with_audit`, `approve_punch_with_audit`,
     `get_audit_logs`;
   - **corrige** as policies antigas de `punch_audit`/`punches` para usarem
     `is_member_company` (bug Milena/josé);
   - passo **opcional ao final**: promover um perfil existente para
     `system_admin` (descomente o bloco e ajuste o e-mail) para acessar o
     Painel Admin.
4. Diagnóstico/auditoria: `queries_investigacao_logs.sql` (seções 1–8).

### Backend — fallback sem quebra

Os endpoints `/api/punch-update` e `/api/punch-approve` tentam primeiro a RPC
transacional. Se a função não existir no banco (migração ainda não aplicada),
**caem no caminho legado** (UPDATE direto + trigger `punch_audit`) com um
warning no log — o sistema continua 100% funcional. Ao aplicar a migração, o
caminho auditado passa a valer automaticamente, sem deploy.

---

## 5. Interface

- **Dashboard**: por `role`, o React decide o que renderizar
  (`web/src/components/Dashboard.tsx`):
  - `employee`: relógio + botões + meus pontos (mínimo).
  - `manager` / `company_admin`: + Equipe, feriados e folha.
  - `admin` / `system_admin`: relógio **sem botões** (`readOnly`) + Painel
    Admin.
- **Painel Admin** (`web/src/components/AdminPanel.tsx`):
  1. Instituições/Empresas por CNPJ (cards com status ativa/inativa e nº de
     colaboradores);
  2. árvore de colaboradores da empresa (com e-mail e papel);
  3. marcações do colaborador (filtráveis por período) com ações aprovar /
     recusar / editar horário / editar observação;
  4. **Histórico de Auditoria**: quem alterou (e-mail + permissão), colaborador
     alterado, ação, justificativa e data/hora.
- **Justificativa obrigatória**: toda ação (aprovar/recusar/editar) abre o
  prompt nativo "Justificativa obrigatória". Sem texto, a ação é cancelada.