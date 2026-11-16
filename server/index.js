import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import PDFDocument from 'pdfkit';
import Razorpay from 'razorpay';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool, initializeDatabase, transaction } from './db.js';
import {
  HttpError, clientFields, projectFields, taskFields, entryFields,
  idParam, moneyNumber, clientDto, projectDto, taskDto, entryDto, invoiceDto,
  clientSelect, projectSelect,
} from './helpers.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters.');
const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
const razorpay = razorpayKeyId && razorpayKeySecret ? new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret }) : null;

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: { directives: {
    scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
    connectSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
    frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
    imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
    fontSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
    formAction: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
  } },
}));
app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173', credentials: true }));
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode}`));
    next();
  });
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const body = (schema, value) => schema.parse(value);
const isoDate = d => d instanceof Date ? d.toISOString().slice(0, 10) : d;
const userIdOf = req => req.userId;

function sessionToken(user) {
  return jwt.sign({ sub: user.id }, jwtSecret, { expiresIn: '7d', issuer: 'freelanceflow' });
}
function setSession(res, user) {
  res.cookie('ff_session', sessionToken(user), cookieOptions);
}
function clearSession(res) {
  res.clearCookie('ff_session', { ...cookieOptions, maxAge: undefined });
}
function requireAuth(req, res, next) {
  const token = req.cookies.ff_session || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return next(new HttpError(401, 'Sign in to continue.'));
  try {
    const payload = jwt.verify(token, jwtSecret, { issuer: 'freelanceflow' });
    req.userId = payload.sub;
    return next();
  } catch {
    clearSession(res);
    return next(new HttpError(401, 'Your session has expired. Sign in again.'));
  }
}
const auth = [requireAuth];

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'freelanceflow-api' });
}));

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200).transform(v => v.toLowerCase()),
  password: z.string().min(10).max(100),
});
const loginSchema = z.object({ email: z.string().trim().email().max(200).transform(v => v.toLowerCase()), password: z.string().min(1).max(100) });
app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const input = body(registerSchema, req.body);
  const hash = await bcrypt.hash(input.password, 12);
  let result;
  try {
    result = await pool.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,plan', [input.name, input.email, hash]);
  } catch (error) {
    if (error.code === '23505') throw new HttpError(409, 'An account with that email already exists.');
    throw error;
  }
  const user = result.rows[0];
  setSession(res, user);
  res.status(201).json({ user });
}));
app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const input = body(loginSchema, req.body);
  const result = await pool.query('SELECT id,name,email,plan,password_hash FROM users WHERE email=$1', [input.email]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(input.password, user.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
  setSession(res, user);
  const { password_hash: _passwordHash, ...safeUser } = user;
  res.json({ user: safeUser });
}));
app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.status(204).end(); });
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT id,name,email,plan FROM users WHERE id=$1', [userIdOf(req)]);
  if (!result.rowCount) throw new HttpError(401, 'Your account is no longer available.');
  res.json({ user: result.rows[0] });
}));

app.get('/api/billing/status', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT plan FROM users WHERE id=$1', [userIdOf(req)]);
  if (!result.rowCount) throw new HttpError(401, 'Your account is no longer available.');
  const account = result.rows[0];
  res.json({
    plan: account.plan,
    checkoutConfigured: Boolean(razorpay),
    invoicePaymentsConfigured: Boolean(razorpay),
    keyId: razorpay ? razorpayKeyId : null,
  });
}));

const paymentCallbackSchema = z.object({
  razorpay_order_id: z.string().min(1).max(100),
  razorpay_payment_id: z.string().min(1).max(100),
  razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i),
});
app.post('/api/invoices/:id/create-order', auth, asyncRoute(async (req, res) => {
  if (!razorpay) throw new HttpError(503, 'Razorpay checkout is not configured on the server.');
  const id = idParam(req.params.id);
  const result = await pool.query('SELECT id,number,amount,currency,status FROM invoices WHERE id=$1 AND user_id=$2', [id,userIdOf(req)]);
  if (!result.rowCount) throw new HttpError(404, 'Invoice not found.');
  const invoice = result.rows[0];
  if (invoice.status === 'Paid') throw new HttpError(409, 'This invoice is already paid.');
  const currency = invoice.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(422, 'Invoice currency is not valid for Razorpay.');
  const amount = Math.round(Number(invoice.amount) * 100);
  if (!Number.isSafeInteger(amount) || amount < 100) throw new HttpError(422, 'Razorpay requires a payment of at least 100 paise.');
  try {
    const order = await razorpay.orders.create({
      amount, currency, receipt: invoice.number,
      notes: { invoice_id: invoice.id, user_id: userIdOf(req) },
    });
    const linked = await pool.query(`UPDATE invoices SET razorpay_order_id=$1
      WHERE id=$2 AND user_id=$3 AND status<>'Paid' RETURNING id`, [order.id,id,userIdOf(req)]);
    if (!linked.rowCount) throw new HttpError(409, 'This invoice was already paid. Reload the invoice list.');
    res.status(201).json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: razorpayKeyId });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error('Razorpay order creation failed:', error?.statusCode || error?.error?.code || 'provider error');
    throw new HttpError(502, 'Razorpay could not create the payment order. Check that your account supports this invoice currency.');
  }
}));

app.post('/api/invoices/:id/verify-payment', auth, asyncRoute(async (req, res) => {
  if (!razorpay) throw new HttpError(503, 'Razorpay checkout is not configured on the server.');
  const id = idParam(req.params.id);
  const input = body(paymentCallbackSchema, req.body);
  const invoiceResult = await pool.query('SELECT id,amount,currency,status,razorpay_order_id,razorpay_payment_id FROM invoices WHERE id=$1 AND user_id=$2', [id,userIdOf(req)]);
  if (!invoiceResult.rowCount) throw new HttpError(404, 'Invoice not found.');
  const invoice = invoiceResult.rows[0];
  if (invoice.razorpay_order_id !== input.razorpay_order_id) throw new HttpError(400, 'Payment order does not match this invoice.');
  const expected = createHmac('sha256', razorpayKeySecret).update(`${input.razorpay_order_id}|${input.razorpay_payment_id}`).digest();
  const supplied = Buffer.from(input.razorpay_signature, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new HttpError(400, 'Payment signature is invalid.');
  if (invoice.status === 'Paid' && invoice.razorpay_payment_id === input.razorpay_payment_id) {
    return res.json({ verified: true, status: 'Paid', invoiceId: id });
  }
  let payment;
  try { payment = await razorpay.payments.fetch(input.razorpay_payment_id); }
  catch { throw new HttpError(502, 'Could not confirm payment status with Razorpay.'); }
  if (payment.order_id !== input.razorpay_order_id) throw new HttpError(400, 'Payment is not attached to this order.');
  if (payment.status !== 'captured') throw new HttpError(409, 'Payment has not been captured yet. The invoice remains unpaid.');
  if (payment.currency !== invoice.currency.trim().toUpperCase() || Number(payment.amount) !== Math.round(Number(invoice.amount) * 100)) {
    throw new HttpError(400, 'The captured payment amount does not match this invoice.');
  }
  const updated = await pool.query(`UPDATE invoices SET status='Paid',razorpay_payment_id=$1
    WHERE id=$2 AND user_id=$3 AND razorpay_order_id=$4 AND status<>'Paid'
    RETURNING id`, [payment.id,id,userIdOf(req),input.razorpay_order_id]);
  if (!updated.rowCount) throw new HttpError(409, 'Invoice payment state changed; reload and check the invoice.');
  res.json({ verified: true, status: 'Paid', invoiceId: id });
}));

app.get('/api/data', auth, asyncRoute(async (req, res) => {
  const uid = userIdOf(req);
  const [clients, projects, tasks, entries, invoices, timer] = await Promise.all([
    pool.query(`${clientSelect} WHERE user_id=$1 ORDER BY created_at`, [uid]),
    pool.query(`${projectSelect} WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC`, [uid]),
    pool.query('SELECT id,project_id,title,due_date,done FROM tasks WHERE user_id=$1 ORDER BY done,due_date NULLS LAST,created_at DESC', [uid]),
    pool.query('SELECT id,project_id,note,work_date,hours,hourly_rate,invoice_id FROM time_entries WHERE user_id=$1 ORDER BY work_date DESC,created_at DESC LIMIT 500', [uid]),
    pool.query(`SELECT id,number,client_id,amount,currency,issued_at,due_at,
      CASE WHEN status <> 'Paid' AND due_at < CURRENT_DATE THEN 'Overdue' ELSE status END AS status,
      period_start,period_end FROM invoices WHERE user_id=$1 ORDER BY issued_at DESC,created_at DESC`, [uid]),
    pool.query('SELECT user_id,project_id,note,hourly_rate,started_at FROM active_timers WHERE user_id=$1', [uid]),
  ]);
  res.json({
    clients: clients.rows.map(clientDto), projects: projects.rows.map(projectDto), tasks: tasks.rows.map(taskDto),
    entries: entries.rows.map(entryDto), invoices: invoices.rows.map(invoiceDto),
    timer: timer.rows[0] ? { projectId: timer.rows[0].project_id, note: timer.rows[0].note, startedAt: new Date(timer.rows[0].started_at).getTime() } : null,
  });
}));

app.get('/api/clients', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`${clientSelect} WHERE user_id=$1 ORDER BY name`, [userIdOf(req)]);
  res.json(result.rows.map(clientDto));
}));
app.post('/api/clients', auth, asyncRoute(async (req, res) => {
  const input = body(z.object(clientFields), req.body);
  const uid = userIdOf(req);
  const result = await transaction(async client => {
    const account = await client.query('SELECT plan FROM users WHERE id=$1 FOR UPDATE', [uid]);
    if (!account.rowCount) throw new HttpError(401, 'Account not found.');
    const count = await client.query('SELECT count(*)::int AS count FROM clients WHERE user_id=$1', [uid]);
    if (account.rows[0].plan === 'free' && count.rows[0].count >= 2) throw new HttpError(403, 'The Free plan includes up to two clients.');
    return client.query(`INSERT INTO clients(user_id,name,contact,email,hourly_rate) VALUES($1,$2,$3,$4,$5) RETURNING id,name,contact,email,hourly_rate,color`, [uid,input.name,input.contact,input.email,input.hourlyRate]);
  });
  res.status(201).json(clientDto(result.rows[0]));
}));
app.put('/api/clients/:id', auth, asyncRoute(async (req, res) => {
  const id = idParam(req.params.id); const input = body(z.object(clientFields), req.body);
  const result = await pool.query(`UPDATE clients SET name=$3,contact=$4,email=$5,hourly_rate=$6,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING id,name,contact,email,hourly_rate,color`, [userIdOf(req),id,input.name,input.contact,input.email,input.hourlyRate]);
  if (!result.rowCount) throw new HttpError(404, 'Client not found.');
  res.json(clientDto(result.rows[0]));
}));
app.delete('/api/clients/:id', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`DELETE FROM clients c WHERE c.user_id=$1 AND c.id=$2
    AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.user_id=c.user_id AND p.client_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.user_id=c.user_id AND i.client_id=c.id) RETURNING c.id`, [userIdOf(req),idParam(req.params.id)]);
  if (!result.rowCount) throw new HttpError(409, 'Client not found or still linked to projects or invoices.');
  res.status(204).end();
}));

app.get('/api/projects', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`${projectSelect} WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC`, [userIdOf(req)]);
  res.json(result.rows.map(projectDto));
}));
app.post('/api/projects', auth, asyncRoute(async (req, res) => {
  const input = body(z.object(projectFields), req.body); const uid = userIdOf(req);
  const result = await pool.query(`INSERT INTO projects(user_id,client_id,name,status,budget,due_date)
    SELECT $1,c.id,$3,$4,$5,$6 FROM clients c WHERE c.user_id=$1 AND c.id=$2
    RETURNING id,name,client_id,status,budget,due_date,color`, [uid,input.clientId,input.name,input.status,input.budget,input.dueDate]);
  if (!result.rowCount) throw new HttpError(404, 'Client not found.');
  res.status(201).json(projectDto({ ...result.rows[0], hours: 0 }));
}));
app.put('/api/projects/:id', auth, asyncRoute(async (req, res) => {
  const id = idParam(req.params.id); const input = body(z.object(projectFields), req.body); const uid = userIdOf(req);
  const result = await pool.query(`UPDATE projects p SET client_id=$3,name=$4,status=$5,budget=$6,due_date=$7,updated_at=now()
    FROM clients c WHERE p.user_id=$1 AND p.id=$2 AND c.user_id=$1 AND c.id=$3
    RETURNING p.id,p.name,p.client_id,p.status,p.budget,p.due_date,p.color`, [uid,id,input.clientId,input.name,input.status,input.budget,input.dueDate]);
  if (!result.rowCount) throw new HttpError(404, 'Project or client not found.');
  res.json(projectDto({ ...result.rows[0], hours: 0 }));
}));
app.delete('/api/projects/:id', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`DELETE FROM projects p WHERE p.user_id=$1 AND p.id=$2
    AND NOT EXISTS(SELECT 1 FROM time_entries t WHERE t.user_id=p.user_id AND t.project_id=p.id)
    RETURNING p.id`, [userIdOf(req),idParam(req.params.id)]);
  if (!result.rowCount) throw new HttpError(409, 'Project not found or already has time entries.');
  res.status(204).end();
}));

app.get('/api/tasks', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT id,project_id,title,due_date,done FROM tasks WHERE user_id=$1 ORDER BY done,due_date NULLS LAST,created_at DESC', [userIdOf(req)]);
  res.json(result.rows.map(taskDto));
}));
app.post('/api/tasks', auth, asyncRoute(async (req, res) => {
  const input = body(z.object(taskFields), req.body); const uid = userIdOf(req);
  const result = await pool.query(`INSERT INTO tasks(user_id,project_id,title,due_date,done)
    SELECT $1,p.id,$3,$4,$5 FROM projects p WHERE p.user_id=$1 AND p.id=$2
    RETURNING id,project_id,title,due_date,done`, [uid,input.projectId,input.title,input.dueDate,input.done]);
  if (!result.rowCount) throw new HttpError(404, 'Project not found.');
  res.status(201).json(taskDto(result.rows[0]));
}));
app.put('/api/tasks/:id', auth, asyncRoute(async (req, res) => {
  const id = idParam(req.params.id); const input = body(z.object(taskFields), req.body);
  const result = await pool.query(`UPDATE tasks t SET project_id=$3,title=$4,due_date=$5,done=$6,updated_at=now()
    FROM projects p WHERE t.user_id=$1 AND t.id=$2 AND p.user_id=$1 AND p.id=$3
    RETURNING t.id,t.project_id,t.title,t.due_date,t.done`, [userIdOf(req),id,input.projectId,input.title,input.dueDate,input.done]);
  if (!result.rowCount) throw new HttpError(404, 'Task or project not found.');
  res.json(taskDto(result.rows[0]));
}));
app.delete('/api/tasks/:id', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM tasks WHERE user_id=$1 AND id=$2 RETURNING id', [userIdOf(req),idParam(req.params.id)]);
  if (!result.rowCount) throw new HttpError(404, 'Task not found.');
  res.status(204).end();
}));

app.get('/api/time-entries', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT id,project_id,note,work_date,hours,hourly_rate,invoice_id FROM time_entries WHERE user_id=$1 ORDER BY work_date DESC,created_at DESC LIMIT 500', [userIdOf(req)]);
  res.json(result.rows.map(entryDto));
}));
app.post('/api/time-entries', auth, asyncRoute(async (req, res) => {
  const input = body(z.object(entryFields), req.body); const uid = userIdOf(req);
  const result = await pool.query(`INSERT INTO time_entries(user_id,project_id,note,work_date,hours,hourly_rate)
    SELECT $1,p.id,$3,$4,$5,c.hourly_rate FROM projects p JOIN clients c ON c.user_id=p.user_id AND c.id=p.client_id
    WHERE p.user_id=$1 AND p.id=$2 RETURNING id,project_id,note,work_date,hours,hourly_rate,invoice_id`, [uid,input.projectId,input.note || 'Tracked work',input.date,input.hours]);
  if (!result.rowCount) throw new HttpError(404, 'Project not found.');
  res.status(201).json(entryDto(result.rows[0]));
}));
app.put('/api/time-entries/:id', auth, asyncRoute(async (req, res) => {
  const id = idParam(req.params.id); const input = body(z.object(entryFields), req.body); const uid = userIdOf(req);
  const result = await pool.query(`UPDATE time_entries t SET project_id=$3,note=$4,work_date=$5,hours=$6,hourly_rate=c.hourly_rate
    FROM projects p JOIN clients c ON c.user_id=p.user_id AND c.id=p.client_id
    WHERE t.user_id=$1 AND t.id=$2 AND t.invoice_id IS NULL AND p.user_id=$1 AND p.id=$3
    RETURNING t.id,t.project_id,t.note,t.work_date,t.hours,t.hourly_rate,t.invoice_id`, [uid,id,input.projectId,input.note,input.date,input.hours]);
  if (!result.rowCount) throw new HttpError(409, 'Time entry not found, billed, or linked to an unavailable project.');
  res.json(entryDto(result.rows[0]));
}));
app.delete('/api/time-entries/:id', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM time_entries WHERE user_id=$1 AND id=$2 AND invoice_id IS NULL RETURNING id', [userIdOf(req),idParam(req.params.id)]);
  if (!result.rowCount) throw new HttpError(409, 'Time entry not found or already billed.');
  res.status(204).end();
}));

app.get('/api/timer', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT project_id,note,started_at FROM active_timers WHERE user_id=$1', [userIdOf(req)]);
  const timer = result.rows[0];
  res.json({ timer: timer ? { projectId: timer.project_id, note: timer.note, startedAt: new Date(timer.started_at).getTime() } : null });
}));
app.post('/api/timer', auth, asyncRoute(async (req, res) => {
  const input = body(z.object({ projectId: z.string().uuid(), note: z.string().trim().max(500).optional().default('Focused work') }), req.body);
  const uid = userIdOf(req);
  const result = await pool.query(`INSERT INTO active_timers(user_id,project_id,note,hourly_rate)
    SELECT $1,p.id,$3,c.hourly_rate FROM projects p JOIN clients c ON c.user_id=p.user_id AND c.id=p.client_id
    WHERE p.user_id=$1 AND p.id=$2 ON CONFLICT(user_id) DO NOTHING
    RETURNING user_id,project_id,note,hourly_rate,started_at`, [uid,input.projectId,input.note || 'Focused work']);
  if (!result.rowCount) throw new HttpError(409, 'A timer is already running or the project is unavailable.');
  res.status(201).json({ timer: { projectId: result.rows[0].project_id, note: result.rows[0].note, startedAt: new Date(result.rows[0].started_at).getTime() } });
}));
app.post('/api/timer/stop', auth, asyncRoute(async (req, res) => {
  const entry = await transaction(async client => {
    const result = await client.query(`DELETE FROM active_timers WHERE user_id=$1
      RETURNING project_id,note,hourly_rate,started_at`, [userIdOf(req)]);
    if (!result.rowCount) throw new HttpError(404, 'No timer is running.');
    const timer = result.rows[0];
    const hours = Math.max(0.01, Math.round((Date.now() - new Date(timer.started_at).getTime()) / 36000) / 100);
    const saved = await client.query(`INSERT INTO time_entries(user_id,project_id,note,work_date,hours,hourly_rate)
      VALUES($1,$2,$3,CURRENT_DATE,$4,$5) RETURNING id,project_id,note,work_date,hours,hourly_rate,invoice_id`,
      [userIdOf(req),timer.project_id,timer.note || 'Tracked work',hours,timer.hourly_rate]);
    return entryDto(saved.rows[0]);
  });
  res.json({ entry });
}));

const invoiceCreateSchema = z.object({
  clientId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
app.get('/api/invoices', auth, asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT id,number,client_id,amount,currency,issued_at,due_at,
      CASE WHEN status <> 'Paid' AND due_at < CURRENT_DATE THEN 'Overdue' ELSE status END AS status,
      period_start,period_end FROM invoices WHERE user_id=$1 ORDER BY issued_at DESC,created_at DESC`, [userIdOf(req)]);
  res.json(result.rows.map(invoiceDto));
}));
app.post('/api/invoices', auth, asyncRoute(async (req, res) => {
  const input = body(invoiceCreateSchema, req.body);
  if (input.endDate < input.startDate) throw new HttpError(400, 'The invoice end date must be on or after the start date.');
  const invoice = await transaction(async client => {
    const uid = userIdOf(req);
    const rows = await client.query(`SELECT t.id,t.hours,t.hourly_rate FROM time_entries t
      JOIN projects p ON p.user_id=t.user_id AND p.id=t.project_id
      WHERE t.user_id=$1 AND p.client_id=$2 AND t.invoice_id IS NULL AND t.work_date BETWEEN $3 AND $4
      FOR UPDATE OF t`, [uid,input.clientId,input.startDate,input.endDate]);
    if (!rows.rowCount) throw new HttpError(422, 'No unbilled time entries were found for that client and date range.');
    const amount = moneyNumber(rows.rows.reduce((sum, row) => sum + Number(row.hours) * Number(row.hourly_rate), 0));
    const counter = await client.query('SELECT invoice_sequence FROM users WHERE id=$1 FOR UPDATE', [uid]);
    if (!counter.rowCount) throw new HttpError(401, 'Account not found.');
    const serial = counter.rows[0].invoice_sequence;
    await client.query('UPDATE users SET invoice_sequence=invoice_sequence+1 WHERE id=$1', [uid]);
    const number = `FF-${new Date().getUTCFullYear()}-${String(serial).padStart(4, '0')}`;
    const created = await client.query(`INSERT INTO invoices(user_id,client_id,number,amount,due_at,period_start,period_end)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      RETURNING id,number,client_id,amount,currency,issued_at,due_at,status,period_start,period_end`,
      [uid,input.clientId,number,amount,input.dueDate,input.startDate,input.endDate]);
    await client.query('UPDATE time_entries SET invoice_id=$3 WHERE user_id=$1 AND id=ANY($2::uuid[])', [uid,rows.rows.map(row => row.id),created.rows[0].id]);
    return { ...invoiceDto(created.rows[0]), entryCount: rows.rowCount };
  });
  res.status(201).json(invoice);
}));
app.get('/api/invoices/:id/pdf', auth, asyncRoute(async (req, res) => {
  const account = await pool.query('SELECT plan FROM users WHERE id=$1', [userIdOf(req)]);
  if (!account.rowCount) throw new HttpError(401, 'Your account is no longer available.');
  if (account.rows[0].plan !== 'pro') throw new HttpError(403, 'PDF downloads are included with the Pro plan.');
  const result = await pool.query(`SELECT i.id,i.number,i.amount,i.currency,i.issued_at,i.due_at,i.status,c.name AS client_name
    FROM invoices i JOIN clients c ON c.user_id=i.user_id AND c.id=i.client_id WHERE i.user_id=$1 AND i.id=$2`, [userIdOf(req),idParam(req.params.id)]);
  if (!result.rowCount) throw new HttpError(404, 'Invoice not found.');
  const invoice = result.rows[0];
  const safeName = invoice.number.replace(/[^a-zA-Z0-9_-]/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${safeName}.pdf"`);
  const pdf = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Invoice ${invoice.number}`, Author: 'FreelanceFlow' } });
  pdf.pipe(res);
  const left = 54, right = 558;
  pdf.fillColor('#526f53').font('Helvetica-Bold').fontSize(10).text('FREELANCEFLOW', left, 50);
  pdf.fillColor('#828880').font('Helvetica').fontSize(9).text('Independent work, in order', left, 67);
  pdf.fillColor('#2a2e29').font('Helvetica-Bold').fontSize(29).text('INVOICE', left, 122);
  pdf.fillColor('#676e65').font('Helvetica').fontSize(10).text(invoice.number, left, 157);
  pdf.fillColor('#526f53').font('Helvetica-Bold').fontSize(9).text(invoice.status.toUpperCase(), left, 157, { align: 'right', width: right-left });
  pdf.strokeColor('#e1e5df').moveTo(left, 181).lineTo(right, 181).stroke();
  pdf.fillColor('#8c9289').font('Helvetica-Bold').fontSize(8).text('BILL TO', left, 207);
  pdf.text('ISSUED', 345, 207);
  pdf.text('DUE DATE', 490, 207, { align: 'right', width: 68 });
  pdf.fillColor('#2a2e29').fontSize(11).text(invoice.client_name, left, 227);
  pdf.fillColor('#4b5149').font('Helvetica').fontSize(10).text(isoDate(invoice.issued_at), 345, 227);
  pdf.text(isoDate(invoice.due_at), 490, 227, { align: 'right', width: 68 });
  pdf.rect(left, 270, right-left, 32).fill('#f6f7f4');
  pdf.fillColor('#767c74').font('Helvetica-Bold').fontSize(8).text('DESCRIPTION', left+12, 283);
  pdf.text('AMOUNT', right-100, 283, { align: 'right', width: 88 });
  pdf.fillColor('#353a34').font('Helvetica').fontSize(10).text('Professional services', left+12, 323);
  pdf.text(`${invoice.currency} ${Number(invoice.amount).toFixed(2)}`, right-150, 323, { align: 'right', width: 138 });
  pdf.strokeColor('#e1e5df').moveTo(left, 349).lineTo(right, 349).stroke();
  pdf.fillColor('#676e65').fontSize(10).text('Subtotal', right-180, 375);
  pdf.text(`${invoice.currency} ${Number(invoice.amount).toFixed(2)}`, right-120, 375, { align: 'right', width: 120 });
  pdf.fillColor('#2a2e29').font('Helvetica-Bold').fontSize(12).text('Total due', right-180, 410);
  pdf.fillColor('#526f53').text(`${invoice.currency} ${Number(invoice.amount).toFixed(2)}`, right-120, 410, { align: 'right', width: 120 });
  pdf.strokeColor('#e1e5df').moveTo(left, 731).lineTo(right, 731).stroke();
  pdf.fillColor('#828880').font('Helvetica').fontSize(9).text('Thank you for your business.', left, 746);
  pdf.text('FreelanceFlow', right-100, 746, { align: 'right', width: 100 });
  pdf.end();
}));

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const uid = userIdOf(req);
  const [counts, invoices, hours, projects, tasks, recent] = await Promise.all([
    pool.query(`SELECT (SELECT count(*)::int FROM projects WHERE user_id=$1 AND status='In progress') AS active_projects,
      (SELECT count(*)::int FROM clients WHERE user_id=$1) AS client_count`, [uid]),
    pool.query(`SELECT COALESCE(sum(amount) FILTER(WHERE status<>'Paid'),0)::numeric AS outstanding,
      count(*) FILTER(WHERE status<>'Paid')::int AS pending_count,
      count(*) FILTER(WHERE status<>'Paid' AND due_at<CURRENT_DATE)::int AS overdue_count,
      COALESCE(sum(amount) FILTER(WHERE status='Paid' AND issued_at>=date_trunc('month',CURRENT_DATE)),0)::numeric AS revenue_month
      FROM invoices WHERE user_id=$1`, [uid]),
    pool.query(`SELECT COALESCE(sum(hours),0)::numeric AS hours_week FROM time_entries WHERE user_id=$1
      AND work_date>=date_trunc('week',CURRENT_DATE)::date`, [uid]),
    pool.query(`${projectSelect} WHERE p.user_id=$1 AND p.status='In progress' GROUP BY p.id ORDER BY p.due_date NULLS LAST LIMIT 5`, [uid]),
    pool.query('SELECT id,project_id,title,due_date,done FROM tasks WHERE user_id=$1 AND done=false ORDER BY due_date NULLS LAST LIMIT 5', [uid]),
    pool.query(`SELECT id,number,client_id,amount,currency,issued_at,due_at,
      CASE WHEN status<>'Paid' AND due_at<CURRENT_DATE THEN 'Overdue' ELSE status END AS status,
      period_start,period_end FROM invoices WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 3`, [uid]),
  ]);
  const count = counts.rows[0], bill = invoices.rows[0];
  res.json({
    stats: { activeProjects: count.active_projects, clientCount: count.client_count, hoursWeek: Number(hours.rows[0].hours_week), outstanding: Number(bill.outstanding), pendingCount: bill.pending_count, overdueCount: bill.overdue_count, revenueMonth: Number(bill.revenue_month) },
    projects: projects.rows.map(projectDto), tasks: tasks.rows.map(taskDto), invoices: recent.rows.map(invoiceDto),
  });
}));
app.get('/api/reports', auth, asyncRoute(async (req, res) => {
  const uid = userIdOf(req);
  const [summary, byMonth, budgets] = await Promise.all([
    pool.query(`SELECT COALESCE(sum(amount) FILTER(WHERE status='Paid' AND issued_at>=date_trunc('month',CURRENT_DATE)),0)::numeric AS revenue_month,
      COALESCE(sum(amount) FILTER(WHERE status<>'Paid'),0)::numeric AS outstanding,
      COALESCE((SELECT sum(hours) FROM time_entries WHERE user_id=$1 AND work_date>=date_trunc('month',CURRENT_DATE)::date),0)::numeric AS hours_month
      FROM invoices WHERE user_id=$1`, [uid]),
    pool.query(`SELECT to_char(date_trunc('month',issued_at),'Mon') AS month,
      COALESCE(sum(amount) FILTER(WHERE status='Paid'),0)::numeric AS revenue
      FROM invoices WHERE user_id=$1 AND issued_at>=date_trunc('month',CURRENT_DATE)-interval '5 months'
      GROUP BY date_trunc('month',issued_at) ORDER BY date_trunc('month',issued_at)`, [uid]),
    pool.query(`${projectSelect} WHERE p.user_id=$1 AND p.status='In progress' GROUP BY p.id ORDER BY p.due_date NULLS LAST`, [uid]),
  ]);
  res.json({ summary: { revenueMonth: Number(summary.rows[0].revenue_month), outstanding: Number(summary.rows[0].outstanding), hoursMonth: Number(summary.rows[0].hours_month) }, months: byMonth.rows.map(r=>({ month:r.month, revenue:Number(r.revenue) })), budgets: budgets.rows.map(projectDto) });
}));

app.post('/api/sample-data', auth, asyncRoute(async (req, res) => {
  const uid = userIdOf(req);
  const result = await transaction(async client => {
    const existing = await client.query('SELECT count(*)::int AS n FROM clients WHERE user_id=$1', [uid]);
    if (existing.rows[0].n) throw new HttpError(409, 'Sample data can be loaded only into an empty workspace.');
    const [north, field] = (await client.query(`INSERT INTO clients(user_id,name,contact,email,hourly_rate,color) VALUES
      ($1,'Northstar Studio','Maya Chen','maya@northstar.example',120,'#aab7a0'),
      ($1,'Fieldwork Coffee','Jon Bell','jon@fieldwork.example',95,'#d5a982') RETURNING id,name`, [uid])).rows;
    const [brand, store, landing] = (await client.query(`INSERT INTO projects(user_id,client_id,name,status,budget,due_date,color) VALUES
      ($1,$2,'Brand & digital refresh','In progress',12000,CURRENT_DATE+8,'#aab7a0'),
      ($1,$3,'E-commerce storefront','In progress',8500,CURRENT_DATE+3,'#d5a982'),
      ($1,$2,'Campaign landing page','Completed',4200,CURRENT_DATE-12,'#aab7a0') RETURNING id,name`, [uid,north.id,field.id])).rows;
    await client.query(`INSERT INTO tasks(user_id,project_id,title,due_date,done) VALUES
      ($1,$2,'Present identity concepts',CURRENT_DATE+4,false),($1,$3,'Send product photography',CURRENT_DATE+2,false),($1,$2,'Explore type directions',CURRENT_DATE-1,true)`, [uid,brand.id,store.id]);
    const issued = new Date();
    const due1 = new Date(issued); due1.setDate(due1.getDate()+14);
    const due2 = new Date(issued); due2.setDate(due2.getDate()-5);
    const [paid, open, overdue] = (await client.query(`INSERT INTO invoices(user_id,client_id,number,amount,issued_at,due_at,status) VALUES
      ($1,$2,'FF-${issued.getUTCFullYear()}-0001',5280,CURRENT_DATE-32,CURRENT_DATE-18,'Paid'),
      ($1,$2,'FF-${issued.getUTCFullYear()}-0002',3840,CURRENT_DATE-4,$4,'Awaiting payment'),
      ($1,$3,'FF-${issued.getUTCFullYear()}-0003',2470,CURRENT_DATE-20,$5,'Awaiting payment') RETURNING id,number`, [uid,north.id,field.id,due1.toISOString().slice(0,10),due2.toISOString().slice(0,10)])).rows;
    const entries = await client.query(`INSERT INTO time_entries(user_id,project_id,note,work_date,hours,hourly_rate,invoice_id) VALUES
      ($1,$2,'Identity exploration',CURRENT_DATE-32,20,120,$3),($1,$2,'Visual direction',CURRENT_DATE-31,24,120,$3),
      ($1,$2,'Campaign design',CURRENT_DATE-3,20,120,$6),($1,$2,'Landing page build',CURRENT_DATE-2,12,120,$6),
      ($1,$4,'Storefront design',CURRENT_DATE-20,20,95,$5),($1,$4,'Responsive implementation',CURRENT_DATE-19,6,95,$5),
      ($1,$2,'Current identity notes',CURRENT_DATE,3.25,120,NULL),($1,$4,'Current responsive states',CURRENT_DATE,1.75,95,NULL) RETURNING id`, [uid,brand.id,paid.id,store.id,overdue.id,open.id]);
    await client.query('UPDATE users SET invoice_sequence=4 WHERE id=$1', [uid]);
    return { sample: true, clients: 2, projects: 3, tasks: 3, entries: entries.rowCount };
  });
  res.status(201).json(result);
}));

const frontendDir = fileURLToPath(new URL('../dist/', import.meta.url));
const frontendIndex = fileURLToPath(new URL('../dist/index.html', import.meta.url));
if (existsSync(frontendIndex)) {
  app.use(express.static(frontendDir));
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/')) {
      return res.sendFile(frontendIndex, error => { if (error) next(error); });
    }
    next();
  });
}

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue=>issue.message).join(' ') });
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error.code === '23505') return res.status(409).json({ error: 'That record already exists.' });
  if (error.code === '23503') return res.status(409).json({ error: 'This record is still linked to other data.' });
  console.error(error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

await initializeDatabase();
app.listen(port, '0.0.0.0', () => console.log(`FreelanceFlow API listening on port ${port}`));
