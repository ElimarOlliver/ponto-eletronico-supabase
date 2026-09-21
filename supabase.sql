-- ===========================================
-- Ponto Eletrônico — Schema SaaS multi-tenant (v2, idempotente)
-- Mantém compat com v1 + adiciona isolamento por empresa (company_id + RLS)
-- Ordem de execução: rode o arquivo inteiro no SQL Editor do Supabase.
-- ===========================================

-- ---------- 0) Roles: evolui enum sem quebrar dados existentes ----------
-- ALTER TYPE ... ADD VALUE não pode rodar dentro de bloco de transação/DO,
-- por isso fica aqui como statements avulsos (fora de DO $$).
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'system_admin';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'company_admin';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'punch_type') THEN
    CREATE TYPE public.punch_type AS ENUM ('in','out','break_start','break_end');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'punch_approval_status') THEN
    CREATE TYPE public.punch_approval_status AS ENUM ('pending','approved','rejected');
  END IF;
END
$$;

-- ---------- 1) Tabela de empresas (tenants) ----------
CREATE TABLE IF NOT EXISTS public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL UNIQUE,          -- somente dígitos (14). Normalizar no app.
  nome text NOT NULL,
  ativa boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Normaliza CNPJ: só dígitos. Trigger BEFORE INSERT/UPDATE.
CREATE OR REPLACE FUNCTION public.normalize_cnpj()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.cnpj := regexp_replace(COALESCE(NEW.cnpj, ''), '\D', '', 'g');
  IF length(NEW.cnpj) <> 14 THEN
    RAISE EXCEPTION 'CNPJ deve ter 14 dígitos (recebido: %)', NEW.cnpj;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_normalize ON public.companies;
CREATE TRIGGER trg_companies_normalize
BEFORE INSERT OR UPDATE OF cnpj ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.normalize_cnpj();

-- ---------- 2) Colunas tenant (nullable primeiro p/ backfill) ----------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE RESTRICT;
ALTER TABLE public.punches ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE RESTRICT;
ALTER TABLE public.punch_audit ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_profiles_company ON public.profiles (company_id);
CREATE INDEX IF NOT EXISTS idx_punches_company_time ON public.punches (company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_company ON public.punch_audit (company_id);

-- ---------- 3) Backfill: empresa padrão p/ dados legados sem tenant ----------
-- CNPJ 00000000000000 = placeholder de migração (troque/arquive depois).
INSERT INTO public.companies (cnpj, nome, ativa)
VALUES ('00000000000000', 'Empresa Padrão (migração v1)', true)
ON CONFLICT (cnpj) DO NOTHING;

UPDATE public.profiles
SET company_id = (SELECT id FROM public.companies WHERE cnpj = '00000000000000')
WHERE company_id IS NULL;

UPDATE public.punches
SET company_id = (SELECT p.company_id FROM public.profiles p WHERE p.id = punches.user_id)
WHERE company_id IS NULL;

UPDATE public.punch_audit
SET company_id = (SELECT p.company_id FROM public.punches p WHERE p.id = punch_audit.punch_id)
WHERE company_id IS NULL;

-- A partir daqui, todo registro novo exige tenant.
ALTER TABLE public.profiles ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.punches ALTER COLUMN company_id SET NOT NULL;
-- audit pode continuar nullable p/ histórico muito antigo sem punch correspondente
-- (mantido nullable de propósito).

-- ---------- 4) Helpers (SECURITY DEFINER p/ evitar recursão da RLS) ----------
CREATE OR REPLACE FUNCTION public.my_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company_id FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.my_role()
RETURNS public.user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_system_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = uid AND p.role = 'system_admin');
$$;

CREATE OR REPLACE FUNCTION public.is_company_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = uid AND p.role IN ('company_admin', 'system_admin'));
$$;

-- Compat legado: 'admin' antigo equivale a company_admin.
CREATE OR REPLACE FUNCTION public.is_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = uid AND p.role IN ('admin', 'company_admin', 'system_admin'));
$$;

