import { NextResponse } from "next/server";
import { ensureScannerStarted, getScanner } from "@/lib/scanner/singleton";
import { mergeConfig, type ScannerConfig } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureScannerStarted();
  return NextResponse.json({ config: getScanner().config });
}

export async function PUT(req: Request) {
  await ensureScannerStarted();
  const body = (await req.json().catch(() => null)) as Partial<ScannerConfig> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const s = getScanner();
  const cfg = await s.updateConfig(mergeConfig(body));
  return NextResponse.json({ ok: true, config: cfg });
}
