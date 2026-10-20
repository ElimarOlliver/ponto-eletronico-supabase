// Tipos 1:1 com as respostas reais da API (validados via probe em produção).

export type Role = 'employee' | 'manager' | 'company_admin' | 'system_admin' | 'admin';

export type PunchType = 'in' | 'out' | 'break_start' | 'break_end';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface CompanyEntry {
  id: string;
  cnpj: string;
  nome?: string;
  ativa?: boolean;
  role_in_company?: string;
}

export interface Me {
  id: string;
  full_name?: string | null;
  role: string;
  manager_id?: string | null;
  company_id?: string | null;
  ativo?: boolean | null;
  companies?: CompanyEntry[];
  company?: { cnpj?: string; nome?: string; ativa?: boolean } | null;
  company_cnpj?: string;
  company_nome?: string;
  company_ativa?: boolean;
}

export interface Punch {
  id: number;
  user_id: string;
  p_type: string;
  occurred_at: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  source?: string | null;
  note?: string | null;
  approval_status?: ApprovalStatus;
  approved_by?: string | null;
  approved_at?: string | null;
  company_id?: string | null;
  created_at?: string;
}

export interface TeamMember {
  id: string;
  full_name?: string | null;
  role: string;
  manager_id?: string | null;
  company_id?: string | null;
  /** Soft delete: false = inativo. */
  ativo?: boolean | null;
}

export interface TimesheetDay {
  date: string;
  weekday: number;
  holiday: boolean;
  expected_min: number;
  worked_min: number;
  overtime_min: number;
  deficit_min: number;
  status: 'ok' | 'incomplete' | 'absent' | 'holiday' | 'weekend' | string;
  pending: boolean;
  punches: number;
  approved_count?: number;
  pending_count?: number;
  rejected_count?: number;
  absent_justified?: boolean;
  absent_unjustified?: boolean;
  // Vista MTE (Anexo II Portaria 1510).
  marcacoes_eletronicas?: string[];
  jornada_realizada?: (string | null)[];
  tratamentos_efetuados?: {
    horario_original: string;
    ocorrencia: string;
    motivo: string;
    aprovado_por?: string | null;
  }[];
}

export interface TimesheetTotals {
  expected_min: number;
  worked_min: number;
  overtime_min: number;
  deficit_min: number;
  balance_min: number;
  has_pending: boolean;
  has_incomplete: boolean;
  approved_count?: number;
  pending_count?: number;
  rejected_count?: number;
  absences_justified?: number;
  absences_unjustified?: number;
}

export interface Timesheet {
  user_id: string;
  period: { start: string; end: string };
  days: TimesheetDay[];
  totals: TimesheetTotals;
}

export interface Holiday {
  id?: number | string;
  h_date: string;
  name: string;
  kind: string;
  company_id?: string | null;
  created_at?: string;
}

export interface Closing {
  id: number | string;
  period_start: string;
  period_end: string;
  status: string;
  closed_by?: string;
  created_at?: string;
}

// --- Auditoria legal (logs_auditoria) ---
// Registro imutável de cada alteração: quem (e-mail + nível de permissão),
// quem foi alterado, valores antigo/novo e justificativa.
export interface AuditLog {
  id: number;
  punch_id?: number | null;
  empresa_id?: string | null;
  alterado_por?: string | null;
  alterado_por_email?: string | null;
  alterado_por_role?: string | null;
  usuario_alterado?: string | null;
  usuario_alterado_nome?: string | null;
  acao?: string;
  valor_antigo?: unknown;
  valor_novo?: unknown;
  justificativa?: string | null;
  created_at?: string;
}

// --- Painel Admin (Programador/Suporte) ---
export interface AdminCompany {
  id: string;
  cnpj: string;
  nome?: string | null;
  nome_fantasia?: string | null;
  ativa?: boolean;
  created_at?: string;
  colaborador_count?: number | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  endereco?: string | null;
}