CREATE OR REPLACE FUNCTION public.is_manager_of(manager uuid, employee uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles e
    JOIN public.profiles m ON m.id = manager
    WHERE e.id = employee
      AND e.manager_id = manager
      AND e.company_id = m.company_id
  );
$$;

-- Lookup público de empresa por CNPJ (p/ tela de login), sem expor a tabela.
CREATE OR REPLACE FUNCTION public.get_company_by_cnpj(p_cnpj text)
RETURNS TABLE (id uuid, nome text, ativa boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.nome, c.ativa
  FROM public.companies c
  WHERE c.cnpj = regexp_replace(COALESCE(p_cnpj, ''), '\D', '', 'g')
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.my_company_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_system_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_manager_of(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_by_cnpj(text) TO anon, authenticated;

-- ---------- 5) Guards & automação ----------
CREATE OR REPLACE FUNCTION public.profiles_mutation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_role public.user_role;
  actor_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT role, company_id INTO actor_role, actor_company
    FROM public.profiles WHERE id = auth.uid();

    -- company_id: só system_admin move gente entre empresas
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       AND NOT public.is_system_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Apenas system_admin pode alterar a empresa do perfil';
    END IF;

    -- role: system_admin pode tudo; company_admin só manager<->employee dentro da própria empresa
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      IF public.is_system_admin(auth.uid()) THEN
        -- ok
      ELSIF actor_role = 'company_admin'
        AND OLD.company_id = actor_company
        AND NEW.company_id = OLD.company_id
        AND OLD.role IN ('manager', 'employee')
        AND NEW.role IN ('manager', 'employee') THEN
        -- ok
      ELSIF actor_role = 'admin'
        AND OLD.company_id = actor_company
        AND NEW.company_id = OLD.company_id THEN
        -- compat legado: 'admin' age como company_admin
      ELSE
        RAISE EXCEPTION 'Sem permissão para alterar o role do perfil';
      END IF;
    END IF;

    -- manager_id: system_admin ou company_admin da mesma empresa
    IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
      IF public.is_system_admin(auth.uid()) THEN
        -- ok
      ELSIF actor_role IN ('company_admin', 'admin')
        AND OLD.company_id = actor_company THEN
        IF NEW.manager_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.profiles m
          WHERE m.id = NEW.manager_id AND m.company_id = OLD.company_id
        ) THEN
          RAISE EXCEPTION 'Gestor deve pertencer à mesma empresa';
        END IF;
      ELSE
        RAISE EXCEPTION 'Apenas admins podem alterar o manager_id do perfil';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_mutation_guard ON public.profiles;
CREATE TRIGGER trg_profiles_mutation_guard
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.profiles_mutation_guard();

-- Preenche company_id do punch a partir do profile (fonte da verdade = user_id).
CREATE OR REPLACE FUNCTION public.fill_punch_company()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT company_id INTO NEW.company_id
  FROM public.profiles WHERE id = NEW.user_id;
  IF NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'Perfil sem empresa (user_id=%)', NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_punch_company ON public.punches;
CREATE TRIGGER trg_fill_punch_company
BEFORE INSERT ON public.punches
FOR EACH ROW
EXECUTE FUNCTION public.fill_punch_company();

-- Anti-duplicação (5 min por tipo) + lock contra duplo-clique concorrente.
-- Mesmo tipo dentro de 5 min = duplicado. Tipos diferentes em sequência
-- rápida (ex: in -> break_start) são legítimos e permitidos.
-- O advisory lock serializa inserts concorrentes do mesmo usuário na mesma
-- transação (mobile retry / duplo-clique), fechando a race condition da v1.
CREATE OR REPLACE FUNCTION public.prevent_punch_spam()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('punch_spam:' || NEW.user_id::text));

  IF EXISTS (
    SELECT 1 FROM public.punches
    WHERE user_id = NEW.user_id
      AND p_type = NEW.p_type
      AND occurred_at >= (NEW.occurred_at - INTERVAL '5 minutes')
  ) THEN
    RAISE EXCEPTION 'Já existe uma batida do tipo % nos últimos 5 minutos', NEW.p_type;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_punch_spam ON public.punches;
CREATE TRIGGER trg_prevent_punch_spam
BEFORE INSERT ON public.punches
FOR EACH ROW
EXECUTE FUNCTION public.prevent_punch_spam();

