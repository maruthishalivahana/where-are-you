<!-- Payment gateway integration documentation -->
# Payment Gateway Integration (Razorpay)

This document describes the backend and frontend integration implemented in this project for Razorpay payments, webhooks, verification, and admin flows. It also covers testing with ngrok, security considerations, and the new "buy more buses" and payment history features.

## Overview
- Payment provider: Razorpay (supports Test & Live modes).
- Backend responsibilities:
  - Create Razorpay orders using server-side API keys.
  - Store payment records in `Payment` collection.
  - Verify checkout signatures from the frontend.
  - Verify webhook signatures from Razorpay and handle captured/failed events.
  - Activate paid plans after verified payments and keep payment history and stacked active plans.
- Frontend responsibilities:
  - Request an order from backend.
  - Open Razorpay Checkout using returned `keyId` and `order.orderId`.
  - On success, post the returned `razorpay_payment_id`, `razorpay_order_id`, and `razorpay_signature` to backend verify endpoint.
  - Handle cancel/failure states and poll status endpoint when needed.

## Environment variables
- `RAZORPAY_KEY_ID` — Razorpay API key id (test/live). Backend and frontend need the Key ID; secret must stay backend-only.
- `RAZORPAY_KEY_SECRET` — Razorpay API key secret (backend only).
- `RAZORPAY_WEBHOOK_SECRET` — secret string used to validate webhook payload signatures (backend only).

Add these to `.env` in the backend. Do NOT put `RAZORPAY_KEY_SECRET` or `RAZORPAY_WEBHOOK_SECRET` into frontend code.

## Backend: Key components and files
- `src/modules/payment/payment.model.ts` — Mongoose model for `Payment` records. Fields: organizationId, planCode, busCount, amount, currency, status, provider, orderId, paymentId, signature, receipt, notes, timestamps, paidAt.
- `src/modules/payment/payment.service.ts` — Logic to:
  - Create a Razorpay order (server->Razorpay POST /v1/orders).
  - Save a `Payment` document with status `created`.
  - Verify checkout signature (HMAC sha256 of `${orderId}|${paymentId}` with key secret).
  - Mark payments paid/failed and mirror into organization plan history.
  - Verify webhook signature (HMAC sha256 on raw body with `RAZORPAY_WEBHOOK_SECRET`).
- `src/modules/payment/payment.controller.ts` — Express handlers:
  - `POST /api/admin/plans/razorpay/order` — create order; requires admin auth.
  - `POST /api/admin/plans/razorpay/verify` — verify checkout signature and activate paid plan.
  - `GET /api/admin/plans/razorpay/status?orderId=...` — poll payment status.
  - `POST /api/webhooks/razorpay` — webhook endpoint; validates signature and marks payments accordingly.

## Plan & Subscription model changes
- `src/modules/plan/organizationPlan.model.ts` now stores:
  - `activePlans` array — each purchase is an independent record with startsAt/endsAt, busLimit, status and optional payment metadata.
  - `paymentHistory` array — copies of payments (orderId, paymentId, planCode, busCount, amount, status, timestamps) for audit.
- `src/modules/plan/plan.service.ts` exposes:
  - `getPlanSummary(organizationId)` — returns `activePlans`, `paymentHistory`, usage and remaining slots.
  - `getCapacityInfo(organizationId)` — concise API for the buses UI (currentBusCount, totalActiveBusLimit, remainingBusSlots, needMoreBuses).
  - `activatePaidPlan(...)` — validates payment amount, appends active plan record and updates payment history.

## Frontend flow (detailed)
1. User clicks Buy on admin UI (plan + busCount selected).
2. Frontend POST to `POST /api/admin/plans/razorpay/order` with JSON `{ planCode, busCount }`.
   - Backend returns: `{ order: { orderId, amount, currency, receipt, planCode, busCount, paymentId }, keyId }`.
   - Note: `amount` is in the smallest currency unit (paise for INR). For ₹1, amount will be `100`.
3. Frontend initializes Razorpay Checkout using these options:
   - `key`: `keyId` from backend response.
   - `order_id`: `order.orderId` (important field name).
   - `amount`, `currency`, and visible fields.
   - `handler` callback to process `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`.
   - `modal.ondismiss` to handle cancellations.
   - Listen for `payment.failed` event to handle failures.
4. On successful payment, frontend calls `POST /api/admin/plans/razorpay/verify` with `{ orderId, paymentId, signature }`.
   - Backend calls `paymentService.verifyRazorpayPayment()` which validates the HMAC signature using `RAZORPAY_KEY_SECRET`.
   - If valid, backend marks the payment as `paid`, creates/updates the subscription `activePlans` entry via `planService.activatePaidPlan(...)`, and returns the updated `currentPlan`.
5. If frontend receives success, refresh `GET /api/admin/plans/summary` and `GET /api/admin/plans/capacity` to update UI.

