-- ============================================================================
-- MIGRAÇÃO — Sistema de Auditoria Legal (logs_auditoria) + correção RLS multi-empresa
-- Projeto: Ponto Eletrônico SaaS multi-tenant
-- Idempotente. Rode no SQL Editor do Supabase.
--
-- Mapeia o pedido para o schema real do projeto:
--   "usuarios"  -> public.profiles (identidade+vínculo) / auth.users (e-mail)
--   "empresas"  -> public.companies
--   "pontos"    -> public.punches
--   "logs_auditoria" -> tabela nova (histórico com quem/por quê/quando)
--
-- O QUE FAZ:
--   1) Helper público is_member_company(): enxerga user_companies (multi-empresa)
--      com fallback para a empresa padrão. Implementado em plpgsql (relations
--      resolvidos em runtime) — este arquivo roda ANTES ou DEPOIS da migração
--      multi-company sem erro de "relation does not exist".
--   2) Tabela logs_auditoria: quem alterou (e-mail + role), quem foi alterado,
--      valor antigo/novo (jsonb), justificativa, empresa, data/hora.
--   3) RLS de logs_auditoria (SELECT só para admin da empresa/gestor da empresa/
--      system_admin; escrita SOMENTE via funções SECURITY DEFINER — usuário
--      autenticado não consegue forjar log).
--   4) Funções transacionais (atomicidade garantida: UPDATE + log na MESMA
--      transação; qualquer erro reverte tudo):
--        update_punch_with_audit(...)   -> corrige ponto + grava log
--        approve_punch_with_audit(...)  -> aprova/recusa + grava log
--   5) get_audit_logs(empresa) -> consulta do histórico (autenticada por RPC).
--   6) CORREÇÃO DO BUG: policy de punch_audit e nova policy de logs_auditoria
--      passam a aceitar is_member_company() — a auditoria de Milena/josé na
--      2ª empresa fica visível e registrável.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0) Ajustes idempotentes nas tabelas existentes (usuarios/empresas/pontos)
-- ---------------------------------------------------------------------------
-- empresas
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS cnpj        text,
  ADD COLUMN IF NOT EXISTS nome        text,
  ADD COLUMN IF NOT EXISTS ativa       boolean NOT NULL DEFAULT true;

-- usuários (perfil): garante colunas de cargo/gestão exigidas pelas regras
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role         public.user_role NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS manager_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS full_name    text;

-- pontos: colunas de auditoria/edição (idempotente; já existem no schema atual)
ALTER TABLE public.punches
  ADD COLUMN IF NOT EXISTS note             text,
  ADD COLUMN IF NOT EXISTS edited_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_at        timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS approval_status  public.punch_approval_status NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS accuracy         numeric;

