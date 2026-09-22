-- ============================================================
-- SEED — Usuários e empresas de teste (senha padrão: Senha123!)
-- ============================================================
-- Rode DEPOIS de migration_multi_company.sql, no SQL Editor.
-- Idempotente: upsert por e-mail (índice parcial users_email_partial_key).
--
-- Contas:
--   Drogarias Por do Sol 2 LTDA (66782325000181)
--     Milena (milena@pordosol.com.br)  company_admin  [2 empresas]
--     José   (jose@pordosol.com.br)    company_admin  [2 empresas]
--     Edenilza, Mayara, Deusiane, Pablo -> employee
--   Drogarias ... Jardim Acropolis LTDA (58102941000116)
--     Tamara, Lorena, Jessica -> employee
--   Empresa Padrão (00000000000000) — contas legadas
--     admin@teste.com (company_admin), gestor@teste.com (manager), colab@teste.com (employee)
--
-- PONTO CRÍTICO (aprendido na prática):
--   auth.users.instance_id DEVE ser '00000000-0000-0000-0000-000000000000'.
--   Linhas com instance_id NULL ficam INVISÍVEIS para o GoTrue (login 400).
-- ============================================================

-- PRIMEIRO STATEMENT do script (auto-reparo, idempotente):
-- garante a UNIQUE (user_id, company_id) em user_companies ANTES de qualquer
-- upsert. Se a tabela já existia sem a PK (run parcial/anterior), este bloco
-- adiciona a constraint e os ON CONFLICT do script passam a funcionar.
DO $$
BEGIN
  IF to_regclass('public.user_companies') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'user_companies_pkey'
         AND conrelid = 'public.user_companies'::regclass
     )
  THEN
    DELETE FROM public.user_companies a
    USING public.user_companies b
    WHERE a.ctid > b.ctid
      AND a.user_id IS NOT DISTINCT FROM b.user_id
      AND a.company_id IS NOT DISTINCT FROM b.company_id;

    ALTER TABLE public.user_companies
      ADD CONSTRAINT user_companies_pkey PRIMARY KEY (user_id, company_id);
  END IF;
END $$;

-- ---------- 0) Empresas (upsert por cnpj SEM depender de constraint única) ----------
-- Implementado em plpgsql de propósito: o banco real pode não ter UNIQUE em
-- companies.cnpj (a migration_auditoria adiciona a coluna sem a constraint), e
-- nesse caso ON CONFLICT (cnpj) falharia com 42P10 em TODO run. Este loop
-- atualiza/insere sem exigir nenhuma constraint.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('66782325000181','Drogarias Por do Sol 2 LTDA', true),
    ('58102941000116','Drogarias Por do Sol Drogaria Jardim Acropolis LTDA', true),
    ('00000000000000','Empresa Padrão (migração v1)', true)
  ) AS v(cnpj, nome, ativa) LOOP
    IF EXISTS (SELECT 1 FROM public.companies WHERE cnpj = r.cnpj) THEN
      UPDATE public.companies
        SET nome = r.nome, ativa = true
      WHERE cnpj = r.cnpj;
    ELSE
      INSERT INTO public.companies (cnpj, nome, ativa)
      VALUES (r.cnpj, r.nome, r.ativa);
    END IF;
  END LOOP;
END $$;

-- ---------- 1) Lista de usuários do seed ----------
-- TEMP TABLE deliberadamente SEM "ON COMMIT DROP": o SQL Editor pode
-- auto-commitar statement a statement; a tabela precisa sobreviver
-- até o fim do script. Limpeza explícita no final.
CREATE TEMP TABLE seed_users AS
SELECT * FROM (VALUES
  ('edenilza@pordosol2.com.br', 'Edenilza', '66782325000181', 'employee'),
  ('mayara@pordosol2.com.br',   'Mayara',   '66782325000181', 'employee'),
  ('deusiane@pordosol2.com.br', 'Deusiane', '66782325000181', 'employee'),
  ('pablo@pordosol2.com.br',    'Pablo',    '66782325000181', 'employee'),
  ('milena@pordosol.com.br',    'Milena',   '66782325000181', 'company_admin'),
  ('jose@pordosol.com.br',      'José',     '66782325000181', 'company_admin'),
  ('tamara@acropolis.com.br',   'Tamara',   '58102941000116', 'employee'),
  ('lorena@acropolis.com.br',   'Lorena',   '58102941000116', 'employee'),
  ('jessica@acropolis.com.br',  'Jessica',  '58102941000116', 'employee'),
  ('admin@teste.com',           'Administrador', '00000000000000', 'company_admin'),
  ('gestor@teste.com',          'Gestor',        '00000000000000', 'manager'),
  ('colab@teste.com',           'Colaborador',   '00000000000000', 'employee')
) AS t(email, full_name, cnpj, role);

