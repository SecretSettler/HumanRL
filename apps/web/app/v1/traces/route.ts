import type { NextRequest } from "next/server";

import { proxyApi } from "../../../lib/api-proxy";

export async function POST(request: NextRequest): Promise<Response> {
  return proxyApi(request, "/v1/traces");
}
