-- ============================================================
-- seed_massa_12x36.sql — Massa de teste: escala 12x36 + pontos Set/2026
-- ============================================================
-- RODE NA ORDEM: supabase.sql -> migration_multi_company.sql ->
-- migration_auditoria_logs.sql -> migration_escalas.sql -> seed.sql
-- -> ESTE ARQUIVO.  (Idempotente: pode rodar mais de uma vez.)
--
-- O QUE FAZ:
--   1) Define uma escala 12x36 para CADA colaborador de teste, com
--      âncoras DIFERENTES (ciclos defasados), como na farmácia real.
--   2) Gera os pontos de SETEMBRO/2026 (30 dias) para quem tem escala
--      de trabalho naquele dia, com variações de minutos (realismo).
--   3) Status de aprovação MISTO: a maioria 'approved', alguns
--      'pending' e um 'rejected' (que NÃO deve contar no relatório).
--
-- HORÁRIO DO PLANTÃO: 07:00–19:00 com 1h de almoço (12h de relógio,
-- 660 min efetivos). Variações de ±1..6 min para testar minutos quebrados.
-- ============================================================

-- ---------- 0) Pré-requisitos ----------
DO $$
BEGIN
  IF to_regclass('public.escalas') IS NULL THEN
    RAISE EXCEPTION 'Rode migration_escalas.sql antes deste seed';
  END IF;
END $$;

-- ---------- 1) Escalas 12x36 (âncoras defasadas por colaborador) ----------
-- Âncora = um dia conhecido como TRABALHADO. Usamos datas de Agosto/2026
-- variando o índice para que cada um tenha um ciclo próprio.
--   Edenilza -> ancora 2026-08-31 (seg)
--   Mayara   -> ancora 2026-09-01 (ter)
--   Deusiane -> ancora 2026-09-02 (qua)
--   Pablo    -> ancora 2026-09-03 (qui)
-- Assim, no dia 1 de setembro só Edenilza e Pablo (dependendo do ciclo)
-- trabalham — evita "todos iguais".
DO $$
DECLARE
  r record;
  v_uid uuid;
  v_cid uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('edenilza@pordosol2.com.br', DATE '2026-08-31'),
    ('mayara@pordosol2.com.br',   DATE '2026-09-01'),
    ('deusiane@pordosol2.com.br', DATE '2026-09-02'),
    ('pablo@pordosol2.com.br',    DATE '2026-09-03')
  ) AS v(email, ancora) LOOP
    SELECT u.id, p.company_id INTO v_uid, v_cid
    FROM auth.users u JOIN public.profiles p ON p.id = u.id
    WHERE u.email = r.email;

    IF v_uid IS NULL THEN
      RAISE NOTICE 'Colaborador % não encontrado — pulando', r.email;
      CONTINUE;
    END IF;

    -- Idempotência: remove TODA escala '12x36' anterior deste colaborador
    -- (independente da âncora e do valid_from). Isso limpa sobras de runs
    -- antigos do seed que poderiam deixar uma escala "vigente" errada e
    -- fazer o relatório cair no fallback padrão (22 dias úteis em vez de
    -- 15 plantões). Só apaga '12x36' — escalas reais de outro tipo ficam.
    DELETE FROM public.escalas
     WHERE user_id = v_uid
       AND tipo = '12x36';

    -- IMPORTANTE: valid_from tem que ser <= 01/09/2026 (primeiro dia da
    -- massa). Se ficar igual à âncora (alguns âncoras são 02 e 03/09), o
    -- dia 01/09 não acha escala vigente e cai no padrão seg-sex 8h — o
    -- relatório e o seed passariam a discordar. Por isso valid_from recua
    -- bem antes do período testado; a âncora segue sendo a referência do ciclo.
    INSERT INTO public.escalas
      (user_id, company_id, tipo, ciclo_dias, ciclo_dia_trabalho, ancora,
       expected_min, work_days, valid_from, valid_to)
    VALUES
      (v_uid, v_cid, '12x36', 2, 0, r.ancora, 660, '{0,1,2,3,4,5,6}',
       LEAST(r.ancora, DATE '2026-08-01'), NULL);
  END LOOP;
END $$;

-- ---------- 2) Limpa pontos de teste anteriores (Set/2026 da empresa) ----------
-- Só remove o que ESTE seed gerou (marca via note='SEED_12x36') para não
-- apagar dados reais. Ajuste a nota se mudar.
DELETE FROM public.punches
WHERE note = 'SEED_12x36'
  AND occurred_at >= TIMESTAMPTZ '2026-08-31 00:00:00-03'
  AND occurred_at <  TIMESTAMPTZ '2026-10-01 00:00:00-03';

