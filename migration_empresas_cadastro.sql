-- ============================================================
-- migration_empresas_cadastro.sql
-- Cadastro de Empresa (tenant) + endereço estruturado
-- ============================================================
-- MOTIVO:
--   O Administrador (Super Admin) gerencia as EMPRESAS (CNPJs). O
--   cadastro de empresa precisa de dados cadastrais completos:
--   razão social, nome fantasia e endereço estruturado (CEP,
--   logradouro, número, bairro, cidade, UF).
--
--   A tabela companies só tinha (cnpj, nome, ativa). Esta migração:
--     1) adiciona as colunas novas (idempotente);
--     2) cria a RPC criar_empresa(...) que valida e insere numa ÚNICA
--        transação (validação de CNPJ + endereço + duplicidade);
--     3) mantém compatibilidade com companies.endereco (texto livre),
--        preenchendo-o automaticamente a partir do endereço estruturado
--        (usado no cabeçalho do Espelho de Ponto / Anexo II).
--
-- IDEMPOTENTE E RE-EXECUTÁVEL. Rode depois de supabase.sql.
-- ============================================================

-- ---------- 0) Pré-requisito ----------
DO $$
BEGIN
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'Rode supabase.sql antes (tabela public.companies ausente).';
  END IF;
END $$;

-- ---------- 1) Colunas cadastrais da empresa ----------
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS nome_fantasia text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS cep           text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logradouro    text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS numero        text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS bairro        text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS cidade        text;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS uf            text;
-- endereco já pode existir (migration_espelho_mte.sql); garante aqui também.
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS endereco      text;

-- Limpa CEP (só dígitos) e UF (2 letras maiúsculas) na gravação.
CREATE OR REPLACE FUNCTION public.normalize_company_address()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.cep := NULLIF(regexp_replace(COALESCE(NEW.cep, ''), '\D', '', 'g'), '');
  IF NEW.cep IS NOT NULL AND length(NEW.cep) <> 8 THEN
    RAISE EXCEPTION 'CEP deve ter 8 dígitos (recebido: %)', NEW.cep;
  END IF;
  NEW.uf := NULLIF(upper(regexp_replace(COALESCE(NEW.uf, ''), '[^A-Za-z]', '', 'g')), '');
  IF NEW.uf IS NOT NULL AND length(NEW.uf) <> 2 THEN
    RAISE EXCEPTION 'UF deve ter 2 letras (recebido: %)', NEW.uf;
  END IF;
  -- Mantém o texto livre 'endereco' coerente com o endereço estruturado,
  -- quando este último foi informado (compatível com o Espelho MTE).
  IF NEW.logradouro IS NOT NULL THEN
    NEW.endereco := concat_ws(
      ', ',
      NULLIF(trim(NEW.logradouro), ''),
      NULLIF(trim(NEW.numero), '')
    );
    NEW.endereco := NULLIF(
      concat_ws(
        ' - ',
        NEW.endereco,
        NULLIF(trim(NEW.bairro), '')
      ),
      ''
    );
    NEW.endereco := NULLIF(
      concat_ws(
        ' - ',
        NEW.endereco,
        NULLIF(concat_ws('/', trim(NEW.cidade), trim(NEW.uf)), '/')
      ),
      ''
    );
    NEW.endereco := NULLIF(
      concat_ws(' - ', NEW.endereco, CASE WHEN NEW.cep IS NOT NULL THEN 'CEP ' || NEW.cep END),
      ''
    );
  ELSIF NEW.endereco IS NULL THEN
    NEW.endereco := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_address_normalize ON public.companies;
CREATE TRIGGER trg_companies_address_normalize
BEFORE INSERT OR UPDATE ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.normalize_company_address();

-- ---------- 2) Validação de CNPJ (dígitos verificadores) ----------
CREATE OR REPLACE FUNCTION public.cnpj_valido(p_cnpj text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  c   text;
  i   integer;
  s   integer;
  d1  integer;
  d2  integer;
  w1  integer[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2];
  w2  integer[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
BEGIN
  c := regexp_replace(COALESCE(p_cnpj, ''), '\D', '', 'g');
  IF length(c) <> 14 THEN RETURN false; END IF;
  -- Rejeita sequências repetidas (ex.: 11111111111111).
  IF c ~ '^(\d)\1{13}$' THEN RETURN false; END IF;

  s := 0;
  FOR i IN 1..12 LOOP
    s := s + (substr(c, i, 1))::integer * w1[i];
  END LOOP;
  d1 := 11 - (s % 11);
  IF d1 >= 10 THEN d1 := 0; END IF;
  IF d1 <> (substr(c, 13, 1))::integer THEN RETURN false; END IF;

  s := 0;
  FOR i IN 1..13 LOOP
    s := s + (substr(c, i, 1))::integer * w2[i];
  END LOOP;
  d2 := 11 - (s % 11);
  IF d2 >= 10 THEN d2 := 0; END IF;
  RETURN d2 = (substr(c, 14, 1))::integer;
END;
$$;

-- ---------- 3) RPC transacional de cadastro de empresa ----------
CREATE OR REPLACE FUNCTION public.criar_empresa(
  p_cnpj          text,
  p_nome          text,
  p_nome_fantasia text DEFAULT NULL,
  p_cep           text DEFAULT NULL,
  p_logradouro    text DEFAULT NULL,
  p_numero        text DEFAULT NULL,
  p_bairro        text DEFAULT NULL,
  p_cidade        text DEFAULT NULL,
  p_uf            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cnpj text;
  v_row  jsonb;
BEGIN
  v_cnpj := regexp_replace(COALESCE(p_cnpj, ''), '\D', '', 'g');

  IF length(v_cnpj) <> 14 THEN
    RAISE EXCEPTION 'CNPJ deve ter 14 dígitos (recebido: %).', COALESCE(p_cnpj, '');
  END IF;
  IF NOT public.cnpj_valido(v_cnpj) THEN
    RAISE EXCEPTION 'CNPJ inválido (dígitos verificadores não conferem): %', v_cnpj;
  END IF;
  IF NULLIF(trim(COALESCE(p_nome, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Razão Social é obrigatória.';
  END IF;

  INSERT INTO public.companies (
    cnpj, nome, nome_fantasia, cep, logradouro, numero, bairro, cidade, uf, ativa
  )
  VALUES (
    v_cnpj,
    trim(p_nome),
    NULLIF(trim(COALESCE(p_nome_fantasia, '')), ''),
    NULLIF(regexp_replace(COALESCE(p_cep, ''), '\D', '', 'g'), ''),
    NULLIF(trim(COALESCE(p_logradouro, '')), ''),
    NULLIF(trim(COALESCE(p_numero, '')), ''),
    NULLIF(trim(COALESCE(p_bairro, '')), ''),
    NULLIF(trim(COALESCE(p_cidade, '')), ''),
    NULLIF(upper(trim(COALESCE(p_uf, ''))), ''),
    true
  )
  RETURNING to_jsonb(companies.*) INTO v_row;

  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Já existe uma empresa cadastrada com este CNPJ (%).', v_cnpj;
END;
$$;

-- Só o service_role (backend) executa: o cadastro passa pelo servidor,
-- que valida permissões (Super Admin) antes de chamar.
REVOKE ALL ON FUNCTION public.criar_empresa(
  text, text, text, text, text, text, text, text, text
) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_empresa(
  text, text, text, text, text, text, text, text, text
) TO service_role;

-- ---------- 4) Prova ----------
SELECT 'migration_empresas_cadastro aplicada' AS status;
