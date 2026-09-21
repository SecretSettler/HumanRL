import type { NextRequest } from "next/server";

import { proxyApi } from "../../../../lib/api-proxy";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function handler(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxyApi(request, `/api/v1/${path.map(encodeURIComponent).join("/")}`);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
