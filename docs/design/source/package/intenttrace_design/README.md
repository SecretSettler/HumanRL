# IntentTrace Design Package

This package contains:

- `IntentTrace_Design_Document.md`: complete Chinese product and technical design.
- `intenttrace_ui_prototype.html`: self-contained interactive UI prototype; open it in a browser.
- `intenttrace_ui_preview.png`: static preview of the prototype.
- `CODING_AGENT_BOOTSTRAP_PROMPT.md`: a standalone implementation prompt for a coding agent.
- `contracts/intent-graph-patch.schema.json`: strict JSON Schema for low-cost model output.
- `prompts/chunk-summarizer-system.md`: initial evidence-grounded summarizer system prompt.

The HTML prototype has no external dependencies. Use **Replay** to watch semantic nodes grow from a multi-agent trace, then click any node to inspect evidence and revision metadata.
