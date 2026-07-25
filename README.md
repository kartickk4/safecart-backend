# Safecart Escrow & Logistics Backend API

Express & MongoDB REST API server powering the Safecart Escrow and Logistics platform.

## 🚀 API Endpoints

- **`POST /api/v1/auth/signup`**: Register user with 2FA mobile OTP.
- **`POST /api/v1/auth/login`**: Authenticate user & issue JWT token.
- **`POST /api/v1/auth/send-otp`**: Dispatch SMS OTP.
- **`POST /api/v1/auth/verify-otp`**: Verify dynamic 6-digit OTP code.
- **`GET /api/v1/profile`**: Get user profile & bank payout details.
- **`GET /api/v1/shipments`**: List all escrow shipments.
- **`POST /api/v1/shipments`**: Book new escrow shipment.
- **`POST /api/v1/shipments/:id/fund`**: Lock payment in escrow vault.
- **`PUT /api/v1/shipments/:id/release`**: Release escrow payment to seller upon delivery.
- **`GET /api/v1/tracking/:awb`**: Fetch live courier milestone updates (TrackCourier).
- **`POST /api/v1/claims`**: File dispute claim with proof evidence links.

## 🛠️ Tech Stack

- **Runtime**: Node.js + Express
- **Database**: MongoDB Atlas + Mongoose
- **Security**: Helmet, Rate-Limit, CORS, JWT
- **Services**: BigDataCloud SMS API, TrackCourier API

## 🏃 Getting Started

### 1. Installation
```bash
npm install
```

### 2. Environment Variables (`.env`)
```env
PORT=5001
MONGODB_URI=mongodb+srv://...
JWT_SECRET=your_secret_key
SMS_API_KEY=your_sms_api_key
```

### 3. Start Server
```bash
npm start
```
