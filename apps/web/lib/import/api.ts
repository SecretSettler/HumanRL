import {
  SessionImportBatchOutcomeSchema,
  SessionUploadCandidateListSchema,
  type SessionImportBatchOutcome,
  type SessionUploadCandidateList,
  type SessionUploadCandidateRequest,
} from "@intenttrace/schema";

import { buildSessionBundleFrame, type SelectedBundleGroup } from "./view-model";

/** Carries the RFC 7807 `code` so a row can report the server's own failure name. */
export class ImportRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportRequestError";
  }
}

async function readProblem(response: Response, label: string): Promise<ImportRequestError> {
  try {
    const body = (await response.json()) as { code?: unknown; detail?: unknown };
    const code = typeof body.code === "string" ? body.code : `${label}_${response.status}`;
    const detail = typeof body.detail === "string" ? body.detail : `${label} ${response.status}`;
    return new ImportRequestError(code, detail);
  } catch {
    return new ImportRequestError(`${label}_${response.status}`, `${label} ${response.status}`);
  }
}

export async function inspectCandidates(
  request: SessionUploadCandidateRequest,
  signal?: AbortSignal,
): Promise<SessionUploadCandidateList> {
  const response = await fetch("/api/v1/imports/candidates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    signal: signal ?? null,
  });
  if (!response.ok) throw await readProblem(response, "candidates");
  return SessionUploadCandidateListSchema.parse(await response.json());
}

export async function uploadSessionBundle(
  group: SelectedBundleGroup,
  signal?: AbortSignal,
): Promise<SessionImportBatchOutcome> {
  const body = await buildSessionBundleFrame(group.parts, group.source, group.candidateIds);
  const response = await fetch("/api/v1/imports/sessions", {
    method: "POST",
    headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
    body,
    cache: "no-store",
    signal: signal ?? null,
  });
  if (!response.ok) throw await readProblem(response, "upload");
  return SessionImportBatchOutcomeSchema.parse(await response.json());
}