export interface CreateCompanyPayload {
  cnpj: string;
  nome: string;
  nome_fantasia?: string;
  cep?: string;
  logradouro?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
}

export interface AdminTeamMember extends TeamMember {
  email?: string | null;
}

// --- Cadastro de funcionário ---
export type EscalaTipo = 'padrao' | '12x36' | 'personalizada';

export interface CompanyOption {
  id: string;
  cnpj: string;
  nome?: string | null;
}

export interface CreateEmployeePayload {
  email: string;
  full_name: string;
  password: string;
  role: 'employee' | 'manager';
  company_id?: string;
  manager_id?: string;
  cpf?: string;
  pis?: string;
  ctps?: string;
  cargo?: string;
  data_admissao?: string;
  escala_tipo?: EscalaTipo;
  ancora?: string;
  expected_min?: number;
  work_days?: number[];
}

export interface CreateEmployeeResult {
  ok: boolean;
  user_id: string;
  email: string;
  company_id: string;
}

export interface AdminTeamResponse {
  company: { id: string; nome?: string; cnpj?: string; ativa?: boolean };
  team: AdminTeamMember[];
}

// --- Relatório de Fechamento de Ponto (PDF + JSON) ---
export interface ReportEmployee {
  user_id: string;
  full_name?: string | null;
  role?: string | null;
  company_id?: string | null;
  days: TimesheetDay[];
  totals: TimesheetTotals;
  summary: {
    days_worked: number;
    absences_justified: number;
    absences_unjustified: number;
  };
  // Dados cadastrais + horário contratual (cabeçalho do espelho MTE).
  cadastro?: {
    cpf?: string | null;
    pis?: string | null;
    ctps?: string | null;
    cargo?: string | null;
    data_admissao?: string | null;
  };
  escala_trabalho?: string | null;
  codigo_ch?: string | null;
  jornada_prevista?: {
    entrada?: string;
    inicio_intervalo?: string;
    fim_intervalo?: string;
    saida?: string;
  } | null;
}

// Espelho oficial Anexo II (Portaria 1510) — um por empregado.
export interface MteEspelho {
  relatorio_espelho_ponto: {
    metadados: {
      data_emissao: string;
      periodo_referencia: string;
      data_inicial: string;
      data_final: string;
    };
    empregador: { identificador_cnpj: string; razao_social: string; endereco: string };
    empregado: {
      nome: string;
      cpf: string;
      pis: string;
      cargo: string;
      ctps: string;
      data_admissao: string;
      escala_trabalho: string;
    };
    horarios_contratuais: {
      codigo_ch: string;
      jornada_prevista: { entrada?: string; inicio_intervalo?: string; fim_intervalo?: string; saida?: string };
    };
    registros_diarios: {
      dia: string;
      data: string;
      marcacoes_eletronicas: string[];
      jornada_realizada: (string | null)[];
      horas_extras: string;
      tratamentos_efetuados: { horario_original: string; ocorrencia: string; motivo: string; aprovado_por?: string | null }[];
      status_dia: string;
    }[];
    resumo_mensal_rh: {
      total_horas_trabalhadas: string;
      total_horas_extras: string;
      dias_trabalhados: number;
      faltas_justificadas_dias: number;
      faltas_nao_justificadas_dias: number;
      dias_para_desconto_salarial: number;
      status_fechamento_mes: string;
    };
  };
}

export interface MonthlyReport {
  kind: string;
  generated_at: string;
  period: { month: string; start: string; end: string };
  company: {
    id?: string | null;
    cnpj?: string | null;
    nome?: string | null;
    razao_social?: string | null;
    endereco?: string | null;
  };
  generated_by: { id: string; full_name?: string | null; role?: string | null };
  employees: ReportEmployee[];
  espelhos_mte?: MteEspelho[];
  totals: TimesheetTotals;
  count: number;
}