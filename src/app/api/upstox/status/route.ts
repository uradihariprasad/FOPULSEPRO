import { NextResponse } from "next/server";
import { ensureScannerStarted, getScanner } from "@/lib/scanner/singleton";

export const dynamic = "force-dynamic";

/** GET — connection status only. The token is never exposed. */
export async function GET() {
  await ensureScannerStarted();
  const s = getScanner();
  return NextResponse.json({
    connected: s.connected,
    userName: s.userName,
    running: s.running,
    tokenInvalid: s.tokenInvalid,
    apiCallsToday: s.client.callsToday,
    lastError: s.client.lastError,
  });
}

/** DELETE — remove stored credentials and stop the engine. */
export async function DELETE() {
  await ensureScannerStarted();
  const s = getScanner();
  await s.disconnect();
  return NextResponse.json({ ok: true });
}
