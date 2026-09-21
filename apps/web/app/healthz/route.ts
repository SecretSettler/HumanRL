export function GET() {
  return Response.json({ service: "web", status: "ok", gate: 5 });
}
