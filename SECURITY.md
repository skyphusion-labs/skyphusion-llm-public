# Security policy

## Supported versions

This is a rolling, single-`main`-branch deployment template; only the latest release on `main` receives security fixes. If you are running an older revision, upgrade to the newest version to pick them up.

## Reporting a vulnerability

Please do not file a public GitHub issue for security problems. Instead, report it privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and click **"Report a vulnerability"**. This creates a private advisory visible only to you and the maintainers. (If that option is not visible, open a minimal public issue asking for a private channel, without disclosing any details.)

Please include:

- A description of the issue
- Steps to reproduce, including a minimal example if possible
- The affected version (commit SHA if known)
- Any suggestions for remediation

Reports will be acknowledged within a reasonable window (target: 5 business days). Time-sensitive issues should say so. Please allow up to 90 days for a coordinated fix before public disclosure.

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
