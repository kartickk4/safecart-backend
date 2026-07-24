# Safecart Backend

Node.js + Express + MongoDB Atlas backend for **Safecart (ParcelSafe)** — an escrow-based secure delivery platform with **Shiprocket Sandbox** logistics integration.

## Stack
- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** MongoDB Atlas (Mongoose)
- **Auth:** JWT + bcrypt
- **Logistics:** Shiprocket API v2 (sandbox or mock mode)
- **Jobs:** node-cron tracking poll fallback

## Quick Start
```bash
cd scratch/safecart-backend
cp .env.example .env
# Edit .env with your MongoDB URI and secrets
npm install
npm run dev
```
Server runs at `http://localhost:5000`.

## Environment Variables
| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `SHIPROCKET_EMAIL` | Shiprocket sandbox account email |
| `SHIPROCKET_PASSWORD` | Shiprocket sandbox password |
| `SHIPROCKET_MOCK` | Set `true` to simulate Shiprocket locally |
| `ENABLE_TRACKING_CRON` | Set `true` to enable 30-min tracking poll |

## API Endpoints
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | No | Register user |
| POST | `/api/v1/auth/login` | No | Login, returns JWT |
| GET | `/api/v1/profile` | Yes | View profile & bank details |
| PUT | `/api/v1/profile` | Yes | Update profile / payout bank |
| GET | `/api/v1/shipments` | Yes | List user's shipments |
| GET | `/api/v1/shipments/:id` | Yes | Get shipment + carrier journey |
| POST | `/api/v1/shipments` | Yes | Create escrow booking |
| POST | `/api/v1/shipments/:id/fund` | Yes | Fund escrow & create Shiprocket order |
| PUT | `/api/v1/shipments/:id/release` | Yes | Receiver confirms; release escrow |
| POST | `/api/v1/claims` | Yes | File dispute; lock escrow |
| POST | `/api/v1/tracking/webhook/shiprocket` | No | Shiprocket status webhook |

All protected routes require header: `Authorization: Bearer <token>`

## Escrow Lifecycle
1. **Stage 1** — Shipment created (`Awaiting Payment`)
2. **Stage 2** — Escrow funding initiated
3. **Stage 3** — Shiprocket order created (`Pending Pickup`)
4. **Stage 4** — In transit / out for delivery
5. **Stage 5** — Delivered (receiver notified to confirm)
6. **Stage 6** — Released (funds disbursed)
7. **Stage -1** — Locked (dispute claim filed)
