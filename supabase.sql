-- ============================================================
-- Ponto Eletrônico — Correções gerais (funções, triggers, RLS)
-- Rode este bloco inteiro no Supabase
-- ============================================================

-- ---------- (A) Garantir enums (ignora se já existem) ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE public.user_role AS ENUM ('admin','manager','employee');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'punch_type') THEN
    CREATE TYPE public.punch_type AS ENUM ('in','out','break_start','break_end');
  END IF;
END
$$;

-- ---------- (B) Tabelas (idempotentes) ----------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  role public.user_role NOT NULL DEFAULT 'employee',
  manager_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.punches (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  p_type public.punch_type NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric(9,6),
  longitude numeric(9,6),
  accuracy numeric(6,2),
  source text DEFAULT 'web',
  note text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_by uuid REFERENCES public.profiles(id),
  edited_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_punches_user_time
  ON public.punches (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.punch_audit (
  id bigserial PRIMARY KEY,
  punch_id bigint NOT NULL REFERENCES public.punches(id) ON DELETE CASCADE,
  action text NOT NULL, -- insert|update|delete
  old_row jsonb,
  new_row jsonb,
  actor uuid REFERENCES public.profiles(id),
  at timestamptz NOT NULL DEFAULT now()
);

-- ---------- (C) Funções auxiliares ----------
CREATE OR REPLACE FUNCTION public.is_admin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = uid AND p.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_manager_of(manager uuid, employee uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles e
    WHERE e.id = employee
      AND e.manager_id = manager
  );
$$;

-- ---------- (D) Anti-duplicação (antes do INSERT em punches) ----------
CREATE OR REPLACE FUNCTION public.prevent_punch_spam()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.punches
    WHERE user_id = NEW.user_id
      AND occurred_at >= (NEW.occurred_at - INTERVAL '5 minutes')
  ) THEN
    RAISE EXCEPTION 'Já existe uma batida nos últimos 5 minutos';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_punch_spam ON public.punches;
CREATE TRIGGER trg_prevent_punch_spam
BEFORE INSERT ON public.punches
FOR EACH ROW
EXECUTE FUNCTION public.prevent_punch_spam();

-- ---------- (E) Auditoria (agora SECURITY DEFINER para ignorar RLS) ----------
CREATE OR REPLACE FUNCTION public.audit_punch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.punch_audit (punch_id, action, new_row, actor)
    VALUES (NEW.id, 'insert', to_jsonb(NEW), NEW.created_by);
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.punch_audit (punch_id, action, old_row, new_row, actor)
    VALUES (NEW.id, 'update', to_jsonb(OLD), to_jsonb(NEW), NEW.edited_by);
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.punch_audit (punch_id, action, old_row, actor)
    VALUES (OLD.id, 'delete', to_jsonb(OLD), OLD.edited_by);
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

-- ---------- (F) Criar profiles automaticamente para novos usuários ----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- ---------- (G) Habilitar RLS ----------
ALTER TABLE public.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.punches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.punch_audit ENABLE ROW LEVEL SECURITY;

-- ---------- (H) Policies (idempotentes via DROP + CREATE) ----------
-- profiles: self select/update
DROP POLICY IF EXISTS "profiles self select" ON public.profiles;
CREATE POLICY "profiles self select"
ON public.profiles
FOR SELECT
TO authenticated
USING (id = auth.uid());

DROP POLICY IF EXISTS "profiles self update" ON public.profiles;
CREATE POLICY "profiles self update"
ON public.profiles
FOR UPDATE
TO authenticated
USING (id = auth.uid());

-- profiles: manager select/update team
DROP POLICY IF EXISTS "manager can select team" ON public.profiles;
CREATE POLICY "manager can select team"
ON public.profiles
FOR SELECT
TO authenticated
USING ( public.is_manager_of(auth.uid(), id) );

DROP POLICY IF EXISTS "manager can update team" ON public.profiles;
CREATE POLICY "manager can update team"
ON public.profiles
FOR UPDATE
TO authenticated
USING ( public.is_manager_of(auth.uid(), id) );

-- profiles: admin all
DROP POLICY IF EXISTS "admin all on profiles" ON public.profiles;
CREATE POLICY "admin all on profiles"
ON public.profiles
FOR ALL
TO authenticated
USING ( public.is_admin(auth.uid()) );

-- punches: employee select own
DROP POLICY IF EXISTS "employee select own punches" ON public.punches;
CREATE POLICY "employee select own punches"
ON public.punches
FOR SELECT
TO authenticated
USING ( user_id = auth.uid() );

-- punches: manager select team
DROP POLICY IF EXISTS "manager select team punches" ON public.punches;
CREATE POLICY "manager select team punches"
ON public.punches
FOR SELECT
TO authenticated
USING ( public.is_manager_of(auth.uid(), user_id) );

-- punches: admin select all
DROP POLICY IF EXISTS "admin select all punches" ON public.punches;
CREATE POLICY "admin select all punches"
ON public.punches
FOR SELECT
TO authenticated
USING ( public.is_admin(auth.uid()) );

-- punches: employee insert own
DROP POLICY IF EXISTS "employee insert own punches" ON public.punches;
CREATE POLICY "employee insert own punches"
ON public.punches
FOR INSERT
TO authenticated
WITH CHECK ( user_id = auth.uid() );

-- punches: manager/admin update
DROP POLICY IF EXISTS "manager/admin update punches" ON public.punches;
CREATE POLICY "manager/admin update punches"
ON public.punches
FOR UPDATE
TO authenticated
USING ( public.is_manager_of(auth.uid(), user_id) OR public.is_admin(auth.uid()) );

-- punches: admin delete
DROP POLICY IF EXISTS "admin delete punches" ON public.punches;
CREATE POLICY "admin delete punches"
ON public.punches
FOR DELETE
TO authenticated
USING ( public.is_admin(auth.uid()) );

-- punch_audit: apenas admin pode SELECT
DROP POLICY IF EXISTS "admin select audit" ON public.punch_audit;
CREATE POLICY "admin select audit"
ON public.punch_audit
FOR SELECT
TO authenticated
USING ( public.is_admin(auth.uid()) );

-- ---------- (I) Backfill: cria profiles que estiverem faltando ----------
INSERT INTO public.profiles (id, full_name)
SELECT u.id, COALESCE(u.raw_user_meta_data->>'full_name', u.email)
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;
