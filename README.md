# FreelanceFlow

FreelanceFlow is a freelancer workspace for client and project CRM, task tracking, time logs, invoices, and revenue reporting. The React UI calls an Express API; PostgreSQL stores account-scoped data. Passwords are hashed, sessions use an HTTP-only cookie, and API queries scope records to the signed-in account.

## Local development

Requirements: Node.js 22+ and Docker Desktop (or a PostgreSQL 15+ server).

1. Install packages with `npm install`.
2. Copy `server/.env.example` to `server/.env`. Set `DATABASE_URL` to your PostgreSQL connection string and replace `JWT_SECRET` with a random secret of at least 32 characters.
3. For the included local database, run `docker compose up -d db`.
4. Run `npm run build` to produce the frontend in `dist`.
5. Run `npm start` and open `http://localhost:3001`. Express serves the frontend and `/api` on the same origin.

For frontend hot reload, use `npm run dev` in a second terminal. Vite proxies `/api` to port 3001. The API initializes `server/schema.sql` on startup.

## Deploy to Render with Neon

The included `render.yaml` defines a free Singapore web service and health check. Render's free web services can sleep after inactivity, so the first request after idle may take longer. The app build is served by Express on the same origin as the API.

1. Push this repository to a Git provider and create a Render Blueprint from it.
2. Set `DATABASE_URL` on the Render service to the Neon pooled connection URI. Keep it in Render's environment settings, not in the repository.
3. Render generates `JWT_SECRET`. Keep the Render compute plan on Free unless you intentionally choose paid hosting.
4. Deploy and check `/api/health` on the generated `onrender.com` URL.

## Razorpay invoice checkout

The app uses Razorpay Standard Checkout for one-time invoice payments. Configure `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `server/.env` locally or in the Render service environment. Never put the key secret in a Vite variable or commit it. Use Razorpay test keys for testing and switch to live keys only after account onboarding and payment flows are approved.

When a user pays an invoice, the server creates the order from the stored invoice amount, then verifies Razorpay's HMAC signature and fetches the payment status before marking the invoice paid. Invoice amounts are stored in paise at Razorpay and the invoice currency must be enabled for the merchant account. A successful browser callback alone does not mark an invoice paid. Manual “Mark paid” is available for payments received outside the app. Pro subscription billing is not the same as one-time invoice checkout and remains separate.

For local testing, set the two Razorpay test credentials in `server/.env`, start the API and web app, sign in, and open an unpaid invoice to use “Pay online”. Razorpay provides test-mode payment methods and results. In Render, add both values to the service environment and redeploy. Existing invoices keep their currency; the merchant account must support that currency. New invoices continue to use the app's existing USD default.

## Current product scope

- Account registration, login, logout, and user-scoped data.
- Client, project, task, and time-entry API operations, plus persistent timers.
- Server-calculated invoices from unbilled time and server-generated PDF documents.
- Dashboard and report metrics, with a sample-data loader for empty accounts.
- Razorpay Standard Checkout for invoice payments with server-side signature and captured-payment verification.
- Free plan enforcement for up to two clients; Pro subscription management is not currently connected.
