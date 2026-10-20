-- ============================================================
-- migration_soft_delete.sql
-- Ativar/Desativar (SOFT DELETE) de Empresas e Funcionários
-- ============================================================
-- MOTIVO (regra de negócio):
--   NUNCA usar DELETE. A legislação trabalhista exige guardar o
--   histórico de ponto por anos; apagar um funcionário ou uma
--   empresa destruiria provas legais. Portanto, "remoção" aqui é
--   sempre INATIVAÇÃO (soft delete): apenas marcamos o status.
--
-- O QUE ESTA MIGRAÇÃO FAZ:
--   1) profiles.ativo boolean NOT NULL DEFAULT true
--      (fonte única da verdade do vínculo do funcionário).
--   2) profiles.inativado_em / inativado_por  (trilha de auditoria).
--   3) profiles.reativar_em_cascata boolean
--      -> marca quem foi desativado POR CAUSA da empresa. Assim a
--         reativação da empresa sabe EXATAMENTE quem reativar, sem
--         "reviver" quem já estava inativo por conta própria.
--   4) companies.inativado_em / inativado_por (trilha do tenant).
--   5) RPCs transacionais de status (auditadas):
--        - atualizar_funcionario_status(...)  (funcionário)
--        - atualizar_empresa_status(...)      (empresa + cascata)
--   6) RPC companhia_ativa(company_id) -> helper p/ checagem rápida.
--
-- SEMÂNTICA DA CASCATA (empresa -> funcionários):
--   Desativar empresa:
--     * marca a empresa inativa;
--     * marca profiles.ativo=false de todos os funcionários da empresa
--       E seta reativar_em_cascata=true neles.
--   Reativar empresa:
--     * marca a empresa ativa;
--     * SÓ reativa quem tem reativar_em_cascata=true (os que a cascata
--       desligou). Quem já estava inativo antes continua inativo.
--
-- IDEMPOTENTE E RE-EXECUTÁVEL (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE).
-- Ordem: rode DEPOIS de supabase.sql (profiles/companies).
-- ============================================================

-- ---------- 0) Pré-requisitos ----------
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Rode supabase.sql antes (tabela public.profiles ausente).';
  END IF;
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'Rode supabase.sql antes (tabela public.companies ausente).';
  END IF;
END $$;

-- ---------- 1) Colunas de status (soft delete) ----------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ativo                boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inativado_em         timestamptz,
  ADD COLUMN IF NOT EXISTS inativado_por        uuid,
  ADD COLUMN IF NOT EXISTS reativar_em_cascata  boolean NOT NULL DEFAULT false;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS ativa          boolean NOT NULL DEFAULT true,  -- já existe; garante
  ADD COLUMN IF NOT EXISTS inativado_em   timestamptz,
  ADD COLUMN IF NOT EXISTS inativado_por  uuid;

-- Índices para filtros "só ativos" / "só inativos" em listagens grandes.
CREATE INDEX IF NOT EXISTS idx_profiles_ativo   ON public.profiles (ativo);
CREATE INDEX IF NOT EXISTS idx_profiles_company_ativo ON public.profiles (company_id, ativo);
CREATE INDEX IF NOT EXISTS idx_companies_ativa  ON public.companies (ativa);

-- Backfill defensivo: quem tinha NULL vira ativo (DEFAULT já cobre, mas
-- protege bases antigas).
UPDATE public.profiles SET ativo = true WHERE ativo IS NULL;

-- Trigger de coerência: ao (re)ativar manualmente, limpa a marca de
-- cascata; ao inativar, registra QUEM e QUANDO (se não informado).
CREATE OR REPLACE FUNCTION public.sync_profile_status_meta()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ativo IS DISTINCT FROM OLD.ativo THEN
    IF NEW.ativo IS FALSE THEN
      NEW.inativado_em := COALESCE(NEW.inativado_em, now());
    ELSE
      NEW.inativado_em := NULL;
      NEW.inativado_por := NULL;
      -- Reativação MANUAL zera a marca de cascata.
      IF NOT COALESCE(NEW.reativar_em_cascata, false) THEN
        NEW.reativar_em_cascata := false;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_status_meta ON public.profiles;
