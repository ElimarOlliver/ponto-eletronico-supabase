-- ============================================================
-- migration_cadastro_funcionario.sql
-- Cadastro de funcionário em TRANSAÇÃO ÚNICA (tudo ou nada)
-- ============================================================
-- MOTIVO:
--   Cadastrar um funcionário exige 4 escritas encadeadas:
--     1) profiles        (identidade + vínculo + gestor)
--     2) user_companies  (multi-empresa)
--     3) escalas         (escala de trabalho inicial)
--     4) (fora do banco) auth.users via Admin API do Supabase
--   Se a escrita 2 ou 3 falhar, o profile ficaria "meio cadastrado"
--   (funcionário sem empresa/escala) — dado inconsistente para o RH.
--
--   A função public.criar_funcionario(...) faz 1/2/3 numa ÚNICA
--   transação PL/pgSQL: qualquer erro desfaz TUDO. O backend cria o
--   usuário em auth.users antes; se a RPC falhar, o backend apaga o
--   usuário auth (rollback compensatório) e devolve o erro.
--
-- IDEMPOTENTE E RE-EXECUTÁVEL.
-- Ordem: rode DEPOIS de supabase.sql + migration_multi_company.sql +
--        migration_escalas.sql. (Também garante, sozinha, as colunas
--        cadastrais de migration_espelho_mte.sql — pode rodar em qualquer ordem.)
-- ============================================================

-- ---------- 0) Pré-requisitos ----------
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Rode supabase.sql antes (tabela public.profiles ausente).';
  END IF;
  IF to_regclass('public.escalas') IS NULL THEN
    RAISE EXCEPTION 'Rode migration_escalas.sql antes (tabela public.escalas ausente).';
  END IF;
END $$;

-- Colunas cadastrais usadas pela RPC (mesmas de migration_espelho_mte.sql).
-- Criadas aqui por segurança para que a ordem de execução não importe.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cpf           text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS pis           text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS ctps          text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS cargo         text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS data_admissao date;

-- Garante a tabela de vínculo multi-empresa (caso a migração não tenha rodado).
CREATE TABLE IF NOT EXISTS public.user_companies (
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role_in_company  public.user_role NOT NULL DEFAULT 'employee',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);

