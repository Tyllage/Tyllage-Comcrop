# Security Policy

Tyllage handles farm-private commercial data (production costs, minimum prices, margins) and buyer contact details, so we take security reports seriously.

## Supported versions

Tyllage is in its pilot (MVP) phase. Only the latest commit on `main`, and the deployment built from it, receives security fixes.

| Version | Supported |
|---|---|
| `main` (latest) | ✅ |
| Older commits and forks | ❌ |

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues, discussions or pull requests.**

Report privately through GitHub instead:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, including:
   - the affected endpoint, page or file;
   - steps to reproduce, or a proof of concept;
   - the impact you believe it has (for example, a buyer reading another farm's minimum prices);
   - any suggested fix.

We will:

- acknowledge your report within **5 working days**;
- give an initial assessment within **10 working days**;
- keep you updated until it is fixed, and credit you in the fix notes if you wish.

## Scope

In scope:

- the API under `server/` and the web app under `client/`;
- the production deployment of this repository;
- authentication, role-based access and farm data isolation, for example:
  - a farm reading another farm's records;
  - a buyer seeing farm-private prices, costs or margins;
  - privilege escalation between roles;
  - reward points being spent twice, or a Shop discount taking an order below the farm's approved margin.

Out of scope:

- the **demo accounts and demo password** documented in the README. They are deliberately public and are only for fictional pilot data;
- findings that need a compromised device, browser extension or physical access;
- denial of service through traffic volume;
- missing best-practice headers without a demonstrated impact;
- third-party services (Railway, OpenAI, WhatsApp Cloud API). Report those to the provider;
- Shop payments, which are simulated in the pilot. No real money or card details are handled.

## Safe harbour

We will not take action against good-faith research that:

- only uses accounts you own or the published demo accounts;
- does not access, change or delete data that is not yours;
- does not degrade the service for others;
- gives us reasonable time to fix the issue before you disclose it.

## How Tyllage protects data

[AUDIT.md](AUDIT.md) lists the security controls in place, the latest audit results and known limitations.
