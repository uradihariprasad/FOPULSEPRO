import { NextResponse } from "next/server";
import { ensureScannerStarted, getScanner } from "@/lib/scanner/singleton";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureScannerStarted();
    const payload = getScanner().getDashboard();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "engine briefly unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