-- Auditoria (carrega company_id junto).
CREATE OR REPLACE FUNCTION public.audit_punch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.punch_audit (punch_id, action, new_row, actor, company_id)
    VALUES (NEW.id, 'insert', to_jsonb(NEW), NEW.created_by, NEW.company_id);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.punch_audit (punch_id, action, old_row, new_row, actor, company_id)
    VALUES (NEW.id, 'update', to_jsonb(OLD), to_jsonb(NEW), NEW.edited_by, NEW.company_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.punch_audit (punch_id, action, old_row, actor, company_id)
    VALUES (OLD.id, 'delete', to_jsonb(OLD), OLD.edited_by, OLD.company_id);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_punch ON public.punches;
CREATE TRIGGER trg_audit_punch
AFTER INSERT OR UPDATE OR DELETE ON public.punches
FOR EACH ROW
EXECUTE FUNCTION public.audit_punch();

-- Signup: cria profile amarrado à empresa via user_metadata {company_id | cnpj}.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company uuid;
  v_meta_cnpj text;
BEGIN
  v_company := NULLIF(NEW.raw_user_meta_data->>'company_id', '')::uuid;

  v_meta_cnpj := regexp_replace(COALESCE(NEW.raw_user_meta_data->>'cnpj', ''), '\D', '', 'g');
  IF v_company IS NULL AND v_meta_cnpj <> '' THEN
    SELECT id INTO v_company FROM public.companies WHERE cnpj = v_meta_cnpj;
  END IF;

  INSERT INTO public.profiles (id, full_name, role, company_id)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'employee',
    v_company
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Se company_id é NOT NULL e não veio metadata, o INSERT falha.
  -- Nesse caso cria sem empresa só se a coluna permitir; caso contrário propaga erro
  -- para o signup falhar com mensagem clara (cadastro deve informar CNPJ).
  RAISE;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- ---------- 6) RLS ----------
ALTER TABLE public.companies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.punches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.punch_audit ENABLE ROW LEVEL SECURITY;

-- --- companies ---
DROP POLICY IF EXISTS "members select own company" ON public.companies;
CREATE POLICY "members select own company"
ON public.companies FOR SELECT TO authenticated
USING (id = public.my_company_id());

DROP POLICY IF EXISTS "system_admin all companies" ON public.companies;
CREATE POLICY "system_admin all companies"
ON public.companies FOR ALL TO authenticated
USING (public.is_system_admin(auth.uid()))
WITH CHECK (public.is_system_admin(auth.uid()));

-- --- profiles ---
DROP POLICY IF EXISTS "profiles self select" ON public.profiles;
DROP POLICY IF EXISTS "manager can select team" ON public.profiles;
DROP POLICY IF EXISTS "admin all on profiles" ON public.profiles;
DROP POLICY IF EXISTS "profiles self update" ON public.profiles;

CREATE POLICY "profiles self select"
ON public.profiles FOR SELECT TO authenticated
USING (id = auth.uid());

CREATE POLICY "manager can select team"
ON public.profiles FOR SELECT TO authenticated
USING (public.is_manager_of(auth.uid(), id));

CREATE POLICY "company_admin select own company"
ON public.profiles FOR SELECT TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

CREATE POLICY "system_admin all on profiles"
ON public.profiles FOR ALL TO authenticated
USING (public.is_system_admin(auth.uid()))
WITH CHECK (public.is_system_admin(auth.uid()));

CREATE POLICY "company_admin update own company"
ON public.profiles FOR UPDATE TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
)
WITH CHECK (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

CREATE POLICY "profiles self update"
ON public.profiles FOR UPDATE TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- --- punches (todas com escopo company_id) ---
DROP POLICY IF EXISTS "employee select own punches" ON public.punches;
DROP POLICY IF EXISTS "manager select team punches" ON public.punches;
DROP POLICY IF EXISTS "admin select all punches" ON public.punches;
DROP POLICY IF EXISTS "employee insert own punches" ON public.punches;
DROP POLICY IF EXISTS "manager/admin update punches" ON public.punches;
DROP POLICY IF EXISTS "admin delete punches" ON public.punches;

CREATE POLICY "employee select own punches"
ON public.punches FOR SELECT TO authenticated
USING (user_id = auth.uid() AND company_id = public.my_company_id());

CREATE POLICY "manager select team punches"
ON public.punches FOR SELECT TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_manager_of(auth.uid(), user_id)
);

