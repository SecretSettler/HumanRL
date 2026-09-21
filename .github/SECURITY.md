# Security Policy

## Supported versions

IntentTrace has not published a stable release. Security fixes currently target `main` only. Historical commits, forks, unsigned DMGs, and third-party images are outside the supported boundary.

## Reporting a vulnerability

Do not open a public Issue for a suspected vulnerability, and do not attach real traces, sessions, secrets, or private source.

Use **Security → Report a vulnerability** in this repository. If private vulnerability reporting is unavailable, contact the maintainer through their GitHub profile and request a private channel before sending sensitive reproduction material.

A useful report includes:

- the affected commit or version and deployment method;
- the vulnerability class, impact, and required attack conditions;
- minimal reproduction steps using synthetic data only;
- a suggested fix or mitigation, when available; and
- any intended disclosure timeline.

Maintainers will try to acknowledge a report within seven days and coordinate next steps, but this volunteer project does not promise an SLA. Coordinate disclosure until a fix is available or an agreed date is reached.

## Deployment boundary

IntentTrace is a local-only, single-user MVP. Its only published service must bind to `127.0.0.1`. It has no authentication, multi-tenant isolation, or application-level encryption at rest, so it must not be exposed to an untrusted network.

Model-provider egress is disabled by default and requires an explicit mode, host allowlist, positive budget, timeout, event cap, and redaction gate. Raw trace and evidence paths must keep working when a provider is unavailable.

Never place the following in an Issue, fixture, telemetry, commit, or ordinary log:

- provider keys, authorization headers, cookies, or `.env` files;
- real trace payloads, session logs, database dumps, or artifact volumes;
- hidden reasoning, internal snapshots, or complete prompt and response bodies; or
- unanonymized source, paths, or session identifiers.

See the [security documentation](../docs/security.md) for the complete threat model, data-handling boundary, and provider-egress policy.
