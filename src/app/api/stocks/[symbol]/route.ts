import { NextResponse } from "next/server";
import { ensureScannerStarted, getScanner } from "@/lib/scanner/singleton";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    await ensureScannerStarted();
    const { symbol } = await ctx.params;
    const payload = await getScanner().getStockDetail(decodeURIComponent(symbol).toUpperCase());
    if (!payload) {
      return NextResponse.json({ error: "symbol not in current F&O universe" }, { status: 404 });
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "engine briefly unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