CREATE POLICY "company_admin select company punches"
ON public.punches FOR SELECT TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

CREATE POLICY "system_admin select all punches"
ON public.punches FOR SELECT TO authenticated
USING (public.is_system_admin(auth.uid()));

CREATE POLICY "employee insert own punches"
ON public.punches FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid() AND company_id = public.my_company_id());

CREATE POLICY "manager/company_admin update punches"
ON public.punches FOR UPDATE TO authenticated
USING (
  company_id = public.my_company_id()
  AND (
    public.is_manager_of(auth.uid(), user_id)
    OR public.is_company_admin(auth.uid())
  )
);

CREATE POLICY "system_admin update all punches"
ON public.punches FOR UPDATE TO authenticated
USING (public.is_system_admin(auth.uid()));

CREATE POLICY "company_admin delete company punches"
ON public.punches FOR DELETE TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

CREATE POLICY "system_admin delete all punches"
ON public.punches FOR DELETE TO authenticated
USING (public.is_system_admin(auth.uid()));

-- --- punch_audit ---
DROP POLICY IF EXISTS "admin select audit" ON public.punch_audit;
CREATE POLICY "company_admin select company audit"
ON public.punch_audit FOR SELECT TO authenticated
USING (
  public.is_system_admin(auth.uid())
  OR (
    company_id = public.my_company_id()
    AND public.is_company_admin(auth.uid())
  )
);

-- ---------- 7) Backfill p/ usuários Auth sem profile ----------
INSERT INTO public.profiles (id, full_name, role, company_id)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'full_name', u.email),
  'employee',
  (SELECT id FROM public.companies WHERE cnpj = '00000000000000')
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

UPDATE public.punches SET approval_status = 'pending' WHERE approval_status IS NULL;

-- ---------- 8) Feriados (BrasilAPI = nacionais; locais por empresa) ----------
-- company_id NULL  = feriado nacional (compartilhado, fonte: BrasilAPI).
-- company_id NOT NULL = feriado local/estadual/municipal daquela empresa (ex: DF 30/11).
CREATE TABLE IF NOT EXISTS public.holidays (
  id bigserial PRIMARY KEY,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  h_date date NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'national' CHECK (kind IN ('national','state','city','company','optional')),
  source text NOT NULL DEFAULT 'manual',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Nacional: uma linha por data (evita duplicar sync entre empresas).
CREATE UNIQUE INDEX IF NOT EXISTS ux_holidays_national_date
  ON public.holidays (h_date) WHERE company_id IS NULL;
-- Local: uma linha por (empresa, data).
CREATE UNIQUE INDEX IF NOT EXISTS ux_holidays_company_date
  ON public.holidays (company_id, h_date) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holidays_date ON public.holidays (h_date);

ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

-- Todos logados veem nacionais + os da própria empresa.
DROP POLICY IF EXISTS "all select holidays" ON public.holidays;
CREATE POLICY "all select holidays"
ON public.holidays FOR SELECT TO authenticated
USING (company_id IS NULL OR company_id = public.my_company_id());

-- company_admin gerencia feriados da própria empresa (nunca nacionais).
DROP POLICY IF EXISTS "company_admin manage company holidays" ON public.holidays;
CREATE POLICY "company_admin manage company holidays"
ON public.holidays FOR ALL TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
)
WITH CHECK (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

-- system_admin gerencia tudo (inclui nacionais vindos da BrasilAPI).
DROP POLICY IF EXISTS "system_admin all holidays" ON public.holidays;
CREATE POLICY "system_admin all holidays"
ON public.holidays FOR ALL TO authenticated
USING (public.is_system_admin(auth.uid()))
WITH CHECK (public.is_system_admin(auth.uid()));

-- ---------- 9) Higienização Auth/Tenant (auditoria) ----------
-- S1: is_company_admin ignorava o role legado 'admin' e o destituía nas
-- policies que usam esta função (profiles/punches/holidays). Incluído.
CREATE OR REPLACE FUNCTION public.is_company_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = uid AND p.role IN ('admin', 'company_admin', 'system_admin'));
$$;