CREATE TRIGGER trg_profiles_status_meta
BEFORE UPDATE OF ativo ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.sync_profile_status_meta();

-- ---------- 2) Helper: empresa está ativa? ----------
CREATE OR REPLACE FUNCTION public.companhia_ativa(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT ativa FROM public.companies WHERE id = p_company_id), false);
$$;

-- ---------- 3) RPC: status do FUNCIONÁRIO ----------
-- Regra: nunca DELETE; só alterna ativo. auditado no profiles.
CREATE OR REPLACE FUNCTION public.atualizar_funcionario_status(
  p_user_id  uuid,
  p_ativo    boolean,
  p_ator     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Funcionário não informado.';
  END IF;

  UPDATE public.profiles
     SET ativo = COALESCE(p_ativo, true),
         inativado_por = CASE WHEN COALESCE(p_ativo, true) THEN NULL ELSE p_ator END,
         reativar_em_cascata = false   -- ação manual nunca é "cascata"
   WHERE id = p_user_id
  RETURNING to_jsonb(profiles.*) INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Funcionário não encontrado.';
  END IF;
  RETURN v_row;
END;
$$;

-- ---------- 4) RPC: status da EMPRESA (+ cascata nos funcionários) ----------
CREATE OR REPLACE FUNCTION public.atualizar_empresa_status(
  p_company_id uuid,
  p_ativa      boolean,
  p_ator       uuid DEFAULT NULL,
  p_cascata    boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row        jsonb;
  v_ativa      boolean := COALESCE(p_ativa, true);
  v_afetados   integer := 0;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa não informada.';
  END IF;

  UPDATE public.companies
     SET ativa = v_ativa,
         inativado_por = CASE WHEN v_ativa THEN NULL ELSE p_ator END,
         inativado_em  = CASE WHEN v_ativa THEN NULL ELSE COALESCE(inativado_em, now()) END
   WHERE id = p_company_id
  RETURNING to_jsonb(companies.*) INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Empresa não encontrada.';
  END IF;

  IF p_cascata THEN
    IF NOT v_ativa THEN
      -- DESATIVAR: inativa todos os funcionários AINDA ativos e marca que
      -- foi a cascata (para saber quem reativar depois).
      WITH alvo AS (
        UPDATE public.profiles
           SET ativo = false,
               inativado_em = COALESCE(inativado_em, now()),
               inativado_por = COALESCE(inativado_por, p_ator),
               reativar_em_cascata = true
         WHERE company_id = p_company_id
           AND ativo IS TRUE
        RETURNING 1
      )
      SELECT count(*) INTO v_afetados FROM alvo;
    ELSE
      -- REATIVAR: revive APENAS quem a cascata havia desligado.
      WITH alvo AS (
        UPDATE public.profiles
           SET ativo = true,
               reativar_em_cascata = false,
               inativado_em = NULL,
               inativado_por = NULL
         WHERE company_id = p_company_id
           AND reativar_em_cascata IS TRUE
        RETURNING 1
      )
      SELECT count(*) INTO v_afetados FROM alvo;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'company', v_row,
    'funcionarios_afetados', v_afetados,
    'cascata', p_cascata
  );
END;
$$;

-- Só o service_role (backend) executa: o backend valida o perfil (Super Admin)
-- antes de chamar e trata o bloqueio no Supabase Auth.
REVOKE ALL ON FUNCTION public.atualizar_funcionario_status(uuid, boolean, uuid) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.atualizar_empresa_status(uuid, boolean, uuid, boolean) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atualizar_funcionario_status(uuid, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.atualizar_empresa_status(uuid, boolean, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.companhia_ativa(uuid) TO service_role;

-- ---------- 5) Prova ----------
SELECT 'migration_soft_delete aplicada' AS status;
