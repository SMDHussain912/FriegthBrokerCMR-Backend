# FreightBrokerCMR Backend — Deployment Guide

## Prerequisites
- Node.js >= 20
- MongoDB >= 6 (production cluster recommended)
- A JWT_SECRET (>= 32 chars, not the demo default)

## Installation
```bash
cd backend
cp .env.example .env
# Edit .env with production values (MONGODB_URI, JWT_SECRET, CORS_ORIGIN)
npm ci
```

## Build / Start
```bash
npm start        # runs `node server.js`
# or with a process manager:
# npm i -g pm2 && pm2 start node server.js --name freightbroker-backend
```

## Environment Variables
See `.env.example` for the full list. Required in production:
- `NODE_ENV=production`
- `JWT_SECRET` (>= 32 chars, not demo default)
- `MONGODB_URI` (production cluster)
- `CORS_ORIGIN` (comma-separated frontend origins, no `*`)

## Security
- Security headers are applied on every response (`securityHeaders` middleware).
- Rate limiting is applied globally (120 req/min per IP+route) and stricter on `/api/auth` (20 req/min).
- JWT_SECRET is validated in production: must be set, not the demo default, and >= 32 chars.
- Demo accounts are disabled when `NODE_ENV=production`.

## Health Check
`GET /api/health` — returns service status.

## Notes
- This backend is a CommonJS Node/Express app.
- MongoDB indexes are created on boot via `initializeDatabaseState()`.
- Do not commit `.env`. It contains secrets.