-- B1: handle_new_user quebrava o signup quando o metadata não trazia empresa
-- (profiles.company_id é NOT NULL desde a §3): INSERT com NULL violava a
-- constraint. Agora: cast de UUID com proteção, lookup por cnpj e fallback
-- para a empresa placeholder da migração, com erro explícito se nada resolver.
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
  RETURN NEW;
END;
$$;

-- ---------- 10) Folha: fechamentos de período (Módulo Folha) ----------
-- Snapshot por empresa/período gerado pelo fechamento (totals em jsonb).
CREATE TABLE IF NOT EXISTS public.payroll_closings (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
  totals jsonb NOT NULL DEFAULT '[]',
  closed_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_closings_period CHECK (period_start <= period_end)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_closings_company_period
  ON public.payroll_closings (company_id, period_start, period_end);

ALTER TABLE public.payroll_closings ENABLE ROW LEVEL SECURITY;

-- Gestores e admins da empresa podem ver; só admins fecham.
DROP POLICY IF EXISTS "team select closings" ON public.payroll_closings;
CREATE POLICY "team select closings"
ON public.payroll_closings FOR SELECT TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.my_role() IN ('manager', 'company_admin', 'system_admin', 'admin')
);

DROP POLICY IF EXISTS "company_admin manage closings" ON public.payroll_closings;
CREATE POLICY "company_admin manage closings"
ON public.payroll_closings FOR ALL TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
)
WITH CHECK (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

DROP POLICY IF EXISTS "system_admin all closings" ON public.payroll_closings;
CREATE POLICY "system_admin all closings"
ON public.payroll_closings FOR ALL TO authenticated
USING (public.is_system_admin(auth.uid()))
WITH CHECK (public.is_system_admin(auth.uid()));

-- B10: o guard disparava também em contexto service_role / trigger interno
-- (auth.uid() IS NULL) e bloqueava seeds e rotinas admin com erro de permissão.
-- Service_role bypassa a RLS por definição: libera o caminho nesse contexto.
CREATE OR REPLACE FUNCTION public.profiles_mutation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_role public.user_role;
  actor_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT role, company_id INTO actor_role, actor_company
    FROM public.profiles WHERE id = auth.uid();

    -- company_id: só system_admin move gente entre empresas
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       AND NOT public.is_system_admin(auth.uid()) THEN
      RAISE EXCEPTION 'Apenas system_admin pode alterar a empresa do perfil';
    END IF;

    -- role: system_admin pode tudo; company_admin só manager<->employee dentro da própria empresa
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      IF public.is_system_admin(auth.uid()) THEN
        -- ok
      ELSIF actor_role = 'company_admin'
        AND OLD.company_id = actor_company
        AND NEW.company_id = OLD.company_id
        AND OLD.role IN ('manager', 'employee')
        AND NEW.role IN ('manager', 'employee') THEN
        -- ok
      ELSIF actor_role = 'admin'
        AND OLD.company_id = actor_company
        AND NEW.company_id = OLD.company_id THEN
        -- compat legado: 'admin' age como company_admin
      ELSE
        RAISE EXCEPTION 'Sem permissão para alterar o role do perfil';
      END IF;
    END IF;

    -- manager_id: system_admin ou company_admin da mesma empresa
    IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
      IF public.is_system_admin(auth.uid()) THEN
        -- ok
      ELSIF actor_role IN ('company_admin', 'admin')
        AND OLD.company_id = actor_company THEN
        IF NEW.manager_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.profiles m
          WHERE m.id = NEW.manager_id AND m.company_id = OLD.company_id
        ) THEN
          RAISE EXCEPTION 'Gestor deve pertencer à mesma empresa';
        END IF;
      ELSE
        RAISE EXCEPTION 'Apenas admins podem alterar o manager_id do perfil';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
