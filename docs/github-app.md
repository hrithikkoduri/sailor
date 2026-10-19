# Use Sailor with your own GitHub App

Sailor's entire GitHub side runs through a **GitHub App you own** — your bot
identity (`your-slug[bot]`), your installations, your tokens. No PATs, no
shared credentials. While Sailor is self-hosted, each user brings their own
App; a hosted public App (install it like any other GitHub App) comes with the
hosted product. This is the one-time setup, ~3 minutes.

## 1. Create the App

Go to **https://github.com/settings/apps/new** (or your org's App settings).

- **Name**: anything, e.g. `sailor-dev` — its slug is your `GITHUB_APP_SLUG`
- **Homepage URL**: this repo

### URLs (local dev)

| Field | Value |
| --- | --- |
| Webhook URL | `https://<your-tunnel>/webhooks/github` — a tunnel in front of the server: `ngrok http 8787` |
| Callback URL | `http://localhost:8787/auth/github/callback` — powers "Continue with GitHub" on the dashboard |
| Setup URL | `http://localhost:8787/setup` — links an installation to your account during onboarding |
| Webhook secret | a random string, e.g. `openssl rand -hex 32` |

(`8787` is the server default — configured by `SAILOR_PORT`.)

### Repository permissions

- **Contents**: Read and write — clone repos, push `sailor/issue-*` branches
- **Issues**: Read and write — read issues, label, comment
- **Pull requests**: Read and write — open PRs, reply to reviews
- **Checks**: Read-only — CI status
- **Metadata**: Read-only (mandatory)

### Subscribe to events

`issues`, `issue_comment`, `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `check_run`, `status`, `push`, `installation`,
`installation_repositories`.

### Where can this App be installed

- **Only on this account** — right for personal / self-hosted use.
- **Any account** (public App) — for when you *host* Sailor for others.

Create the App, then **Generate a private key** (downloads a `.pem`).

## 2. Fill the environment

From [`.env.example`](../.env.example):

| Variable | From |
| --- | --- |
| `GITHUB_APP_ID` | the App settings page |
| `GITHUB_APP_SLUG` | the slug — also derives the bot login `<slug>[bot]` |
| `GITHUB_APP_PRIVATE_KEY` | the `.pem` — paste raw, base64, or with `\n` escapes; auto-decoded |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | for GitHub sign-in (user-to-server OAuth) |
| `GITHUB_WEBHOOK_SECRET` | the secret you typed above |

Check it: `npm run doctor` — the `GITHUB_APP` line shows the app id and slug.

## 3. Install it, then use it

- Sign in on the dashboard (`Continue with GitHub`) → onboarding installs the
  App (`https://github.com/apps/<slug>/installations/new`) and links it to
  your account. Repos arrive **disabled** — enable the ones Sailor may watch.
- Keep the tunnel running and the App's Webhook URL pointed at it (free ngrok
  URLs rotate).
- Label an issue `agent:fix` on an enabled repo → a thread appears on the
  dashboard, the agent works in a microVM, and a reviewed PR lands with a
  trace link. Issue comments, reviews, and red CI wake the same thread.

## Why it's shaped this way

The App is the only GitHub credential path (decision #42): app-level webhooks
with one secret, per-installation tokens minted per run and expired in ~1h,
one bot identity, install-per-repo scoping. The original dev checklist is
decision #43; onboarding and repo-gating are #44 — see
[`DECISIONS.md`](../DECISIONS.md).
