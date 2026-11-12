# Ratcliff fork of skylight-mcp

A light fork of [chrischall/skylight-mcp](https://github.com/chrischall/skylight-mcp) (MIT), hosted as a claude.ai custom connector for a two-person household.

## What's different

Nothing upstream is edited. The fork only adds files:

| File | What it does |
| --- | --- |
| `src/http.ts` | Streamable HTTP entry (`node dist/http.js`). Sign-in is handled by the Ratcliff Health server. |
| `src/http-tools.ts` | The tools the HTTP entry serves: every module, minus the calendar tools (`BLOCKED_TOOLS`). |
| `tests/http.test.ts`, `tests/http-tools.test.ts` | Tests for both, keeping upstream's 100% coverage bar. |
| `Dockerfile`, `.dockerignore`, `FORK.md` | Hosting. |

The upstream stdio entry (`src/index.ts`) still has every tool. It just isn't what runs.

**Why no calendar tools:** the family calendar is Google Calendar, which Claude reaches through the Google connector, and the frame displays it. Skylight's own event tools would put events where Google never sees them, and `skylight_delete_source_calendar` could break the Google feed onto the frame. `skylight_list_categories` lives in the events module but stays, because chores and rewards need the family-member list.

## How sign-in works

1. Claude calls `/mcp` without a token and gets a 401 naming `/.well-known/oauth-protected-resource/mcp`.
2. That document lists the Ratcliff Health server (`AUTH_SERVER_URL`) as the authorization server, so Claude signs in there: Google only, limited to the household's two addresses.
3. Each `/mcp` request's token is checked with `POST {AUTH_SERVER_URL}/api/v1/introspect`, using the shared `AUTH_INTROSPECTION_SECRET`. A confirmed token is trusted for 60 seconds (cached by hash). If the health server can't be reached, the answer is 503, never a sign-out.

This server never holds the health database key. The Skylight login is a single shared account for the family.

## Environment

| Variable | Value |
| --- | --- |
| `PUBLIC_BASE_URL` | This service's origin, e.g. `https://skylight-production.up.railway.app` |
| `AUTH_SERVER_URL` | The Ratcliff Health origin |
| `AUTH_INTROSPECTION_SECRET` | Same value as `INTROSPECTION_SECRET` on the health server, 32+ characters |
| `MCP_DATA_DIR` | `/data` (a mounted volume, so Skylight's rotating token survives restarts) |
| `SKYLIGHT_EMAIL`, `SKYLIGHT_PASSWORD` | The family Skylight login |
| `MCP_CONFIRM_SECRET` | Random 32+ characters, so a pending confirmation survives a restart |
| `PORT` | Set by Railway; defaults to 8080 |

Writes keep upstream's default `MCP_CONFIRM_MODE=ask-user`: risky writes return a preview first, and Claude has to ask before the real change.

## Syncing with upstream

1. On GitHub, click **Sync fork** on `main`.
2. Merge `main` into this branch (or rebase). Since no upstream file is edited, this should never conflict.
3. Run `npm test`. `tests/http-tools.test.ts` fails if upstream renamed a blocked tool or added a new calendar tool, which is your cue to update `BLOCKED_TOOLS`.
4. Deploy.

Watch the upstream repo with **Watch > Custom > Releases** to hear about new versions. Sync to release tags, not every commit.
