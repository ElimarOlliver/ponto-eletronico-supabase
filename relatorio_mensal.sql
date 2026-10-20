-- ============================================================
-- relatorio_mensal.sql — Relatório mensal de ponto (com escala)
-- ============================================================
-- SOMENTE LEITURA. Rode no SQL Editor do Supabase DEPOIS de:
--   migration_escalas.sql + seed_massa_12x36.sql
--
-- Para escolher o mês, altere as duas datas abaixo (no início de cada
-- bloco) OU troque por literais direto nas consultas.
-- ============================================================

-- ============================================================
-- (A) ESPELHO DE PONTO DIÁRIO — 1 linha por dia, por colaborador
-- ============================================================
-- Mostra, dia a dia: é dia de escala? quantos minutos previstos,
-- trabalhados, extra e déficit. Os minutos trabalhados são calculados
-- emparelhando as batidas: (out - in) menos as pausas (break_end -
-- break_start). Batidas 'rejected' NÃO contam.
WITH periodo AS (
  SELECT DATE '2026-09-01' AS ini, DATE '2026-09-30' AS fim
),
alvo AS (
  SELECT p.id AS user_id, p.full_name, u.email
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE u.email IN ('edenilza@pordosol2.com.br','mayara@pordosol2.com.br',
                    'deusiane@pordosol2.com.br','pablo@pordosol2.com.br')
),
dias AS (
  SELECT a.user_id, a.full_name, a.email, de.dia
  FROM alvo a
  CROSS JOIN periodo pr
  CROSS JOIN LATERAL public.dias_esperados(a.user_id, pr.ini, pr.fim) de
),
-- Minutos trabalhados por (usuário, dia), emparelhando in/out e pausas.
batidas AS (
  SELECT
    p.user_id,
    (p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
    p.p_type,
    (p.occurred_at AT TIME ZONE 'America/Sao_Paulo') AS ts_local
  FROM public.punches p
  CROSS JOIN periodo pr
  WHERE p.approval_status <> 'rejected'
    AND (p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN pr.ini AND pr.fim
),
pareado AS (
  SELECT
    user_id,
    dia,
    sum(
      CASE
        WHEN p_type = 'out'         THEN  EXTRACT(EPOCH FROM ts_local)
        WHEN p_type = 'in'          THEN -EXTRACT(EPOCH FROM ts_local)
        WHEN p_type = 'break_end'   THEN -EXTRACT(EPOCH FROM ts_local)
        WHEN p_type = 'break_start' THEN  EXTRACT(EPOCH FROM ts_local)
        ELSE 0
      END
    ) AS segundos
  FROM batidas
  GROUP BY user_id, dia
)
SELECT
  d.email,
  d.full_name,
  d.dia,
  to_char(d.dia, 'Dy')                                   AS dia_semana,
  EXISTS (
    SELECT 1 FROM public.holidays h
    WHERE h.active AND h.h_date = d.dia
      AND (h.company_id IS NULL OR h.company_id = (
        SELECT company_id FROM public.profiles WHERE id = d.user_id))
  )                                                       AS feriado,
  de.expected_min                                          AS previsto_min,
  GREATEST(COALESCE(round(pa.segundos / 60.0), 0), 0)::int AS trabalhado_min,
  GREATEST(COALESCE(round(pa.segundos / 60.0), 0) - de.expected_min, 0)::int AS extra_min,
  GREATEST(de.expected_min - COALESCE(round(pa.segundos / 60.0), 0), 0)::int AS deficit_min,
  CASE
    WHEN de.is_work IS NOT TRUE THEN 'Folga'
    WHEN COALESCE(pa.segundos, 0) = 0 THEN 'Falta'
    ELSE 'OK'
  END                                                      AS situacao
FROM dias d
JOIN LATERAL public.dias_esperados(d.user_id, d.dia, d.dia) de ON true
LEFT JOIN pareado pa ON pa.user_id = d.user_id AND pa.dia = d.dia
ORDER BY d.email, d.dia;


-- ============================================================
-- (B) TOTAIS DO MÊS — total de horas normais + saldo de horas
-- ============================================================
WITH periodo AS (
  SELECT DATE '2026-09-01' AS ini, DATE '2026-09-30' AS fim
),
alvo AS (
  SELECT p.id AS user_id, p.full_name, u.email
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE u.email IN ('edenilza@pordosol2.com.br','mayara@pordosol2.com.br',
                    'deusiane@pordosol2.com.br','pablo@pordosol2.com.br')
),
dias AS (
  SELECT a.user_id, a.full_name, a.email, de.dia, de.is_work, de.expected_min
  FROM alvo a
  CROSS JOIN periodo pr
  CROSS JOIN LATERAL public.dias_esperados(a.user_id, pr.ini, pr.fim) de
),
batidas AS (
  SELECT
    p.user_id,
    (p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
    p.p_type,
    EXTRACT(EPOCH FROM (p.occurred_at AT TIME ZONE 'America/Sao_Paulo')) AS ep
  FROM public.punches p
  CROSS JOIN periodo pr
  WHERE p.approval_status <> 'rejected'
    AND (p.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN pr.ini AND pr.fim
),
pareado AS (
  SELECT user_id, dia,
    sum(CASE
      WHEN p_type = 'out' THEN ep WHEN p_type = 'in' THEN -ep
      WHEN p_type = 'break_end' THEN -ep WHEN p_type = 'break_start' THEN ep
      ELSE 0 END) AS segundos
  FROM batidas GROUP BY user_id, dia
),
por_dia AS (
  SELECT
    d.user_id, d.email, d.full_name, d.dia, d.is_work, d.expected_min,
    GREATEST(COALESCE(round(pa.segundos / 60.0), 0), 0)::int AS worked
  FROM dias d
  LEFT JOIN pareado pa ON pa.user_id = d.user_id AND pa.dia = d.dia
)
SELECT
  email,
  full_name,
  count(*) FILTER (WHERE is_work)                                AS dias_escala,
  count(*) FILTER (WHERE is_work AND worked > 0)                 AS dias_trabalhados,
  count(*) FILTER (WHERE is_work AND worked = 0)                 AS faltas,
  sum(expected_min)                                              AS previsto_min,
  sum(worked)                                                    AS trabalhado_min,
  sum(GREATEST(worked - expected_min, 0))                        AS extra_min,
  sum(GREATEST(expected_min - worked, 0))                        AS deficit_min,
  (sum(worked) - sum(expected_min))                              AS saldo_min,
  -- Versões em horas:minutos para leitura humana.
  to_char((sum(worked) || ' minutes')::interval, 'HH24:MI')      AS trabalhado_hhmm,
  to_char(((sum(worked) - sum(expected_min)) || ' minutes')::interval, 'HH24:MI') AS saldo_hhmm
FROM por_dia
GROUP BY email, full_name
ORDER BY email;
