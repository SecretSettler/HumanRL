import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(import.meta.dirname, "../fixtures/opencode/topology/opencode.db");
rmSync(output, { force: true });
mkdirSync(dirname(output), { recursive: true });
const db = new DatabaseSync(output);
db.exec(
  `CREATE TABLE session (id TEXT PRIMARY KEY,parent_id TEXT,version TEXT NOT NULL,time_created INTEGER NOT NULL,agent TEXT); CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,time_created INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY,message_id TEXT NOT NULL,session_id TEXT NOT NULL,time_created INTEGER NOT NULL,data TEXT NOT NULL);`,
);
const addSession = db.prepare("INSERT INTO session VALUES (?,?,?,?,?)");
addSession.run("ses-root", null, "1.18.16", 1000, "build");
addSession.run("ses-child", "ses-root", "1.18.16", 2000, "general");
addSession.run("ses-legacy", "ses-root", "1.2.21", 3000, "general");
const addMessage = db.prepare("INSERT INTO message VALUES (?,?,?,?)");
addMessage.run("msg-root", "ses-root", 1100, JSON.stringify({ role: "assistant" }));
addMessage.run("msg-child", "ses-child", 2100, JSON.stringify({ role: "assistant" }));
addMessage.run("msg-legacy", "ses-root", 3100, JSON.stringify({ role: "assistant" }));
const addPart = db.prepare("INSERT INTO part VALUES (?,?,?,?,?)");
addPart.run(
  "prt-modern",
  "msg-root",
  "ses-root",
  1200,
  JSON.stringify({
    type: "tool",
    tool: "task",
    callID: "call-task-1",
    state: {
      status: "completed",
      input: { description: "Child" },
      output: '<task id="ses-child" state="completed"><task_result>done</task_result></task>',
      metadata: { parentSessionId: "ses-root", sessionId: "ses-child" },
    },
  }),
);
addPart.run(
  "prt-legacy",
  "msg-root",
  "ses-root",
  1300,
  JSON.stringify({
    type: "tool",
    tool: "task",
    callID: "call-task-legacy",
    state: {
      status: "completed",
      input: { description: "Legacy" },
      output:
        "task_id: ses-legacy (for resuming to continue this task if needed)\n\n<task_result>done</task_result>",
      metadata: { sessionId: "ses-legacy" },
    },
  }),
);
addPart.run(
  "prt-truncated",
  "msg-child",
  "ses-child",
  2200,
  JSON.stringify({
    type: "tool",
    tool: "task",
    callID: "call-task-truncated",
    state: {
      status: "completed",
      input: { description: "Truncated" },
      output: "[Session persistence truncated large content]",
      metadata: {
        truncated: true,
        outputPath: "tool-output/tool-truncated",
        sessionId: "ses-legacy",
      },
    },
  }),
);
addPart.run(
  "prt-text",
  "msg-child",
  "ses-child",
  2300,
  JSON.stringify({
    type: "text",
    text: "Visible answer",
    reasoning: "must-not-persist-opencode",
    metadata: { directory: "/home/must-not-persist-user/Projects/demo" },
  }),
);
db.close();
writeFileSync(
  resolve(dirname(output), "opencode.db-wal"),
  "deterministic WAL companion placeholder\n",
);