-- ---------- 3) Gera os pontos de Setembro/2026 ----------
-- Para cada colaborador com escala 12x36, para cada dia de SETEMBRO em que
-- a escala manda trabalhar, insere 4 batidas (in / break_start / break_end /
-- out) com pequenas variações. approval_status misto.
DO $$
DECLARE
  v_start date := DATE '2026-09-01';
  v_end   date := DATE '2026-09-30';
  emp     record;
  d       date;
  esp     record;
  v_jit   integer;
  v_in    timestamptz;
  v_bs    timestamptz;
  v_be    timestamptz;
  v_out   timestamptz;
  v_seq   integer := 0;
  v_status public.punch_approval_status;
BEGIN
  FOR emp IN
    SELECT p.id AS user_id, p.company_id, u.email
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE u.email IN ('edenilza@pordosol2.com.br','mayara@pordosol2.com.br',
                      'deusiane@pordosol2.com.br','pablo@pordosol2.com.br')
  LOOP
    FOR d IN SELECT generate_series(v_start, v_end, INTERVAL '1 day')::date LOOP
      -- Consulta a própria função de escala: é dia de trabalho?
      SELECT * INTO esp FROM public.dias_esperados(emp.user_id, d, d);
      IF esp.is_work IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_seq := v_seq + 1;
      -- Variação determinística em minutos (-6..+6) para realismos e reprodutibilidade.
      v_jit := ((extract(day from d)::int * 7 + v_seq) % 13) - 6;

      -- 07:00 + jitter ; almoço 12:00 ; volta 13:00 ; saída 19:00
      v_in   := ((d + make_interval(mins => 7*60 + v_jit))::timestamp) AT TIME ZONE 'America/Sao_Paulo';
      v_bs   := ((d + make_interval(mins => 12*60 + (v_jit/2)))::timestamp) AT TIME ZONE 'America/Sao_Paulo';
      v_be   := ((d + make_interval(mins => 13*60 - (v_jit/3)))::timestamp) AT TIME ZONE 'America/Sao_Paulo';
      v_out  := ((d + make_interval(mins => 19*60 + (v_jit/2)))::timestamp) AT TIME ZONE 'America/Sao_Paulo';

      -- Status misto: define por posição no mês.
      v_status := CASE
        WHEN extract(day from d)::int % 17 = 0 THEN 'rejected'::public.punch_approval_status
        WHEN extract(day from d)::int % 5  = 0 THEN 'pending'::public.punch_approval_status
        ELSE 'approved'::public.punch_approval_status
      END;

      INSERT INTO public.punches
        (user_id, company_id, p_type, occurred_at, source, created_by,
         approval_status, note)
      VALUES
        (emp.user_id, emp.company_id, 'in',          v_in,  'seed', emp.user_id, v_status, 'SEED_12x36'),
        (emp.user_id, emp.company_id, 'break_start', v_bs,  'seed', emp.user_id, v_status, 'SEED_12x36'),
        (emp.user_id, emp.company_id, 'break_end',   v_be,  'seed', emp.user_id, v_status, 'SEED_12x36'),
        (emp.user_id, emp.company_id, 'out',         v_out, 'seed', emp.user_id, v_status, 'SEED_12x36');
    END LOOP;
  END LOOP;
END $$;

-- ---------- 4) Prova: mostra a escala e a contagem de pontos ----------
SELECT
  u.email,
  e.tipo,
  e.ciclo_dias,
  e.ancora,
  e.expected_min,
  (SELECT count(*) FROM public.punches p
     WHERE p.user_id = e.user_id
       AND p.note = 'SEED_12x36')                        AS pontos_gerados,
  (SELECT count(*) FROM public.punches p
     WHERE p.user_id = e.user_id
       AND p.note = 'SEED_12x36'
       AND p.approval_status = 'approved')               AS aprovados,
  (SELECT count(*) FROM public.punches p
     WHERE p.user_id = e.user_id
       AND p.note = 'SEED_12x36'
       AND p.approval_status = 'pending')                AS pendentes,
  (SELECT count(*) FROM public.punches p
     WHERE p.user_id = e.user_id
       AND p.note = 'SEED_12x36'
       AND p.approval_status = 'rejected')               AS recusados
FROM public.escalas e
JOIN auth.users u ON u.id = e.user_id
WHERE e.tipo = '12x36'
ORDER BY u.email;
