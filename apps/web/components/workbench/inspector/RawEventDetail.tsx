"use client";

import { useEffect, useState } from "react";

import { artifactUrl } from "@/lib/workbench/trace-api";
import type { ArtifactDetail, RawTraceEvent } from "@/lib/workbench/types";

function prettyPayload(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function RawEventDetail({ traceId, event }: { traceId: string; event: RawTraceEvent }) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);

  useEffect(() => {
    if (!event.payloadRef) {
      setDetail(null);
      return;
    }
    const payloadRef = event.payloadRef;
    const readLength = Math.min(payloadRef.byteLength, 8_388_608);
    const controller = new AbortController();
    setDetail({
      eventId: event.id,
      text: "Loading sanitized payload…",
      truncated: false,
      error: null,
    });
    void fetch(artifactUrl(traceId, payloadRef.artifactId, payloadRef.byteLength), {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`artifact ${response.status}`);
        const text = await response.text();
        setDetail({
          eventId: event.id,
          text: prettyPayload(text),
          truncated: readLength < payloadRef.byteLength,
          error: null,
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setDetail({
          eventId: event.id,
          text: "",
          truncated: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => controller.abort();
  }, [event, traceId]);

  return (
    <article className="raw-detail" aria-label="Selected raw event detail">
      <header>
        <div>
          <small>Raw event #{event.ingestSeq}</small>
          <h3>{event.name}</h3>
        </div>
        <span>{event.kind}</span>
      </header>
      <dl>
        <div>
          <dt>Agent</dt>
          <dd>{event.agentId ?? "system"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{event.status}</dd>
        </div>
        <div>
          <dt>Occurred</dt>
          <dd>{new Date(event.occurredAt).toLocaleTimeString()}</dd>
        </div>
      </dl>
      {event.payloadRef ? (
        <>
          <a
            href={artifactUrl(traceId, event.payloadRef.artifactId, event.payloadRef.byteLength)}
            target="_blank"
            rel="noreferrer"
          >
            Open sanitized source payload
          </a>
          {detail?.eventId === event.id ? (
            detail.error ? (
              <p role="alert">Payload unavailable: {detail.error}</p>
            ) : (
              <>
                <pre>{detail.text}</pre>
                {detail.truncated ? (
                  <small>Payload exceeds the 8 MiB inline viewer limit.</small>
                ) : null}
              </>
            )
          ) : null}
        </>
      ) : (
        <p className="muted">This marker has no source payload.</p>
      )}
    </article>
  );
}
