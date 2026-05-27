import { startQIVOSTokenRefreshCron } from "./qivos-cron.server";

let initialized = false;

/**
 * Initialize server-side services
 * Call this once on app startup
 */
export async function initializeServer(): Promise<void> {
  if (initialized) {
    console.log("[SERVER] Already initialized");
    return;
  }

  console.log("[SERVER] Initializing server...");

  try {
    // Start QIVOS token refresh cron
    startQIVOSTokenRefreshCron();

    initialized = true;
    console.log("[SERVER] Server initialization complete");
  } catch (error) {
    console.error("[SERVER] Failed to initialize:", error);
    // Don't throw - allow app to continue
  }
}

export function isServerInitialized(): boolean {
  return initialized;
}