-- ---------------------------------------------------------------------------
-- 1) Helper: membro da empresa (multi-empresa) com fallback p/ empresa padrão
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_member_company(p_uid uuid, p_company uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member boolean;
BEGIN
  -- Fallback p/ single-company: se a tabela user_companies ainda não existe
  -- (migração multi-company não aplicada), valida pelo vínculo padrão em
  -- profiles.company_id. plpgsql resolve os relations em RUNTIME, então este
  -- arquivo roda em qualquer ordem (diferente de LANGUAGE sql, que valida no
  -- CREATE e quebrava com "relation user_companies does not exist").
  IF to_regclass('public.user_companies') IS NOT NULL THEN
    SELECT
      EXISTS (SELECT 1 FROM public.user_companies uc
              WHERE uc.user_id = p_uid AND uc.company_id = p_company)
      OR EXISTS (SELECT 1 FROM public.profiles p
                 WHERE p.id = p_uid AND p.company_id = p_company)
      INTO v_member;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                   WHERE p.id = p_uid AND p.company_id = p_company)
      INTO v_member;
  END IF;
  RETURN v_member;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Tabela de auditoria (canonical, nível de negócio)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.logs_auditoria (
  id                    bigserial PRIMARY KEY,
  punch_id              bigint REFERENCES public.punches(id)   ON DELETE SET NULL,
  empresa_id            uuid   REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Quem alterou
  alterado_por          uuid   NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  alterado_por_email    text,
  alterado_por_role     text,          -- gestor | company_admin | system_admin | admin
  -- Quem foi alterado
  usuario_alterado      uuid   REFERENCES public.profiles(id) ON DELETE RESTRICT,
  usuario_alterado_nome text,
  -- O quê
  acao                  text   NOT NULL CHECK (acao IN ('insert','update','approve','reject','delete')),
  valor_antigo          jsonb,
  valor_novo            jsonb,
  justificativa         text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_empresa_data ON public.logs_auditoria (empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_alterado_por ON public.logs_auditoria (alterado_por);
CREATE INDEX IF NOT EXISTS idx_logs_usuario      ON public.logs_auditoria (usuario_alterado);
CREATE INDEX IF NOT EXISTS idx_logs_punch        ON public.logs_auditoria (punch_id);

-- ---------------------------------------------------------------------------
-- 3) RLS de logs_auditoria
-- ---------------------------------------------------------------------------
ALTER TABLE public.logs_auditoria ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "system_admin select all logs" ON public.logs_auditoria;
CREATE POLICY "system_admin select all logs"
ON public.logs_auditoria FOR SELECT TO authenticated
USING (public.is_system_admin(auth.uid()));

DROP POLICY IF EXISTS "company_admin select member logs" ON public.logs_auditoria;
CREATE POLICY "company_admin select member logs"
ON public.logs_auditoria FOR SELECT TO authenticated
USING (
  public.is_company_admin(auth.uid())
  AND (empresa_id = public.my_company_id() OR public.is_member_company(auth.uid(), empresa_id))
);

DROP POLICY IF EXISTS "manager select own company logs" ON public.logs_auditoria;
CREATE POLICY "manager select own company logs"
ON public.logs_auditoria FOR SELECT TO authenticated
USING (
  public.my_role() = 'manager'
  AND empresa_id = public.my_company_id()
);

-- Sem policy de INSERT/UPDATE/DELETE p/ authenticated: escrita só pelas funções
-- SECURITY DEFINER abaixo (usuário autenticado NÃO consegue forjar um log).
-- service_role (app/back-end) continua livre; RLS não se aplica a ele.

-- ---------------------------------------------------------------------------
-- 4) Autorização de edição de ponto (compatível com multi-empresa)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_edit_punch(p_actor uuid, p_punch_id bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_punch  public.punches%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RETURN false;
  END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = p_actor;
  SELECT * INTO v_punch FROM public.punches WHERE id = p_punch_id;

  IF v_punch.id IS NULL THEN
    RETURN false;           -- ponto inexistente
  END IF;

  -- Admin de plataforma: qualquer empresa
  IF v_role IN ('system_admin', 'admin') THEN
    RETURN true;
  END IF;

  -- Admin de empresa: precisa ser membro da empresa do ponto
  IF v_role = 'company_admin' THEN
    RETURN public.is_member_company(p_actor, v_punch.company_id);
  END IF;

  -- Gestor: subordinado direto E na MESMA empresa padrão dele
  IF v_role = 'manager' THEN
    RETURN public.is_manager_of(p_actor, v_punch.user_id)
      AND v_punch.company_id = (SELECT company_id FROM public.profiles WHERE id = p_actor);
  END IF;

  RETURN false;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) Função transacional: CORRIGIR PONTO + GRAVAR LOG (atomicidade)
