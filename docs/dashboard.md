# Local collaboration dashboard

Run on the host where the existing bridge runs:

```sh
c2c dashboard -w /absolute/workspace
```

For VS Code running in Flatpak, use host-accessible absolute paths:

```sh
flatpak-spawn --host /absolute/path/to/node /absolute/path/to/codex-with-chatgpt/bin/c2c.js dashboard -w /absolute/workspace
```

Keep the command running and open its single-use viewer link within five
minutes. The default is a free local port; `--port NUMBER` selects a fixed one.
After the first login, the same browser can revisit the base URL for eight
hours while the dashboard is running. A new browser, cleared cookies or expired
viewer access requires a new dashboard command/link. Ctrl-C stops only the
viewer, not the bridge or a Codex worker. It never starts/restarts the bridge,
changes its permissions, or recreates the ChatGPT plugin.

## What it shows

- Workspace task list with search, state filter and parent navigation.
- Side-by-side submitted request and released final Codex result.
- Client and Codex thread IDs for comparing related requests.
- Actual task creation/latest-update timestamps and existing coordinator events.
- Coordinator budgets, expiry, recorded state and blocked reason.
- Goal-based sessions waiting for a new root, before any task ID exists.
- Counts of pending Codex approval requests, with no approval controls.

It polls every two seconds when visible and every eight seconds when hidden.
Search and selection stay in place during updates. Results are limited to the
first 16,000 characters, explicitly marked when truncated. It reads at most
20 coordinator snapshots and 250 timeline events; corrupt/inaccessible audit
records are reported as incomplete history, not silently considered success.

The viewer does not reconstruct missing intermediate transitions or show raw
shell output, hidden reasoning, or the full ChatGPT/VS Code conversations.
Task submission is attributed to the bridge client; this is not independently
authenticated evidence of who is operating that client. `resultReleased` means
available to read, not acknowledged as read. A follow-up's content may provide
separate evidence of consumption, as in the random-code diagnostic.

On connection loss, the last successful data stays visible with an offline/
stale warning. A recorded coordinator state past its deadline is not labelled
as currently running. Reaching the round limit is not proof of goal completion.

## Security and scope

The viewer binds only to `127.0.0.1`. Do not publish or tunnel this service. It
rejects foreign Host/Origin and forwarded requests. The bridge admin token stays
in the local server process, never in HTML, browser JavaScript or API responses.
Only explicit GET routes to task/info/approval data are used; there is no
generic admin proxy or task execution/approval/release endpoint.

The viewer link contains a separate random, single-use read-only access code in
its URL fragment. It is removed from browser history before exchange for an
HttpOnly, SameSite=Strict viewer cookie. This grants no bridge/OAuth credentials
or execution authority. Treat the link/browser session as private: released
task contents can contain project data. Local HTTP is not TLS; the service is
designed for use on the same machine only. It does not protect against other
processes already controlling the same OS user or a compromised browser.

All dynamic content uses text nodes, not HTML. A restrictive content policy,
no-store responses, frame blocking and no external assets reduce browser attack
surface. Unreleased task results are removed before data reaches the browser.

## Verification

```sh
pnpm exec vitest run tests/dashboard.test.ts
pnpm typecheck
pnpm build
```

Optional real-browser checks reuse an explicitly provided existing Playwright
installation; no browser/runtime dependency is added to the bridge:

```sh
C2C_PLAYWRIGHT_PATH=/absolute/path/to/playwright/index.mjs pnpm exec vitest run tests/dashboard-browser.test.ts
```

These test single-use access, denied control routes, cross-origin/rebinding
protection, private/unreleased data exclusion, offline handling, real desktop/
mobile layout, safe rendering, parent navigation and automatic updates. They
do not claim a complete security audit or prove a ChatGPT web conversation is
actively running.