## Polling and webhooks
- Polling: frontend may call `GET /api/admin/plans/razorpay/status?orderId=...` to get payment `status: created|paid|failed`.
- Webhook: Razorpay will call `POST /api/webhooks/razorpay` for events like `payment.captured`, `payment.failed`, `order.paid`. The backend verifies the webhook signature using `RAZORPAY_WEBHOOK_SECRET` and will mark payments paid or failed and call `planService.activatePaidPlan` for final activation if needed. This ensures server-side activation reliability even if the frontend fails to notify.

## Testing: local + ngrok
1. Start backend locally: `npm run dev`.
2. Start ngrok to forward port 3000: `ngrok http 3000`.
3. Use the ngrok HTTPS URL as webhook URL in Razorpay dashboard: `https://<ngrok-id>.ngrok-free.app/api/webhooks/razorpay` and set the webhook secret from `.env`.
4. Create an order from the frontend (or Postman) and use Razorpay Checkout with test cards or test UPI VPAs (`success@razorpay`) for predictable outcomes.
5. Use the ngrok web UI (`http://127.0.0.1:4040`) to inspect webhook deliveries and debug payloads.

Example curl to simulate webhook (generate HMAC using your webhook secret):

```bash
RAW='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_TEST123","order_id":"order_TEST123","amount":100,"currency":"INR","notes":{"organizationId":"ORGID"}}}}}'
SECRET="<your_webhook_secret>"
SIG=$(node -e "console.log(require('crypto').createHmac('sha256', process.env.S).update(process.env.R).digest('hex'))" -- -S="$SECRET" -R="$RAW")
curl -X POST "https://<your-ngrok>/api/webhooks/razorpay" \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIG" \
  -d "$RAW"
```

## Frontend implementation checklist (copy-paste)
- On admin buses page load:
  - `GET /api/admin/plans/capacity` → if `needMoreBuses === true`, show “Buy more buses” CTA.
- Buy more buses modal:
  - Dropdown populated from `GET /api/admin/plans` (filter paid plans: `isTrial === false`).
  - Bus count numeric input.
  - `Buy` button calls `POST /api/admin/plans/razorpay/order`.
  - Use response `order.orderId` and `keyId` to open Razorpay Checkout.
  - In checkout `handler`, call `POST /api/admin/plans/razorpay/verify`.
  - On verify success: close modal, refresh `GET /api/admin/plans/summary`, `GET /api/admin/plans/capacity`, `GET /api/admin/plans/history`.
  - On `modal.ondismiss`: show cancellation toast and call `GET /api/admin/plans/razorpay/status?orderId=...` to update UI.

Example checkout handler (pseudo-code):

```js
const onBuy = async (planCode, busCount) => {
  const resp = await api.post('/api/admin/plans/razorpay/order', { planCode, busCount });
  const { order, keyId } = resp.data;

  const options = {
    key: keyId,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency,
    name: 'Where Are You',
    handler: async (res) => {
      await api.post('/api/admin/plans/razorpay/verify', {
        orderId: res.razorpay_order_id,
        paymentId: res.razorpay_payment_id,
        signature: res.razorpay_signature,
      });
      // refresh UI
    },
    modal: {
      ondismiss: () => {
        // show cancelled toast and optionally poll status
      }
    }
  };

  const rzp = new Razorpay(options);
  rzp.on('payment.failed', (err) => {
    // show error and poll status
  });
  rzp.open();
}
```

## Security & operational notes
- Never expose `RAZORPAY_KEY_SECRET` or `RAZORPAY_WEBHOOK_SECRET` to the browser.
- Use HTTPS in production; ngrok is for testing only.
- Validate amounts server-side: backend multiplies `pricePerBus * busCount * 100` and compares with Razorpay amount.
- Use idempotency: create payment records keyed by `orderId` so retries do not create duplicates.
- Logging: store webhook and payment events for auditing; be careful to mask sensitive details in logs if required.

## Going Live
1. Generate Live API keys in Razorpay Dashboard (Settings → API Keys) and replace `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in backend `.env`.
2. Create a Live webhook with your production HTTPS URL in Razorpay Dashboard, and set `RAZORPAY_WEBHOOK_SECRET` in backend.
3. Test with a small live transaction if acceptable, or use their sandbox first (test keys).
4. Monitor webhook deliveries and reconcile payments.

## Troubleshooting common issues
- "Invalid QR" in test mode: expected — use test VPAs/cards. In live mode, ensure `keyId` is live and not test.
- `receipt length must be <= 40`: receipt is now truncated in backend to avoid this error.
- Signature mismatch on verify: ensure frontend sends `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature` exactly and backend computes HMAC using `RAZORPAY_KEY_SECRET`.
- Webhook signature invalid: ensure you register same webhook secret in Razorpay and in `.env` and that the server captures raw request body for HMAC validation.

---

If you want, I can also:
- Add a short `README` with commands to run local tests (ngrok + curl webhook examples).
- Provide a small React/NextJS component patch for your admin buses page implementing the modal and Razorpay integration.