-- ---------------------------------------------------------------------------
-- A função roda como função única (= uma transação). Se qualquer passo falhar,
-- o Postgres reverte TODO o bloco (update e log juntos). Nunca fica ponto
-- alterado sem log, nem log sem alteração.
CREATE OR REPLACE FUNCTION public.update_punch_with_audit(
  p_punch_id      bigint,
  p_occurred_at   timestamptz,
  p_note          text,
  p_justificativa text,
  p_actor_id      uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old  public.punches%ROWTYPE;
  v_new  public.punches%ROWTYPE;
  v_role text;
  v_email text;
  v_user_name text;
BEGIN
  -- Autorização (idempotente à RLS: roda como dono da função)
  IF NOT public.can_edit_punch(p_actor_id, p_punch_id) THEN
    RAISE EXCEPTION 'Sem permissão para alterar este ponto (perfil/empresa)';
  END IF;

  SELECT * INTO v_old FROM public.punches WHERE id = p_punch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ponto não encontrado';
  END IF;

  UPDATE public.punches SET
    occurred_at = COALESCE(p_occurred_at, v_old.occurred_at),
    note        = CASE WHEN p_note IS NOT NULL THEN NULLIF(p_note, '') ELSE v_old.note END,
    edited_by   = p_actor_id,
    edited_at   = now()
  WHERE id = p_punch_id
  RETURNING * INTO v_new;

  -- Resolve identidade do autor (e-mail real) e do colaborador alterado
  SELECT role::text, email INTO v_role, v_email
  FROM public.profiles pr JOIN auth.users u ON u.id = pr.id
  WHERE pr.id = p_actor_id;

  SELECT full_name INTO v_user_name FROM public.profiles WHERE id = v_new.user_id;

  INSERT INTO public.logs_auditoria
    (punch_id, empresa_id, alterado_por, alterado_por_email, alterado_por_role,
     usuario_alterado, usuario_alterado_nome, acao,
     valor_antigo, valor_novo, justificativa)
  VALUES
    (v_new.id, v_new.company_id, p_actor_id, v_email, v_role,
     v_new.user_id, v_user_name, 'update',
     to_jsonb(v_old), to_jsonb(v_new),
     COALESCE(NULLIF(p_justificativa, ''), 'Correção de ponto'));

  RETURN to_jsonb(v_new);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) Função transacional: APROVAR/RECUSAR + GRAVAR LOG
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_punch_with_audit(
  p_punch_id      bigint,
  p_decision      text,
  p_justificativa text,
  p_actor_id      uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old  public.punches%ROWTYPE;
  v_new  public.punches%ROWTYPE;
  v_role text;
  v_email text;
  v_user_name text;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decisão inválida';
  END IF;

  IF NOT public.can_edit_punch(p_actor_id, p_punch_id) THEN
    RAISE EXCEPTION 'Sem permissão para avaliar este ponto (perfil/empresa)';
  END IF;

  SELECT * INTO v_old FROM public.punches WHERE id = p_punch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ponto não encontrado';
  END IF;

  UPDATE public.punches SET
    approval_status = p_decision::public.punch_approval_status,
    approved_by     = p_actor_id,
    approved_at     = now(),
    edited_by       = p_actor_id,
    edited_at       = now()
  WHERE id = p_punch_id
  RETURNING * INTO v_new;

  SELECT role::text, email INTO v_role, v_email
  FROM public.profiles pr JOIN auth.users u ON u.id = pr.id
  WHERE pr.id = p_actor_id;

  SELECT full_name INTO v_user_name FROM public.profiles WHERE id = v_new.user_id;

  INSERT INTO public.logs_auditoria
    (punch_id, empresa_id, alterado_por, alterado_por_email, alterado_por_role,
     usuario_alterado, usuario_alterado_nome, acao,
     valor_antigo, valor_novo, justificativa)
  VALUES
    (v_new.id, v_new.company_id, p_actor_id, v_email, v_role,
     v_new.user_id, v_user_name, CASE WHEN p_decision = 'approved' THEN 'approve' ELSE 'reject' END,
     to_jsonb(v_old), to_jsonb(v_new),
     COALESCE(NULLIF(p_justificativa, ''), CASE WHEN p_decision = 'approved' THEN 'Aprovação de marcação' ELSE 'Recusa de marcação' END));

  RETURN to_jsonb(v_new);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7) Consulta do histórico (RPC autenticada — usa o JWT do usuário)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_audit_logs(p_empresa_id uuid)
