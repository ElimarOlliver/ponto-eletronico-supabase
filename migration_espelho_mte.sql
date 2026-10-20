-- ============================================================
-- migration_espelho_mte.sql — Campos cadastrais do Espelho de Ponto
--                              (Portaria MTE 1510, Anexo II)
-- ============================================================
-- MOTIVO:
--   O relatório oficial "Espelho de Ponto" (Anexo II da Portaria 1510)
--   exige, no cabeçalho, dados que o sistema ainda não guardava:
--     * EMPREGADOR : CNPJ + razão social + ENDEREÇO do local de serviço
--     * EMPREGADO  : nome, CPF, PIS, cargo, CTPS, data de admissão
--   Sem esses campos, o PDF/JSON sairia com travessões no lugar exigido.
--
-- O QUE ESTA MIGRAÇÃO FAZ:
--   1) companies.endereco
--   2) profiles.cpf, .pis, .ctps, .cargo, .data_admissao
--   3) Normaliza CPF/PIS (só dígitos) num trigger BEFORE, mantendo-os
--      NULL quando o valor enviado é vazio ("não informado").
--
-- IDEMPOTENTE E RE-EXECUTÁVEL: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE
-- (pode rodar em qualquer ordem, quantas vezes quiser, sem 42P01/42710/42804).
-- NÃO apaga nem sobrescreve dados existentes.
-- ============================================================

-- ---------- 0) Pré-requisito defensivo ----------
-- Rode DEPOIS de supabase.sql (profiles/companies). Mensagem clara se faltar.
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Tabela public.profiles não existe. Rode supabase.sql ANTES deste arquivo.';
  END IF;
  IF to_regclass('public.companies') IS NULL THEN
    RAISE EXCEPTION 'Tabela public.companies não existe. Rode supabase.sql ANTES deste arquivo.';
  END IF;
END $$;

-- ---------- 1) Endereço da empresa (local de prestação de serviço) ----------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS endereco text;

-- ---------- 2) Dados cadastrais do empregado ----------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS cpf            text,
  ADD COLUMN IF NOT EXISTS pis            text,
  ADD COLUMN IF NOT EXISTS ctps           text,
  ADD COLUMN IF NOT EXISTS cargo          text,
  ADD COLUMN IF NOT EXISTS data_admissao  date;

-- ---------- 3) Normalização: CPF/PIS só dígitos; vazio -> NULL ----------
-- NÃO valida dígito verificador (o RH pode importar dados legados); apenas
-- limpa máscara e trata string vazia como "não informado" (NULL), para o
-- relatório exibir "—" em vez de uma string vazia.
CREATE OR REPLACE FUNCTION public.normalize_profile_docs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.cpf := NULLIF(regexp_replace(COALESCE(NEW.cpf, ''), '\D', '', 'g'), '');
  NEW.pis := NULLIF(regexp_replace(COALESCE(NEW.pis, ''), '\D', '', 'g'), '');
  -- CPF tem 11 dígitos; valor curto provavelmente é lixo -> não trava o login,
  -- apenas descarta para não poluir o espelho.
  IF NEW.cpf IS NOT NULL AND length(NEW.cpf) <> 11 THEN
    NEW.cpf := NULL;
  END IF;
  IF NEW.pis IS NOT NULL AND length(NEW.pis) <> 11 THEN
    NEW.pis := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_profile_docs ON public.profiles;
CREATE TRIGGER trg_normalize_profile_docs
BEFORE INSERT OR UPDATE OF cpf, pis ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.normalize_profile_docs();

-- ---------- 4) Prova ----------
SELECT 'migration_espelho_mte aplicada' AS status;
