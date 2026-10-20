-- ============================================================
-- diag_escalas.sql — Diagnóstico (SOMENTE LEITURA) antes de rodar a migração
-- ============================================================
-- Se o seed reclamou "Rode migration_escalas.sql antes deste seed", rode
-- ESTE arquivo no SQL Editor e me mande o resultado. Ele mostra exatamente
-- o que falta. Não altera nada.
-- ============================================================

-- 1) Tabelas base e a de escalas existem?
SELECT
  to_regclass('public.companies') AS tem_companies,
  to_regclass('public.profiles')  AS tem_profiles,
  to_regclass('public.punches')   AS tem_punches,
  to_regclass('public.holidays')  AS tem_holidays,
  to_regclass('public.escalas')   AS tem_escalas;

-- 2) Funções-helper de RLS existem? (a falta delas faz a migração abortar)
SELECT
  to_regprocedure('public.my_company_id()')            AS tem_my_company_id,
  to_regprocedure('public.is_system_admin(uuid)')      AS tem_is_system_admin,
  to_regprocedure('public.is_company_admin(uuid)')     AS tem_is_company_admin,
  to_regprocedure('public.is_manager_of(uuid,uuid)')   AS tem_is_manager_of;

-- 3) Funções criadas por migration_escalas.sql?
SELECT
  to_regprocedure('public.escala_vigente(uuid,date)')          AS tem_escala_vigente,
  to_regprocedure('public.dias_esperados(uuid,date,date)')     AS tem_dias_esperados;

-- 4) Os 4 colaboradores de teste existem (em auth.users e profiles)?
SELECT u.email
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE u.email IN ('edenilza@pordosol2.com.br','mayara@pordosol2.com.br',
                  'deusiane@pordosol2.com.br','pablo@pordosol2.com.br')
ORDER BY u.email;

-- 5) Se 'escalas' já existe, mostra o que tem dentro.
SELECT
  (SELECT count(*) FROM public.escalas)                       AS total_escalas,
  (SELECT count(*) FROM public.escalas WHERE valid_to IS NULL) AS escalas_vigentes;

-- 6) Conteúdo detalhado das escalas (descobre sobras de runs antigos do seed).
SELECT e.user_id, u.email, e.tipo, e.ciclo_dias, e.ciclo_dia_trabalho,
       e.ancora, e.expected_min, e.valid_from, e.valid_to
FROM public.escalas e
LEFT JOIN auth.users u ON u.id = e.user_id
ORDER BY u.email, e.valid_from;

-- 7) Quantos pontos da massa existem e em que dias (note='SEED_12x36').
SELECT
  p.user_id,
  u.email,
  count(*)                          AS total_batidas,
  count(DISTINCT (p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date) AS dias_com_batida,
  min(p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date AS primeiro_dia,
  max(p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date AS ultimo_dia
FROM public.punches p
LEFT JOIN auth.users u ON u.id = p.user_id
WHERE p.note = 'SEED_12x36'
GROUP BY p.user_id, u.email
ORDER BY u.email;

-- 8) O que a escala ATUAL diz para Setembro/2026 (dias de trabalho por pessoa).
SELECT u.email,
       count(*) FILTER (WHERE de.is_work) AS dias_escala_set2026
FROM auth.users u
CROSS JOIN LATERAL public.dias_esperados(u.id, DATE '2026-09-01', DATE '2026-09-30') de
WHERE u.email IN ('edenilza@pordosol2.com.br','mayara@pordosol2.com.br',
                  'deusiane@pordosol2.com.br','pablo@pordosol2.com.br')
GROUP BY u.email
ORDER BY u.email;
