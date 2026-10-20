-- ============================================================
-- migration_escalas.sql — Escalas de trabalho com histórico/vigência
-- ============================================================
-- MOTIVO (regra de negócio real da farmácia):
--   O motor de jornada assumia 8h/dia, segunda a sexta, e tratava
--   sábado/domingo como folga fixa. Farmácias trabalham em escala
--   12x36 (12h de plantão, 36h de descanso), com âncoras DIFERENTES
--   por colaborador. Sem modelar isso, o "saldo de horas" do relatório
--   fica errado (todo plantão de 12h viraria hora extra e todo dia de
--   escala caído em fim de semana viraria falta).
--
-- ESTA MIGRAÇÃO:
--   1) Cria public.escalas (histórico: cada linha vale de valid_from
--      até valid_to, permitindo mudança de escala ao longo do tempo).
--   2) RLS: cada colaborador vê a própria escala; gestores/admins veem
--      as da empresa (mesmo padrão de profiles/punches).
--   3) Cria public.dias_esperados(escala, início, fim) — função pura
--      que devolve, dia a dia, se é dia de trabalho e quantos minutos
--      são esperados. Usada pelo backend para calcular o saldo.
--
-- IDEMPOTENTE E RE-EXECUTÁVEL: pode rodar em qualquer ordem, quantas
-- vezes quiser, sem 42P01/42P06/42710/42804.
-- ============================================================

-- ---------- 0) Pré-requisitos defensivos ----------
-- O SQL Editor do Supabase roda o arquivo como UMA transação: se qualquer
-- statement falhar, TUDO é revertido (inclusive o CREATE TABLE lá embaixo),
-- e aí o seed reclama "Rode migration_escalas.sql antes deste seed".
-- A causa mais comum é uma função-helper de RLS ausente (is_company_admin,
-- my_company_id, ...), que faz o CREATE POLICY abortar. Para o arquivo ser
-- autossuficiente, garantimos as funções-helper aqui (CREATE OR REPLACE é
-- idempotente: não muda nada se elas já existirem com o mesmo corpo).

-- 0.1) Confere as tabelas-base: sem elas, nada abaixo funciona.
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Tabela public.profiles não existe. Rode supabase.sql (ou a migração base) ANTES deste arquivo.';
  END IF;
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'Tabela public.companies não existe. Rode supabase.sql (ou a migração base) ANTES deste arquivo.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.my_company_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT company_id FROM public.profiles WHERE id = auth.uid(); $$;

CREATE OR REPLACE FUNCTION public.is_system_admin(uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = uid AND p.role = 'system_admin'); $$;

CREATE OR REPLACE FUNCTION public.is_company_admin(uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = uid AND p.role IN ('admin', 'company_admin', 'system_admin')); $$;

CREATE OR REPLACE FUNCTION public.is_manager_of(manager uuid, employee uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles e
    JOIN public.profiles m ON m.id = manager
    WHERE e.id = employee AND e.manager_id = manager AND e.company_id = m.company_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.my_company_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_system_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_manager_of(uuid, uuid) TO authenticated;

-- ---------- 1) Tabela ----------
CREATE TABLE IF NOT EXISTS public.escalas (
  id                    bigserial PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- 'padrao' = seg-sex 8h (comportamento antigo);
  -- '12x36'  = 1 dia trabalhado (12h) + 1 dia de folga (36h);
  -- 'personalizada' = usa work_days (dias da semana) + expected_min.
  tipo                  text NOT NULL DEFAULT 'padrao'
                          CHECK (tipo IN ('padrao', '12x36', 'personalizada')),
  -- Duração do ciclo em dias (12x36 => 2). Para 'personalizada' é ignorado.
  ciclo_dias            integer NOT NULL DEFAULT 1 CHECK (ciclo_dias >= 1),
  -- Índice do dia dentro do ciclo que é TRABALHADO (12x36 => 0).
  ciclo_dia_trabalho    integer NOT NULL DEFAULT 0 CHECK (ciclo_dia_trabalho >= 0),
  -- Data-âncora: um dia conhecido como TRABALHADO. O ciclo é contado a
  -- partir daqui ((data - ancora) mod ciclo_dias == ciclo_dia_trabalho).
  ancora               date NOT NULL,
  -- Minutos esperados por dia trabalhado (12x36 => 660 = 12h - 1h almoço).
  expected_min          integer NOT NULL DEFAULT 480 CHECK (expected_min BETWEEN 0 AND 1440),
  -- Para 'personalizada': dias da semana trabalhados (0=domingo..6=sábado).
  work_days             smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
  -- Vigência (histórico). valid_to NULL = vigente.
  valid_from            date NOT NULL DEFAULT CURRENT_DATE,
  valid_to              date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_escalas_vigencia CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_escalas_user_vigencia
  ON public.escalas (user_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_escalas_company
  ON public.escalas (company_id);

-- Garante UMA escala vigente por vez para um usuário (valid_to NULL).
-- Se o negócio precisar de várias faixas históricas com o mesmo início,
-- o índice único abaixo só impede duplicar a vigente aberta.
CREATE UNIQUE INDEX IF NOT EXISTS ux_escalas_user_vigente
  ON public.escalas (user_id) WHERE valid_to IS NULL;

-- ---------- 2) Preenche company_id a partir do profile (fonte da verdade) ----------
CREATE OR REPLACE FUNCTION public.fill_escala_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT company_id INTO NEW.company_id FROM public.profiles WHERE id = NEW.user_id;
  IF NEW.company_id IS NULL THEN
    RAISE EXCEPTION 'Perfil sem empresa (user_id=%)', NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_escala_company ON public.escalas;
CREATE TRIGGER trg_fill_escala_company
BEFORE INSERT ON public.escalas
FOR EACH ROW
EXECUTE FUNCTION public.fill_escala_company();

-- ---------- 3) RLS ----------
ALTER TABLE public.escalas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "escala self select" ON public.escalas;
CREATE POLICY "escala self select"
ON public.escalas FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "company_admin select company escalas" ON public.escalas;
CREATE POLICY "company_admin select company escalas"
ON public.escalas FOR SELECT TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