-- ---------- 2) auth.users ----------
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, email_change,
  email_change_token_new, recovery_token
)
SELECT
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated', 'authenticated',
  su.email,
  extensions.crypt('Senha123!', extensions.gen_salt('bf')),
  now(),
  jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
  jsonb_build_object(
    'sub',       su.email,
    'email',     su.email,
    'full_name', su.full_name,
    'cnpj',      su.cnpj,
    'company_id', c.id::text,
    'role',      su.role
  ),
  now(), now(), '', '', '', ''
FROM seed_users su
JOIN public.companies c ON c.cnpj = su.cnpj
ON CONFLICT (email) WHERE deleted_at IS NULL
DO UPDATE SET
  encrypted_password    = EXCLUDED.encrypted_password,
  email_confirmed_at    = now(),
  instance_id           = EXCLUDED.instance_id,
  aud                   = EXCLUDED.aud,
  role                  = EXCLUDED.role,
  raw_app_meta_data     = EXCLUDED.raw_app_meta_data,
  raw_user_meta_data    = EXCLUDED.raw_user_meta_data,
  updated_at            = now();

-- ---------- 3) auth.identities (login por e-mail/senha exige identity) ----------
INSERT INTO auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
SELECT
  u.id,
  u.id,
  u.email,
  jsonb_build_object(
    'sub', u.id::text, 'email', u.email,
    'email_verified', false, 'phone_verified', false
  ),
  'email',
  now(), now(), now()
FROM auth.users u
JOIN seed_users su ON su.email = u.email
ON CONFLICT DO NOTHING;

-- ---------- 4) public.profiles (role + empresa padrão) ----------
INSERT INTO public.profiles (id, full_name, role, company_id)
SELECT u.id, su.full_name, su.role, c.id
FROM seed_users su
JOIN auth.users u ON u.email = su.email
JOIN public.companies c ON c.cnpj = su.cnpj
ON CONFLICT (id) DO UPDATE SET
  full_name  = EXCLUDED.full_name,
  role       = EXCLUDED.role,
  company_id = EXCLUDED.company_id;

-- ---------- 5) user_companies (vínculo completo, multi-empresa) ----------
-- Empresa primária (padrão) de cada um:
INSERT INTO public.user_companies (user_id, company_id, role_in_company)
SELECT u.id, c.id, su.role
FROM seed_users su
JOIN auth.users u ON u.email = su.email
JOIN public.companies c ON c.cnpj = su.cnpj
ON CONFLICT (user_id, company_id) DO UPDATE SET role_in_company = EXCLUDED.role_in_company;

-- Milena e José também vinculados à ACROPOLIS (mesmo login, 2 CNPJs):
INSERT INTO public.user_companies (user_id, company_id, role_in_company)
SELECT u.id, c.id, 'company_admin'
FROM seed_users su
JOIN auth.users u ON u.email = su.email
JOIN public.companies c ON c.cnpj = '58102941000116'
WHERE su.email IN ('milena@pordosol.com.br', 'jose@pordosol.com.br')
ON CONFLICT (user_id, company_id) DO UPDATE SET role_in_company = EXCLUDED.role_in_company;

-- ---------- 6) Prova ----------
SELECT
  su.email,
  p.full_name,
  p.role                     AS role_global,
  c.nome                     AS empresa_padrao,
  count(uc.company_id)       AS n_empresas,
  array_agg(cc.nome ORDER BY cc.nome) AS empresas
FROM seed_users su
JOIN auth.users u ON u.email = su.email
JOIN public.profiles p ON p.id = u.id
JOIN public.companies c ON c.id = p.company_id
LEFT JOIN public.user_companies uc ON uc.user_id = p.id
LEFT JOIN public.companies cc ON cc.id = uc.company_id
GROUP BY su.email, p.full_name, p.role, c.nome
ORDER BY su.email;

-- ---------- 7) Limpeza ----------
DROP TABLE IF EXISTS seed_users;