CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  invoice_sequence INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'demo';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_billing_mode_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_billing_mode_check CHECK (billing_mode IN ('demo', 'test', 'live'));
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_subscription_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_subscription_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_subscription_mode TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_event_created BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_cancel_at_cycle_end BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS users_razorpay_subscription_idx ON users(razorpay_subscription_id) WHERE razorpay_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS razorpay_plans (
  mode TEXT PRIMARY KEY CHECK (mode IN ('test', 'live')),
  plan_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mode, event_id)
);

-- Razorpay Standard Checkout records its order on the invoice and only marks
-- the invoice paid after a verified signature and captured payment lookup.

CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  hourly_rate NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK (hourly_rate >= 0),
  color TEXT NOT NULL DEFAULT '#b9c6b0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS clients_user_name_idx ON clients(user_id, lower(name));

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'In progress' CHECK (status IN ('In progress', 'Completed', 'On hold')),
  budget NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  due_date DATE,
  color TEXT NOT NULL DEFAULT '#aab7a0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id, status, due_date);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  number TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  issued_at DATE NOT NULL DEFAULT CURRENT_DATE,
  due_at DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'Awaiting payment' CHECK (status IN ('Awaiting payment', 'Overdue', 'Paid')),
  period_start DATE,
  period_end DATE,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, number),
  FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id) ON DELETE RESTRICT
);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS razorpay_order_mode TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
CREATE INDEX IF NOT EXISTS invoices_user_status_idx ON invoices(user_id, status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_razorpay_order_idx ON invoices(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_razorpay_payment_idx ON invoices(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  title TEXT NOT NULL,
  due_date DATE,
  done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks(user_id, done, due_date);

CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  note TEXT NOT NULL DEFAULT 'Tracked work',
  work_date DATE NOT NULL DEFAULT CURRENT_DATE,
  hours NUMERIC(8,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  hourly_rate NUMERIC(12,2) NOT NULL CHECK (hourly_rate >= 0),
  invoice_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, invoice_id) REFERENCES invoices(user_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS time_entries_user_date_idx ON time_entries(user_id, work_date DESC);
CREATE INDEX IF NOT EXISTS time_entries_unbilled_idx ON time_entries(user_id, project_id, work_date) WHERE invoice_id IS NULL;

CREATE TABLE IF NOT EXISTS active_timers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  note TEXT NOT NULL DEFAULT 'Focused work',
  hourly_rate NUMERIC(12,2) NOT NULL DEFAULT 100 CHECK (hourly_rate >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE RESTRICT
);