DROP POLICY IF EXISTS "manager select team escalas" ON public.escalas;
CREATE POLICY "manager select team escalas"
ON public.escalas FOR SELECT TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_manager_of(auth.uid(), user_id)
);

DROP POLICY IF EXISTS "system_admin all escalas" ON public.escalas;
CREATE POLICY "system_admin all escalas"
ON public.escalas FOR ALL TO authenticated
USING (public.is_system_admin(auth.uid()))
WITH CHECK (public.is_system_admin(auth.uid()));

DROP POLICY IF EXISTS "company_admin manage company escalas" ON public.escalas;
CREATE POLICY "company_admin manage company escalas"
ON public.escalas FOR ALL TO authenticated
USING (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
)
WITH CHECK (
  company_id = public.my_company_id()
  AND public.is_company_admin(auth.uid())
);

-- ---------- 4) Função: resolve a escala vigente numa data ----------
-- Retorna a linha de escala que cobre p_date (valid_from <= date <= valid_to
-- ou valid_to NULL). Se houver mais de uma (histórico malformado), pega a
-- mais recente.
CREATE OR REPLACE FUNCTION public.escala_vigente(p_user uuid, p_date date)
RETURNS public.escalas
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.escalas e
  WHERE e.user_id = p_user
    AND e.valid_from <= p_date
    AND (e.valid_to IS NULL OR e.valid_to >= p_date)
  ORDER BY e.valid_from DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.escala_vigente(uuid, date) TO authenticated, service_role;

-- ---------- 5) Função: dias esperados de um período ----------
-- Devolve uma linha por dia do período, com:
--   is_work     -> é dia de trabalho segundo a escala do colaborador?
--   expected_min-> minutos esperados naquele dia (0 se folga)
-- Regras:
--   * 12x36: ciclo de 2 dias contado a partir da âncora. Feriado NÃO
--     anula a expectativa (a farmácia abre) — mantido de propósito.
--   * padrao: seg-sex (work_days default {1..5}), feriado anula.
--   * personalizada: usa work_days; feriado anula.
-- Sem escala cadastrada: cai no 'padrao' (compatibilidade total).
CREATE OR REPLACE FUNCTION public.dias_esperados(
  p_user  uuid,
  p_start date,
  p_end   date
)
RETURNS TABLE (dia date, is_work boolean, expected_min integer, is_holiday boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_esc      public.escalas;
  v_user_cid uuid;
  v_cur      date := p_start;
  v_work     boolean;
  v_exp      integer;
  v_hol      boolean;
  v_mod      integer;
BEGIN
  IF p_end < p_start THEN
    RETURN;
  END IF;

  SELECT company_id INTO v_user_cid FROM public.profiles WHERE id = p_user;

  SELECT * INTO v_esc FROM public.escala_vigente(p_user, p_start);

  WHILE v_cur <= p_end LOOP
    -- Feriado ativo (nacional ou da empresa do colaborador).
    SELECT EXISTS (
      SELECT 1 FROM public.holidays h
      WHERE h.active
        AND h.h_date = v_cur
        AND (h.company_id IS NULL OR h.company_id = v_user_cid)
    ) INTO v_hol;

    IF v_esc.id IS NULL THEN
      -- Sem escala: seg-sex 8h, feriado folga (comportamento antigo).
      v_work := EXTRACT(DOW FROM v_cur)::int BETWEEN 1 AND 5 AND NOT v_hol;
      v_exp  := CASE WHEN v_work THEN 480 ELSE 0 END;
    ELSIF v_esc.tipo = '12x36' THEN
      -- Ciclo: (dia - âncora) mod ciclo_dias == ciclo_dia_trabalho.
      -- Postgres % com número negativo pode dar negativo: normaliza.
      v_mod  := ((v_cur - v_esc.ancora)::int % v_esc.ciclo_dias + v_esc.ciclo_dias) % v_esc.ciclo_dias;
      v_work := v_mod = (v_esc.ciclo_dia_trabalho % v_esc.ciclo_dias);
      -- Feriado NÃO anula a expectativa no 12x36 (a farmácia abre).
      v_exp  := CASE WHEN v_work THEN v_esc.expected_min ELSE 0 END;
    ELSE
      -- 'padrao' ou 'personalizada': usa work_days + expected_min; feriado folga.
      v_work := EXTRACT(DOW FROM v_cur)::int = ANY (v_esc.work_days) AND NOT v_hol;
      v_exp  := CASE WHEN v_work THEN v_esc.expected_min ELSE 0 END;
    END IF;

    dia := v_cur;
    is_work := v_work;
    expected_min := v_exp;
    is_holiday := v_hol;
    RETURN NEXT;
    v_cur := v_cur + 1;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dias_esperados(uuid, date, date) TO authenticated, service_role;

-- ---------- 6) Prova ----------
-- (Opcional) Mostra as escalas cadastradas após rodar a massa de dados.
SELECT 'migration_escalas aplicada' AS status;
