# Security policy

## Reporting a vulnerability

If you find a security issue, please do not file a public GitHub issue. Email a private report to the project maintainer.

Please include:

- A description of the issue
- Steps to reproduce, including a minimal example if possible
- The affected version (commit SHA if known)
- Any suggestions for remediation

Reports will be acknowledged within a reasonable window. Time-sensitive issues should say so in the subject line.

## Scope

This project is a deployment template. The security boundary is:

- Cloudflare Access protects the worker URL
- The worker trusts `Cf-Access-Authenticated-User-Email` for per-user scoping
- D1 history is scoped per user_email
- R2 objects carry `customMetadata.user_email` for ownership checks

In-scope vulnerabilities include:

- Bypasses of the per-user history scoping
- R2 object access by a user other than the owner
- Authentication or authorization issues in the artifact-serving path
- SQL injection or other injection issues
- Cross-site scripting or content injection via stored attachment metadata
- Logic errors that leak data across users

Out-of-scope:

- Issues that require already-compromised Cloudflare Access credentials
- Denial-of-service via legitimate-but-expensive Workers AI calls (this is a billing concern; rate-limit at the Gateway if needed)
- Issues in upstream Cloudflare services themselves
