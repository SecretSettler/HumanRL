import type { NextRequest } from "next/server";

const requestHeaders = ["accept", "content-type", "content-encoding", "last-event-id"] as const;
const responseHeaders = [
  "accept-ranges",
  "cache-control",
  "content-range",
  "content-type",
  "etag",
  "x-content-type-options",
] as const;

function apiOrigin(): URL {
  const origin = new URL(process.env.INTENTTRACE_API_ORIGIN ?? "http://127.0.0.1:3001");
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("INTENTTRACE_API_ORIGIN must use http or https");
  }
  return origin;
}

export async function proxyApi(request: NextRequest, upstreamPath: string): Promise<Response> {
  const upstream = new URL(upstreamPath, apiOrigin());
  upstream.search = request.nextUrl.search;
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  });
  const outgoing = new Headers();
  for (const name of responseHeaders) {
    const value = response.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: outgoing });
}
