"use client";

import { useState } from "react";

import type { SemanticNodeStatus, SemanticNodeVersion } from "@/lib/workbench/types";

const statuses: SemanticNodeStatus[] = [
  "proposed",
  "active",
  "blocked",
  "completed",
  "abandoned",
  "superseded",
];

export function EditSummaryForm({
  node,
  onSave,
  onCancel,
}: {
  node: SemanticNodeVersion;
  onSave: (edit: { title?: string; status?: SemanticNodeStatus }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(node.title);
  const [status, setStatus] = useState<SemanticNodeStatus>(node.status);
  const [saving, setSaving] = useState(false);

  const titleValid = title.trim().length >= 3 && title.trim().length <= 80;
  const changed = title.trim() !== node.title || status !== node.status;

  return (
    <form
      className="grid gap-2 rounded-[10px] border border-line bg-[#0d1118] p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!titleValid || !changed) return;
        setSaving(true);
        const edit: { title?: string; status?: SemanticNodeStatus } = {};
        if (title.trim() !== node.title) edit.title = title.trim();
        if (status !== node.status) edit.status = status;
        void onSave(edit).finally(() => setSaving(false));
      }}
    >
      <label htmlFor="edit-title" className="text-meta text-muted">
        Title
      </label>
      <input
        id="edit-title"
        value={title}
        minLength={3}
        maxLength={80}
        onChange={(event) => setTitle(event.target.value)}
        className="rounded-lg border border-line bg-panel px-2 py-1.5 text-body"
      />
      <label htmlFor="edit-status" className="text-meta text-muted">
        Status
      </label>
      <select
        id="edit-status"
        value={status}
        onChange={(event) => setStatus(event.target.value as SemanticNodeStatus)}
        className="rounded-lg border border-line bg-panel px-2 py-1.5 text-body"
      >
        {statuses.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <div className="mt-1 flex gap-2">
        <button
          type="submit"
          disabled={!titleValid || !changed || saving}
          className="flex-1 rounded-lg px-2 py-1.5 text-body"
        >
          {saving ? "Saving…" : "Save summary"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg px-2 py-1.5 text-body"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
