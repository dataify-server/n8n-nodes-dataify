# Security Review Report

- Date: 2026-08-06 21:39 Asia/Shanghai
- Scope: credentials, MCP transport, node execution, package dependencies
- Result: PASS with documented residual risks

## Controls Verified

- API token uses an n8n password credential and is restricted to the Dataify MCP node.
- Non-loopback HTTP is rejected by default; remote deployments must use HTTPS unless the credential owner explicitly opts in.
- Redirects are disabled, the request domain is constrained, and requests have a 180-second timeout.
- Token and API-key query values are redacted and error messages are length-limited before entering workflow output.
- Server URLs reject embedded credentials and sensitive query parameters.
- MCP pagination, tool counts, input size, input depth, and input value counts are bounded.
- Published runtime dependency audit reports zero vulnerabilities.
- No hardcoded credentials or token logging were found.

## Residual Risks

MEDIUM: The backend contract requires the API token in the URL query string. HTTPS protects it in transit, but reverse proxies and access logs can still record it. Production operators must redact query strings. A future backend revision should support `Authorization: Bearer` and the node should migrate to header authentication.

MEDIUM: The official development toolchain currently reports 2 high and 6 moderate advisories through `release-it` and `@n8n/node-cli`. These are development-only dependencies and are absent from the published runtime tree. n8n's official lint prohibits package overrides; upgrading the upstream tools is the supported remediation path.

LOW: The server URL is intentionally configurable for self-hosted Dataify deployments. Users allowed to edit credentials can target internal services. Keep credential-edit permissions limited to trusted administrators.

## Verification

- `npm audit --omit=dev`: 0 vulnerabilities
- Full `npm audit`: 8 development-only vulnerabilities
- Error-redaction and insecure-URL tests: passed
- No destructive security auto-fixes were applied