-- ---------- 1) RPC transacional de cadastro ----------
-- Parâmetros pensados para o backend (service key) chamar via PostgREST.
-- Devolve JSON com o que foi criado. Qualquer EXCEPTION aborta a transação.
CREATE OR REPLACE FUNCTION public.criar_funcionario(
  p_user_id        uuid,
  p_company_id     uuid,
  p_full_name      text,
  p_role           public.user_role,
  p_manager_id     uuid   DEFAULT NULL,
  p_cpf            text   DEFAULT NULL,
  p_pis            text   DEFAULT NULL,
  p_ctps           text   DEFAULT NULL,
  p_cargo          text   DEFAULT NULL,
  p_data_admissao  date   DEFAULT NULL,
  -- Escala inicial (opcional). p_escala_tipo NULL = não cria escala.
  p_escala_tipo    text   DEFAULT NULL,
  p_ancora         date   DEFAULT NULL,
  p_expected_min   integer DEFAULT NULL,
  p_work_days      smallint[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile  jsonb;
  v_uc       jsonb;
  v_escala   jsonb;
  v_ciclo    integer;
  v_dia_trab integer;
  v_exp      integer;
  v_work     smallint[];
  v_ancora   date;
BEGIN
  -- Valida empresa.
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'Empresa % não encontrada', p_company_id;
  END IF;

  -- Valida gestor (se informado) pertence à mesma empresa.
  IF p_manager_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = p_manager_id AND company_id = p_company_id
    ) THEN
      RAISE EXCEPTION 'Gestor % não pertence à empresa informada', p_manager_id;
    END IF;
  END IF;

  -- 1) PROFILE (upsert: o trigger handle_new_user pode já ter criado a linha).
  INSERT INTO public.profiles (
    id, full_name, role, company_id, manager_id,
    cpf, pis, ctps, cargo, data_admissao
  )
  VALUES (
    p_user_id, p_full_name, p_role, p_company_id, p_manager_id,
    NULLIF(regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g'), ''),
    NULLIF(regexp_replace(COALESCE(p_pis, ''), '\D', '', 'g'), ''),
    NULLIF(TRIM(COALESCE(p_ctps, '')), ''),
    NULLIF(TRIM(COALESCE(p_cargo, '')), ''),
    p_data_admissao
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name     = EXCLUDED.full_name,
    role          = EXCLUDED.role,
    company_id    = EXCLUDED.company_id,
    manager_id    = EXCLUDED.manager_id,
    cpf           = EXCLUDED.cpf,
    pis           = EXCLUDED.pis,
    ctps          = EXCLUDED.ctps,
    cargo         = EXCLUDED.cargo,
    data_admissao = EXCLUDED.data_admissao
  RETURNING to_jsonb(profiles.*) INTO v_profile;

  -- 2) VÍNCULO MULTI-EMPRESA.
  INSERT INTO public.user_companies (user_id, company_id, role_in_company)
  VALUES (p_user_id, p_company_id, p_role)
  ON CONFLICT (user_id, company_id) DO UPDATE SET
    role_in_company = EXCLUDED.role_in_company
  RETURNING to_jsonb(user_companies.*) INTO v_uc;

  -- 3) ESCALA INICIAL (opcional).
  IF p_escala_tipo IS NOT NULL THEN
    v_ancora := COALESCE(p_ancora, CURRENT_DATE);
    IF p_escala_tipo = '12x36' THEN
      v_ciclo := 2; v_dia_trab := 0;
      v_exp := COALESCE(p_expected_min, 660);
      v_work := COALESCE(p_work_days, '{1,2,3,4,5}'::smallint[]);
    ELSIF p_escala_tipo = 'personalizada' THEN
      v_ciclo := 1; v_dia_trab := 0;
      v_exp := COALESCE(p_expected_min, 480);
      v_work := COALESCE(p_work_days, '{1,2,3,4,5}'::smallint[]);
    ELSE
      -- 'padrao' (seg-sex 8h)
      v_ciclo := 1; v_dia_trab := 0;
      v_exp := COALESCE(p_expected_min, 480);
      v_work := COALESCE(p_work_days, '{1,2,3,4,5}'::smallint[]);
    END IF;

    -- Encerra escala vigente anterior (se houver) para respeitar
    -- ux_escalas_user_vigente (uma vigente por usuário).
    UPDATE public.escalas
      SET valid_to = v_ancora - 1
      WHERE user_id = p_user_id AND valid_to IS NULL;

    INSERT INTO public.escalas (
      user_id, company_id, tipo, ciclo_dias, ciclo_dia_trabalho,
      ancora, expected_min, work_days, valid_from, valid_to
    )
    VALUES (
      p_user_id, p_company_id, p_escala_tipo, v_ciclo, v_dia_trab,
      v_ancora, v_exp, v_work, v_ancora, NULL
    )
    RETURNING to_jsonb(escalas.*) INTO v_escala;
  END IF;

  RETURN jsonb_build_object(
    'profile', v_profile,
    'user_company', v_uc,
    'escala', v_escala
  );
END;
$$;

-- Só o service_role (backend) executa: o cadastro passa pelo servidor,
-- que valida permissões (Admin/Gestor) antes de chamar.
REVOKE ALL ON FUNCTION public.criar_funcionario(
  uuid, uuid, text, public.user_role, uuid, text, text, text, text, date, text, date, integer, smallint[]
) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_funcionario(
  uuid, uuid, text, public.user_role, uuid, text, text, text, text, date, text, date, integer, smallint[]
) TO service_role;

-- ---------- 2) Prova ----------
SELECT 'migration_cadastro_funcionario aplicada' AS status;
