import { NextResponse } from "next/server";
import { ensureScannerStarted, getScanner } from "@/lib/scanner/singleton";

export const dynamic = "force-dynamic";

/** POST { token } — validate against Upstox and persist server-side only. */
export async function POST(req: Request) {
  await ensureScannerStarted();
  let token = "";
  try {
    const body = (await req.json()) as { token?: string };
    token = (body?.token ?? "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid request body" }, { status: 400 });
  }
  if (!token || token.length < 10) {
    return NextResponse.json({ ok: false, error: "access token required" }, { status: 400 });
  }
  const scanner = getScanner();
  const result = await scanner.connectToken(token);
  return NextResponse.json(result, { status: result.ok ? 200 : 401 });
}
