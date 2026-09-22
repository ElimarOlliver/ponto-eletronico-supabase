-- ============================================================
-- SEED — Usuários e empresas de teste (senha padrão: Senha123!)
-- ============================================================
-- Rode DEPOIS de migration_multi_company.sql, no SQL Editor.
--
-- Sem NENHUM "ON CONFLICT": todos os upserts usam loops plpgsql com
-- EXISTS -> UPDATE/INSERT. Imune ao erro 42P10 (falta de constraint única
-- não importa — o script resolve a existência manualmente).
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

-- ---------- 0) Empresas (upsert por cnpj) ----------
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
-- DROP prévio: se um run anterior falhou antes da limpeza e a sessão do SQL
-- Editor for reutilizada, o CREATE falharia com "relation seed_users already
-- exists" (42P06). O DROP final (seção 7) continua existindo.
DROP TABLE IF EXISTS seed_users;

-- TEMP TABLE deliberadamente SEM "ON COMMIT DROP": o SQL Editor pode
-- auto-commitar statement a statement; a tabela precisa sobreviver
-- até o fim do script. Limpeza explícita no final.
-- role é DECLARADA como public.user_role de propósito: com CREATE ... AS,
-- o engine infere text e os UPDATE/INSERT em profiles.role (enum) e
-- user_companies.role_in_company (enum) falham com 42804.
CREATE TEMP TABLE seed_users (
  email     text,
  full_name text,
  cnpj      text,
  role      public.user_role
);

INSERT INTO seed_users (email, full_name, cnpj, role) VALUES
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
  ('colab@teste.com',           'Colaborador',   '00000000000000', 'employee');

-- ---------- 2) auth.users (upsert por e-mail) ----------
DO $$
DECLARE
  r     record;
  v_uid uuid;
BEGIN
  FOR r IN SELECT * FROM seed_users LOOP
    SELECT id INTO v_uid FROM auth.users WHERE email = r.email AND deleted_at IS NULL;

    IF v_uid IS NULL THEN
      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, email_change,
        email_change_token_new, recovery_token
      ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        gen_random_uuid(),
        'authenticated', 'authenticated',
        r.email,
        extensions.crypt('Senha123!', extensions.gen_salt('bf')),
        now(),
        jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
        jsonb_build_object(
          'sub', r.email, 'email', r.email, 'full_name', r.full_name,
          'cnpj', r.cnpj,
          'company_id', (SELECT id FROM public.companies WHERE cnpj = r.cnpj)::text,
          'role', r.role
        ),
        now(), now(), '', '', '', ''
      );
    ELSE
      UPDATE auth.users SET
        encrypted_password    = extensions.crypt('Senha123!', extensions.gen_salt('bf')),
        email_confirmed_at    = now(),
        instance_id           = '00000000-0000-0000-0000-000000000000',
        aud                   = 'authenticated',
        role                  = 'authenticated',
        raw_app_meta_data     = jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
        raw_user_meta_data    = jsonb_build_object(
          'sub', r.email, 'email', r.email, 'full_name', r.full_name,
          'cnpj', r.cnpj,
          'company_id', (SELECT id FROM public.companies WHERE cnpj = r.cnpj)::text,
          'role', r.role
        ),
        updated_at            = now()
      WHERE id = v_uid;
    END IF;
  END LOOP;
END $$;

-- ---------- 3) auth.identities (login por e-mail/senha exige identity) ----------
-- provider_id do GoTrue p/ login email = e-mail; PK é (provider, id=user_id).
DO $$
DECLARE
  r record;
  v_uid uuid;
  v_exist boolean;
BEGIN
  FOR r IN SELECT su.email, u.id FROM seed_users su
           JOIN auth.users u ON u.email = su.email AND u.deleted_at IS NULL LOOP
    SELECT EXISTS (
      SELECT 1 FROM auth.identities i
      WHERE i.provider = 'email'
        AND (i.provider_id = r.email OR i.id = r.id)
    ) INTO v_exist;

    IF NOT v_exist THEN
      INSERT INTO auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) VALUES (
        r.id, r.id, r.email,
        jsonb_build_object(
          'sub', r.id::text, 'email', r.email,
          'email_verified', false, 'phone_verified', false
        ),
        'email', now(), now(), now()
      );
    END IF;
  END LOOP;
END $$;

-- ---------- 4) public.profiles (role + empresa padrão) ----------
DO $$
DECLARE
  r record;
  v_uid   uuid;
  v_cid   uuid;
  v_exist boolean;
BEGIN
  FOR r IN SELECT su.email, su.full_name, su.role, u.id, c.id AS company_id
           FROM seed_users su
           JOIN auth.users u  ON u.email = su.email AND u.deleted_at IS NULL
           JOIN public.companies c ON c.cnpj = su.cnpj LOOP
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = r.id) INTO v_exist;
    IF v_exist THEN
      UPDATE public.profiles
         SET full_name = r.full_name, role = r.role, company_id = r.company_id
       WHERE id = r.id;
    ELSE
      INSERT INTO public.profiles (id, full_name, role, company_id)
      VALUES (r.id, r.full_name, r.role, r.company_id);
    END IF;
  END LOOP;
END $$;

-- ---------- 5) user_companies (vínculo completo, multi-empresa) ----------
-- Empresa primária (padrão) de cada um:
DO $$
DECLARE
  r record;
  v_exist boolean;
BEGIN
  FOR r IN SELECT u.id, c.id AS company_id, su.role
           FROM seed_users su
           JOIN auth.users u  ON u.email = su.email AND u.deleted_at IS NULL
           JOIN public.companies c ON c.cnpj = su.cnpj LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.user_companies
      WHERE user_id = r.id AND company_id = r.company_id
    ) INTO v_exist;
    IF v_exist THEN
      UPDATE public.user_companies SET role_in_company = r.role
       WHERE user_id = r.id AND company_id = r.company_id;
    ELSE
      INSERT INTO public.user_companies (user_id, company_id, role_in_company)
      VALUES (r.id, r.company_id, r.role);
    END IF;
  END LOOP;
END $$;

-- Milena e José também vinculados à ACROPOLIS (mesmo login, 2 CNPJs):
DO $$
DECLARE
  r record;
  v_acropolis uuid;
  v_exist boolean;
BEGIN
  SELECT id INTO v_acropolis FROM public.companies WHERE cnpj = '58102941000116';
  IF v_acropolis IS NULL THEN
    RAISE EXCEPTION 'Empresa Acropolis não encontrada (rode a seção de empresas antes)';
  END IF;

  FOR r IN SELECT u.id FROM seed_users su
           JOIN auth.users u ON u.email = su.email AND u.deleted_at IS NULL
           WHERE su.email IN ('milena@pordosol.com.br', 'jose@pordosol.com.br') LOOP
    SELECT EXISTS (
      SELECT 1 FROM public.user_companies
      WHERE user_id = r.id AND company_id = v_acropolis
    ) INTO v_exist;
    IF v_exist THEN
      UPDATE public.user_companies SET role_in_company = 'company_admin'
       WHERE user_id = r.id AND company_id = v_acropolis;
    ELSE
      INSERT INTO public.user_companies (user_id, company_id, role_in_company)
      VALUES (r.id, v_acropolis, 'company_admin');
    END IF;
  END LOOP;
END $$;

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