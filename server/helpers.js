import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const uuidSchema = z.string().uuid();
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const idParam = value => {
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'Invalid record id.');
  return result.data;
};
export const moneyNumber = value => Number(Number(value || 0).toFixed(2));
export const clientFields = {
  name: z.string().trim().min(1).max(120),
  contact: z.string().trim().max(120).optional().default(''),
  email: z.union([z.string().trim().email().max(200), z.literal('')]).optional().default(''),
  hourlyRate: z.coerce.number().min(0).max(1000000).optional().default(100),
};
export const projectFields = {
  clientId: uuidSchema,
  name: z.string().trim().min(1).max(160),
  status: z.enum(['In progress', 'Completed', 'On hold']).optional().default('In progress'),
  budget: z.coerce.number().min(0).max(100000000).optional().default(0),
  dueDate: dateSchema.nullable().optional().default(null),
};
export const taskFields = {
  projectId: uuidSchema,
  title: z.string().trim().min(1).max(240),
  dueDate: dateSchema.nullable().optional().default(null),
  done: z.boolean().optional().default(false),
};
export const entryFields = {
  projectId: uuidSchema,
  note: z.string().trim().max(500).optional().default('Tracked work'),
  date: dateSchema,
  hours: z.coerce.number().gt(0).max(24),
};

export function clientDto(row) {
  return { id: row.id, name: row.name, contact: row.contact, email: row.email, rate: Number(row.hourly_rate), color: row.color };
}
export function projectDto(row) {
  return { id: row.id, name: row.name, clientId: row.client_id, status: row.status, budget: Number(row.budget), due: row.due_date, hours: Number(row.hours || 0), color: row.color };
}
export function taskDto(row) {
  return { id: row.id, projectId: row.project_id, title: row.title, due: row.due_date, done: row.done };
}
export function entryDto(row) {
  return { id: row.id, projectId: row.project_id, note: row.note, date: row.work_date, hours: Number(row.hours), rate: Number(row.hourly_rate), invoiceId: row.invoice_id };
}
export function invoiceDto(row) {
  return { id: row.id, number: row.number, clientId: row.client_id, amount: Number(row.amount), currency: row.currency, date: row.issued_at, due: row.due_at, status: row.status, periodStart: row.period_start, periodEnd: row.period_end };
}

export const clientSelect = `SELECT id, name, contact, email, hourly_rate, color FROM clients`;
export const projectSelect = `SELECT p.id, p.name, p.client_id, p.status, p.budget, p.due_date, p.color, COALESCE(sum(t.hours), 0)::numeric AS hours
  FROM projects p LEFT JOIN time_entries t ON t.project_id=p.id AND t.user_id=p.user_id`;
