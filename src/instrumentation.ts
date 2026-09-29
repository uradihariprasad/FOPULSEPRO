export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureScannerStarted } = await import("@/lib/scanner/singleton");
    await ensureScannerStarted();
  }
}
