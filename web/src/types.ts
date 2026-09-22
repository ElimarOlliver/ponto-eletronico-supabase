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
}

export interface TimesheetTotals {
  expected_min: number;
  worked_min: number;
  overtime_min: number;
  deficit_min: number;
  balance_min: number;
  has_pending: boolean;
  has_incomplete: boolean;
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
  ativa?: boolean;
  created_at?: string;
  colaborador_count?: number | null;
}

export interface AdminTeamMember extends TeamMember {
  email?: string | null;
}

export interface AdminTeamResponse {
  company: { id: string; nome?: string; cnpj?: string; ativa?: boolean };
  team: AdminTeamMember[];
}