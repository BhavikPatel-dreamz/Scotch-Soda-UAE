# QIVOS Token Auto-Refresh System

## Overview

This system automatically refreshes your QIVOS JWT token every 24 hours and stores it in the database. The token is refreshed before expiry to ensure continuous availability.

## Features

✅ Automatic token refresh every 24 hours  
✅ Token validation on startup  
✅ Token stored securely in database  
✅ Error handling and retry logic  
✅ Easy integration with API routes  

## Architecture

```
entry.server.tsx (initializes on app startup)
    ↓
server-init.server.ts (calls initializeServer)
    ↓
qivos-cron.server.ts (starts 24-hour cron job)
    ↓
qivos-token.server.ts (handles token refresh/storage)
    ↓
Database (SQLite - QIVOSToken table)
```

## Database Schema

A new `QIVOSToken` table stores the JWT token:

```prisma
model QIVOSToken {
  id        String    @id @default(cuid())
  token     String
  expiresAt DateTime
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

## Usage in Routes

### Simple API Call with Auto Token Refresh

```typescript
// app/routes/api.example.tsx
import { qivosApiCall } from "~/utils/qivos-api.server";

export async function loader() {
  try {
    // This automatically gets the current token
    const result = await qivosApiCall("/sso/v1/verify", {
      method: "POST",
      body: JSON.stringify({ /* data */ }),
    });
    
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

### Get Token for Custom Requests

```typescript
import { getQIVOSTokenForRequest } from "~/utils/qivos-api.server";

export async function loader() {
  const token = await getQIVOSTokenForRequest();
  
  // Use token in custom fetch request
  const response = await fetch("https://api-staging.qivos.net/custom-endpoint", {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  
  return response.json();
}
```

### Direct Token Management

```typescript
import {
  getQIVOSToken,
  refreshQIVOSToken,
  isQIVOSTokenExpired,
} from "~/utils/qivos-token.server";

// Get current token (refresh if expired)
const token = await getQIVOSToken();

// Force refresh
await refreshQIVOSToken();

// Check if expired
const expired = await isQIVOSTokenExpired();
```

## Environment Variables

Make sure these are in your `.env`:

```bash
# QIVOS credentials
QIVOS_PASSWORD=VW7Gha6Tckm89h7ZY!@#

# Token will be stored in database and also set to:
QIVOS_OTP_JWT_TOKEN=<auto-set by system>
```

## Cron Schedule

The system:
1. **On startup**: Checks if token exists and is valid. If expired/missing, refreshes immediately
2. **Every 24 hours**: Runs scheduled refresh
3. **On demand**: You can call `refreshQIVOSToken()` manually anytime

## Error Handling

The system handles errors gracefully:
- If token refresh fails, error is logged but app continues
- Next cron cycle will retry automatically
- You can manually refresh by calling `refreshQIVOSToken()`

Example error handling:

```typescript
import { getQIVOSToken } from "~/utils/qivos-token.server";

export async function loader() {
  try {
    const token = await getQIVOSToken();
    // Use token...
  } catch (error) {
    console.error("Failed to get QIVOS token:", error);
    // Return error response or fallback
    return { error: "Authentication service unavailable" };
  }
}
```

## Monitoring & Logging

All token operations are logged with `[QIVOS]` and `[CRON]` prefixes:

```
[CRON] Starting QIVOS token refresh cron job (every 24 hours)
[QIVOS] Refreshing token...
[QIVOS] Token refreshed successfully. Expires at: 2026-05-19T04:32:13.123Z
```

## Stopping the Cron (Optional)

```typescript
import { stopQIVOSTokenRefreshCron } from "~/utils/qivos-cron.server";

// Stop the cron job (useful for testing or graceful shutdown)
stopQIVOSTokenRefreshCron();
```

## Testing

To test token refresh manually:

```bash
# In your Node.js shell or route:
import { refreshQIVOSToken } from "~/utils/qivos-token.server";

const token = await refreshQIVOSToken();
console.log("New token:", token);
```

## Troubleshooting

### Token not refreshing

Check logs for `[QIVOS]` and `[CRON]` prefixes. Ensure:
- `.env` has correct `QIVOS_PASSWORD`
- Network can reach `https://api-staging.qivos.net`
- Database migration was applied: `npx prisma migrate deploy`

### Database schema out of sync

Run migration:
```bash
npx prisma migrate deploy
```

### Reset token (development)

```typescript
import prisma from "~/db.server";

// Clear all stored tokens
await prisma.qIVOSToken.deleteMany({});
```

## Files Created

- `app/utils/qivos-token.server.ts` - Core token refresh logic
- `app/utils/qivos-cron.server.ts` - Cron job scheduler  
- `app/utils/qivos-api.server.ts` - API helper with auth
- `app/utils/server-init.server.ts` - Server initialization
- `prisma/schema.prisma` - Updated with QIVOSToken model
- `prisma/migrations/` - Database migration
