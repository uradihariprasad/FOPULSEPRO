import { ScannerService } from "./service";
import { ensureSchema } from "@/db/ensure-schema";

const globalForScanner = globalThis as typeof globalThis & {
  __foScannerService?: ScannerService;
  __foScannerStarted?: Promise<void>;
  __foScannerGuards?: boolean;
};

/**
 * Resilience: an unhandled async error must never kill the Node process.
 * When the process died mid-poll, the hosting proxy served an HTML error
 * page which surfaced in the UI as "Unexpected token '<' ... not valid JSON".
 * Log and keep the engine alive instead.
 */
if (typeof process !== "undefined" && !globalForScanner.__foScannerGuards) {
  process.on("unhandledRejection", (reason) => {
    console.error("[scanner] unhandledRejection:", reason instanceof Error ? reason.message : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[scanner] uncaughtException:", err.message);
  });
  globalForScanner.__foScannerGuards = true;
}

export function getScanner(): ScannerService {
  if (!globalForScanner.__foScannerService) {
    globalForScanner.__foScannerService = new ScannerService();
  }
  return globalForScanner.__foScannerService;
}

/** Idempotent startup — safe to call from instrumentation or API routes. */
export function ensureScannerStarted(): Promise<void> {
  if (!globalForScanner.__foScannerStarted) {
    globalForScanner.__foScannerStarted = ensureSchema()
      .then(() => getScanner().init())
      .catch((e) => {
        console.error("scanner init failed", e instanceof Error ? e.message : e);
      });
  }
  return globalForScanner.__foScannerStarted;
}
