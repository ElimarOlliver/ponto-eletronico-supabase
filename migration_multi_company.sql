-- ============================================================
-- MIGRAÇÃO — Multi-empresa por usuário (gestores com N CNPJs)
-- Projeto: Ponto Eletrônico SaaS multi-tenant
-- Idempotente. Rode no SQL Editor (painel Supabase).
--
-- Modelo:
--   profiles.company_id        = empresa PADRÃO/ativa no login (não muda)
--   user_companies(user_id, company_id, role_in_company)
--                              = TODAS as empresas do usuário (superset)
--   Backend resolve a empresa ATIVA por request (header X-Company-ID)
--   e valida a associação aqui; RLS continua como defesa em profundidade
--   para o tenant padrão.
-- ============================================================

-- ---------- 1) Tabela de associação usuário <-> empresa ----------
CREATE TABLE IF NOT EXISTS public.user_companies (
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role_in_company  public.user_role NOT NULL DEFAULT 'employee',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_uc_company ON public.user_companies (company_id);
CREATE INDEX IF NOT EXISTS idx_uc_user    ON public.user_companies (user_id);

-- ---------- 2) Helpers (SECURITY DEFINER, mesmo padrão do schema) ----------
CREATE OR REPLACE FUNCTION public.my_companies()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company_id FROM public.user_companies WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_member_of(uid uuid, cid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_companies uc
    WHERE uc.user_id = uid AND uc.company_id = cid
  );
$$;

GRANT EXECUTE ON FUNCTION public.my_companies() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_member_of(uuid, uuid) TO authenticated;

-- ---------- 3) Backfill: usuários existentes viram membros da empresa deles ----------
-- Torna a associação fonte única para TODOS (inclusive single-company),
-- sem quebrar nada: a empresa padrão continua em profiles.company_id.
INSERT INTO public.user_companies (user_id, company_id, role_in_company)
SELECT p.id, p.company_id, p.role
FROM public.profiles p
ON CONFLICT (user_id, company_id) DO NOTHING;

-- ---------- 4) handle_new_user: novo signup também vira membro da empresa ----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company uuid;
  v_meta text;
  v_meta_cnpj text;
BEGIN
  v_meta := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'company_id', '')), '');
  IF v_meta IS NOT NULL THEN
    BEGIN
      v_company := v_meta::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_company := NULL;
    END;
  END IF;

  v_meta_cnpj := regexp_replace(COALESCE(NEW.raw_user_meta_data->>'cnpj', ''), '\D', '', 'g');
  IF v_company IS NULL AND v_meta_cnpj <> '' THEN
    SELECT id INTO v_company FROM public.companies WHERE cnpj = v_meta_cnpj;
  END IF;

  IF v_company IS NULL THEN
    SELECT id INTO v_company FROM public.companies WHERE cnpj = '00000000000000';
  END IF;

  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Signup exige company_id ou cnpj válido nos metadados do usuário';
  END IF;

  INSERT INTO public.profiles (id, full_name, role, company_id)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''), NEW.email),
    'employee',
    v_company
  )
  ON CONFLICT (id) DO NOTHING;

  -- Multi-empresa: todo usuário nasce vinculado à empresa definida no signup.
  INSERT INTO public.user_companies (user_id, company_id, role_in_company)
  VALUES (NEW.id, v_company, 'employee')
  ON CONFLICT (user_id, company_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---------- 5) RLS (defesa em profundidade; backend usa service key) ----------
ALTER TABLE public.user_companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uc self select" ON public.user_companies;
CREATE POLICY "uc self select"
ON public.user_companies FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "uc company_admin select company" ON public.user_companies;
CREATE POLICY "uc company_admin select company"
ON public.user_companies FOR SELECT TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

DROP POLICY IF EXISTS "uc system_admin all" ON public.user_companies;
CREATE POLICY "uc system_admin all"
ON public.user_companies FOR ALL TO authenticated
USING (public.is_system_admin(auth.uid()))
WITH CHECK (public.is_system_admin(auth.uid()));

-- ---------- 6) Prova ----------
SELECT
  p.full_name, p.role,
  u.email,
  count(uc.company_id) AS n_empresas,
  string_agg(c.nome, ' | ' ORDER BY c.nome) AS empresas
FROM public.user_companies uc
JOIN public.profiles p ON p.id = uc.user_id
JOIN auth.users u ON u.id = p.id
JOIN public.companies c ON c.id = uc.company_id
GROUP BY p.full_name, p.role, u.email
ORDER BY u.email;