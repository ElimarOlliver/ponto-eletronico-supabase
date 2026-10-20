-- ============================================================================
-- INVESTIGAÇÃO — Por que o log de auditoria não registra ações de "Milena"/"jose"?
-- Execute no SQL Editor do Supabase, em ordem. Troque os '<VALORES>' conforme necessário.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) Existe a tabela de associação multi-empresa? (o schema mudou após a migração)
-- ----------------------------------------------------------------------------
SELECT to_regclass('public.user_companies') AS user_companies_existe,
       to_regclass('public.logs_auditoria')  AS logs_auditoria_existe,
       to_regclass('public.punch_audit')     AS punch_audit_existe;

-- ----------------------------------------------------------------------------
-- 1) Perfis (usuarios): empresa PADRÃO de cada usuário e o papel.
--    Diagnóstico: a RLS de punches/punch_audit enxerga SÓ profiles.company_id.
-- ----------------------------------------------------------------------------
SELECT p.id,
       au.email,
       p.full_name,
       p.role,
       p.company_id                          AS empresa_padrao_id,
       c.cnpj                                AS empresa_padrao_cnpj,
       c.nome                                AS empresa_padrao_nome
FROM public.profiles p
JOIN auth.users au ON au.id = p.id
LEFT JOIN public.companies c ON c.id = p.company_id
WHERE au.email ILIKE '%milena%' OR au.email ILIKE '%jose%'
ORDER BY au.email;

-- ----------------------------------------------------------------------------
-- 2) Associações multi-empresa (user_companies): a que empresas Milena/josé
--    "pertencem" além da padrão? (a RLS antiga NÃO enxerga essa tabela)
-- ----------------------------------------------------------------------------
SELECT uc.user_id,
       au.email,
       uc.company_id,
       c.cnpj,
       c.nome,
       uc.role_in_company
FROM public.user_companies uc
JOIN auth.users au   ON au.id = uc.user_id
JOIN public.companies c ON c.id = uc.company_id
WHERE au.email ILIKE '%milena%' OR au.email ILIKE '%jose%'
ORDER BY au.email, c.nome;

-- ----------------------------------------------------------------------------
-- 3) Registros de punch_audit existentes para Milena/josé (se aparecerem aqui
--    e NÃO na tela/query deles, é problema de RLS de LEITURA = bug de visibilidade).
-- ----------------------------------------------------------------------------
SELECT a.id,
       a.punch_id,
       a.action,
       a.actor,
       au.email       AS ator_email,
       a.company_id,
       c.cnpj         AS cnpj_empresa_do_registro,
       a.created_at
FROM public.punch_audit a
LEFT JOIN auth.users au    ON au.id = a.actor
LEFT JOIN public.companies c ON c.id = a.company_id
WHERE au.email ILIKE '%milena%' OR au.email ILIKE '%jose%'
ORDER BY a.created_at DESC
LIMIT 50;

-- ----------------------------------------------------------------------------
-- 4) Coração do bug: o que a RLS "enxerga" vs. a empresa em que ele opera.
--    Se membro_acropolis = true mas a consulta anterior não retorna os logs
--    da Acropolis com o JWT do usuário, a policy ainda está ancorada na antiga.
--    (troque pelos UUIDs reais obtidos nas queries 1/2)
-- ----------------------------------------------------------------------------
SELECT p.id,
       au.email,
       public.my_company_id()                          AS empresa_que_a_rls_enxerga,
       public.is_member_company(p.id, '<ID_DA_ACROPOLIS>') AS membro_acropolis,
       public.is_manager_of(p.id, p.id)                AS controle_gestor
FROM public.profiles p
JOIN auth.users au ON au.id = p.id
WHERE au.email ILIKE '%milena%' OR au.email ILIKE '%jose%';

-- ----------------------------------------------------------------------------
-- 5) Policies ATIVAS em punches / punch_audit / logs_auditoria.
--    Procure as que usam "company_id = my_company_id()" — são as que bloqueiam
--    a empresa alternada. Depois de rodar migration_auditoria_logs.sql, devem
--    aparecer policies usando is_member_company().
-- ----------------------------------------------------------------------------
SELECT c.relname           AS tabela,
       pol.polname         AS policy,
       pol.polcmd          AS comando,
       pg_get_expr(pol.polqual,      pol.polrelid) AS using_expr,
       pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
WHERE c.relname IN ('punch_audit', 'punches', 'logs_auditoria')
ORDER BY c.relname, pol.polname;

-- ----------------------------------------------------------------------------
-- 6) Dados "sujos" que podem quebrar o INSERT do log silenciosamente:
--    a) punch_audit órfão (punch_id sem punch)  b) ator sem profile
--    c) valores nulos críticos
-- ----------------------------------------------------------------------------
-- a) órfãos
SELECT a.id, a.punch_id
FROM public.punch_audit a
LEFT JOIN public.punches p ON p.id = a.punch_id
WHERE a.punch_id IS NOT NULL AND p.id IS NULL;

-- b) ator sem profile correspondente (violaria FK de logs_auditoria)
SELECT DISTINCT a.actor
FROM public.punch_audit a
LEFT JOIN public.profiles pr ON pr.id = a.actor
WHERE a.actor IS NOT NULL AND pr.id IS NULL;

-- c) nulos
SELECT count(*) FILTER (WHERE a.actor      IS NULL) AS actor_nulo,
       count(*) FILTER (WHERE a.company_id IS NULL) AS company_nulo,
       count(*) AS total
FROM public.punch_audit a;

-- ----------------------------------------------------------------------------
-- 7) Teste do controle usado pela função transacional (pós-migração):
--    update_punch_with_audit só executa se can_edit_punch = true.
-- ----------------------------------------------------------------------------
-- SELECT public.can_edit_punch('<UID_MILENA>', <ID_DE_UM_PUNCH_DA_ACROPOLIS>);

-- ----------------------------------------------------------------------------
-- 8) Pós-migração: visualize os logs de negócio (quem/por quê/quando).
-- ----------------------------------------------------------------------------
SELECT l.id,
       au_ator.email          AS alterado_por,
       l.alterado_por_role    AS permissao_do_ator,
       l.acao,
       au_user.email          AS usuario_alterado,
       l.usuario_alterado_nome,
       l.justificativa,
       l.valor_antigo ->> 'occurred_at' AS valor_antigo,
       l.valor_novo  ->> 'occurred_at' AS valor_novo,
       l.empresa_id,
       l.created_at
FROM public.logs_auditoria l
JOIN auth.users au_ator ON au_ator.id = l.alterado_por
LEFT JOIN auth.users au_user ON au_user.id = l.usuario_alterado
ORDER BY l.created_at DESC
LIMIT 100;

-- ============================================================================
-- DIAGNÓSTICO PRONTO (o que as queries acima tendem a confirmar):
--   * Todas as policies de punches/punch_audit usam profiles.company_id
--     (empresa PADRÃO). Milena/josé são multi-empresa: ao operar na 2ª empresa,
--     o UPDATE/leitura com o JWT deles é NEGADO pela RLS -> o log nunca nasce
--     (ou nasce via service key e fica INVISÍVEL para eles na leitura).
--   * Solução: rodar migration_auditoria_logs.sql (função transacional +
--     policies com is_member_company()) — atualiza + grava logs na MESMA
--     transação, visível em qualquer empresa do vínculo.
-- ============================================================================