export async function GET() {
  const origin = process.env.INTENTTRACE_API_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    const [readyResponse, versionResponse] = await Promise.all([
      fetch(`${origin}/readyz`, { cache: "no-store", signal: AbortSignal.timeout(1500) }),
      fetch(`${origin}/version`, { cache: "no-store", signal: AbortSignal.timeout(1500) }),
    ]);
    const version = (await versionResponse.json()) as { version?: string };
    if (!readyResponse.ok) {
      return Response.json(
        { ready: false, reason: "API dependencies are not ready" },
        { status: 503 },
      );
    }
    return Response.json({ ready: true, version: version.version ?? "unknown" });
  } catch {
    return Response.json({ ready: false, reason: "API unavailable" }, { status: 503 });
  }
}
