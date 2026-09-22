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