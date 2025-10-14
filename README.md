## TarunNode — Express + MongoDB Starter

### Prerequisites
- Node.js 18+ and npm
- MongoDB running locally (or a MongoDB Atlas URI)

### Setup
1. Install dependencies:
   ```
   npm install
   ```
2. Create an environment file:
   ```
   copy .env.example .env
   ```
   Update values in `.env` as needed.

### Run
- Development (auto-restart):
  ```
  npm run dev
  ```
- Production:
  ```
  npm start
  ```

### Project Structure
```
src/
  config/
    db.js           # MongoDB connection helper (mongoose)
  routes/
    health.js       # Health-check route
  app.js            # Express app bootstrap
  index.js          # Server entry, env setup, DB connect
.env.example        # Sample environment variables
.gitignore          # Common ignores
```

### Environment Variables
- `PORT` — Server port (default 3000)
- `NODE_ENV` — Environment name (development/production)
- `LOG_LEVEL` — Logging verbosity (info/debug)
- `MONGODB_URI` — MongoDB connection string
- `JWT_SECRET` — Example secret (replace in real usage)