RETURNS TABLE (
  id bigint, punch_id bigint, empresa_id uuid,
  alterado_por uuid, alterado_por_email text, alterado_por_role text,
  usuario_alterado uuid, usuario_alterado_nome text,
  acao text, valor_antigo jsonb, valor_novo jsonb,
  justificativa text, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();

  IF NOT (
    v_role IN ('system_admin', 'admin')
    OR (v_role IN ('company_admin', 'manager') AND public.is_member_company(auth.uid(), p_empresa_id))
  ) THEN
    RAISE EXCEPTION 'Sem permissão para consultar os logs desta empresa';
  END IF;

  RETURN QUERY
  SELECT l.id, l.punch_id, l.empresa_id,
         l.alterado_por, l.alterado_por_email, l.alterado_por_role,
         l.usuario_alterado, l.usuario_alterado_nome,
         l.acao, l.valor_antigo, l.valor_novo,
         l.justificativa, l.created_at
  FROM public.logs_auditoria l
  WHERE l.empresa_id = p_empresa_id
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT 500;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8) CORREÇÃO DO BUG (multi-empresa): policy de punch_audit passa a aceitar
--    membros alternados (user_companies) — logs da 2ª empresa ficam visíveis.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "company_admin select company audit" ON public.punch_audit;
CREATE POLICY "company_admin select company audit"
ON public.punch_audit FOR SELECT TO authenticated
USING (
  public.is_system_admin(auth.uid())
  OR (
    public.is_company_admin(auth.uid())
    AND (company_id = public.my_company_id() OR public.is_member_company(auth.uid(), company_id))
  )
  OR (
    public.my_role() = 'manager'
    AND company_id = public.my_company_id()
  )
);

-- Também corrige o SELECT de punches na empresa alternada para gestores/admin:
-- policy extra que libera leitura quando o usuário é membro via user_companies.
DROP POLICY IF EXISTS "manager select team punches member" ON public.punches;
CREATE POLICY "manager select team punches member"
ON public.punches FOR SELECT TO authenticated
USING (
  public.is_company_admin(auth.uid())
  AND public.is_member_company(auth.uid(), company_id)
);

DROP POLICY IF EXISTS "company_admin select company punches member" ON public.punches;
CREATE POLICY "company_admin select company punches member"
ON public.punches FOR SELECT TO authenticated
USING (
  public.is_company_admin(auth.uid())
  AND public.is_member_company(auth.uid(), company_id)
);

DROP POLICY IF EXISTS "manager/admin update punches member" ON public.punches;
CREATE POLICY "manager/admin update punches member"
ON public.punches FOR UPDATE TO authenticated
USING (
  public.is_company_admin(auth.uid())
  AND public.is_member_company(auth.uid(), company_id)
);

-- ---------------------------------------------------------------------------
-- 9) Grants (funções chamáveis por RPC autenticada; log_auditoria fica privada)
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.is_member_company(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_edit_punch(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_punch_with_audit(bigint, timestamptz, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_punch_with_audit(bigint, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_audit_logs(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 10) EXTRA (opcional) — promover uma conta existente a Admin de Plataforma:
--     token "Programador/Suporte" que enxerga TODAS as empresas no painel Admin.
--     Descomente e ajuste o e-mail:
-- ---------------------------------------------------------------------------
-- UPDATE public.profiles SET role = 'system_admin'
-- WHERE id = (SELECT id FROM auth.users WHERE email = 'admin@teste.com')
--   AND role NOT IN ('system_admin');

-- ============================================================================
-- TESTE RÁPIDO (opcional): após rodar, o helper de membro deve dizer true
-- para um admin da 2ª empresa e a tabela logs_auditoria deve existir:
--   SELECT to_regclass('public.logs_auditoria');
--   SELECT public.is_member_company('<uuid_do_usuario>', '<uuid_da_acropolis>');
-- ============================================================================