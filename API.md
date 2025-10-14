## API Reference — TarunNode

### Base URL
- `http://localhost:3000`

### Common Headers
- `Content-Type: application/json`

### Authentication
- JWT is returned by `POST /auth/verify-otp` on successful verification.
- Include JWT as `Authorization: Bearer <token>` for protected endpoints (none protected by default in this scaffold).

---

### Health
- `GET /health`
- Response:
```
{
  "status": "ok",
  "uptime": 123.45,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

### Root
- `GET /`
- Response:
```
{
  "message": "Welcome to TarunNode API"
}
```

---

### Send OTP
- `POST /auth/send-otp`
- Body:
```
{
  "mobileNumber": "+15076195616"
}
```
- Response:
```
{
  "message": "OTP sent"
}
```

### Verify OTP (Register/Login)
- `POST /auth/verify-otp`
- Behavior:
  - If the mobile number does not exist, a user is created.
  - If it exists, the user is marked verified (if not already) and logged in.
- Body:
```
{
  "mobileNumber": "+15076195616",
  "code": "123456",
  "name": "Your Name",
  "role": "student"
}
```
- Response:
```
{
  "token": "<JWT_TOKEN>",
  "user": {
    "id": "665d8c...",
    "name": "Your Name",
    "mobileNumber": "+15076195616",
    "role": "student",
    "isVerified": true
  }
}
```

---

### Environment Variables (Required)
- Database: `MONGO_URI` (or `MONGODB_URI`)
- JWT: `JWT_SECRET` (and optional `JWT_EXPIRES_IN`)
- Twilio Verify:
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_VERIFY_SERVICE_SID`

### Notes
- Phone numbers should be in E.164 format (e.g., `+15076195616`).
- OTP delivery uses Twilio Verify; ensure Verify Service SID is configured.
- The OTP code in examples is dummy; use the actual code received on your phone.