import { refreshQIVOSToken, isQIVOSTokenExpired } from "./qivos-token.server";

let cronInterval: NodeJS.Timer | null = null;

/**
 * Start the QIVOS token refresh cron job
 * Runs every 24 hours or on demand if token is expired
 */
export function startQIVOSTokenRefreshCron(): void {
  if (cronInterval) {
    console.log("[CRON] QIVOS token refresh cron already running");
    return;
  }

  console.log("[CRON] Starting QIVOS token refresh cron job (every 24 hours)");

  // Run immediately on startup
  (async () => {
    try {
      const isExpired = await isQIVOSTokenExpired();
      if (isExpired) {
        console.log("[CRON] Token expired on startup, refreshing immediately");
        await refreshQIVOSToken();
      } else {
        console.log("[CRON] Token valid on startup");
      }
    } catch (error) {
      console.error("[CRON] Failed to refresh token on startup:", error);
    }
  })();

  // Schedule to run every 24 hours (86400000 milliseconds)
  cronInterval = setInterval(
    async () => {
      try {
        console.log("[CRON] Running scheduled token refresh");
        await refreshQIVOSToken();
      } catch (error) {
        console.error("[CRON] Scheduled token refresh failed:", error);
        // Continue running - will retry on next cycle
      }
    },
    24 * 60 * 60 * 1000,
  );

  // Gracefully handle process termination
  process.on("SIGTERM", () => {
    stopQIVOSTokenRefreshCron();
  });

  process.on("SIGINT", () => {
    stopQIVOSTokenRefreshCron();
  });
}

/**
 * Stop the QIVOS token refresh cron job
 */
export function stopQIVOSTokenRefreshCron(): void {
  if (cronInterval) {
    console.log("[CRON] Stopping QIVOS token refresh cron job");
    clearInterval(cronInterval);
    cronInterval = null;
  }
}

/**
 * Get cron status
 */
export function isQIVOSTokenRefreshCronRunning(): boolean {
  return cronInterval !== null;
}
