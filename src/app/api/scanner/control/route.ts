import { NextResponse } from "next/server";
import { ensureScannerStarted, getScanner } from "@/lib/scanner/singleton";

export const dynamic = "force-dynamic";

/** POST { action } — start | stop | refresh-universe | refresh-baselines */
export async function POST(req: Request) {
  await ensureScannerStarted();
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  const s = getScanner();
  switch (action) {
    case "start":
      s.start();
      return NextResponse.json({ ok: s.running, message: s.message });
    case "stop":
      s.stop();
      return NextResponse.json({ ok: true });
    case "refresh-universe": {
      const r = await s.ensureUniverse(true);
      return NextResponse.json({ ok: !r.error, ...r });
    }
    case "refresh-baselines": {
      // fire and continue in background to avoid long request
      void s.refreshBaselines().catch(() => void 0);
      return NextResponse.json({ ok: true, started: true });
    }
    default:
      return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  }
}
