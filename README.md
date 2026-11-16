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

## Configure Pro billing

Pro checkout is powered by Stripe Checkout. Create a recurring Stripe Price for the Pro plan, then add these values as Render environment variables (never commit secret values):

- `STRIPE_SECRET_KEY`: a Stripe test key while developing, or a live key after launch review.
- `STRIPE_PRO_PRICE_ID`: the recurring Price ID created in Stripe.
- `STRIPE_WEBHOOK_SECRET`: the signing secret for a Stripe webhook endpoint at `https://<your-app>.onrender.com/api/stripe/webhook`.
- `PUBLIC_APP_URL`: the app's canonical `https://<your-app>.onrender.com` URL.

Subscribe the webhook to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`. The server verifies the webhook signature and makes plan changes from these events; a checkout redirect by itself never grants Pro access. Configure the Stripe customer portal before enabling subscription management. Until the required settings exist, the UI explains that billing is unavailable and disables checkout. Free accounts can create up to two clients; PDF downloads require an active Pro subscription.

## Current product scope

- Account registration, login, logout, and user-scoped data.
- Client, project, task, and time-entry API operations, plus persistent timers.
- Server-calculated invoices from unbilled time and server-generated PDF documents.
- Dashboard and report metrics, with a sample-data loader for empty accounts.
- Free plan enforcement for a maximum of two clients; PDF downloads require Pro.
- Stripe-hosted Pro subscriptions, verified webhook fulfillment, and customer portal support once Stripe is configured.
