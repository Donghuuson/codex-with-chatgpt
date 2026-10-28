# Codex with ChatGPT

> ChatGPT thinks. Codex works.

Connect the ChatGPT web app to a local workspace for planning and independent
review, while Codex handles implementation and testing.

This fork extends the [original project](https://github.com/XiaoDuoYa/codex-with-chatgpt)
with locally reviewed task execution, bounded follow-up coordination, and a
read-only collaboration dashboard. The project documentation, interface, and
command-line messages are in English.

## Capabilities

- Read workspace files, search code, inspect Git changes, and review execution
  records through an authenticated MCP connection.
- Keep the default connection read-only. Task submission requires explicit
  execution configuration and a new authorization grant.
- Submit bounded tasks to a separate local Codex App Server, review approvals
  locally, and release completed results to ChatGPT.
- Authorize a limited coordination session for a specific goal, including
  follow-up tasks without manually copying task IDs or outputs.
- Monitor requests, released results, pending approvals, and session history
  through a local read-only dashboard.

This is not a replacement for Codex or an extension that takes control of an
existing VS Code conversation. ChatGPT must continue making its own tool calls;
the bridge cannot wake an idle web chat or guarantee indefinite background work.

## Requirements

- Node.js 20 or newer, Git, and pnpm (the pinned version is in `package.json`).
- `cloudflared` for a remote ChatGPT connection.
- A ChatGPT account with access to custom MCP connections.
- A local Codex executable for the optional execution workflow.

The Codex Skill supports AI-assisted setup when the required built-in browser
is available, or guided manual setup. Logins, CAPTCHAs, and authorization still
require the user. Availability and labels in the ChatGPT interface can vary.

## Install and build

```sh
git clone https://github.com/Donghuuson/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Use `node /absolute/path/to/codex-with-chatgpt/bin/c2c.js` in place of `c2c`
if the executable is not on your PATH.

To install the optional Codex Skill, copy `skill/SKILL.md` to
`<codex-home>/skills/codex-with-chatgpt/SKILL.md`. Use a non-empty
`CODEX_HOME` when configured, otherwise `~/.codex`
(`%USERPROFILE%\.codex` on Windows). Replace `<ACTUAL_CHECKOUT_PATH>`
in the installed copy with the actual checkout path.

Then ask Codex:

> Set up Codex with ChatGPT for this workspace. Ask before installing missing
> software or changing permissions. Verify a workspace file read before
> reporting that the connection works.

## Connect a workspace

```sh
c2c setup -w /absolute/workspace --json
c2c status -w /absolute/workspace
c2c doctor -w /absolute/workspace
```

Follow the selected setup workflow to add the workspace connection in ChatGPT
and authorize it with the short-lived pairing code. Verify the connection by
asking ChatGPT to identify the workspace and read a non-sensitive file.

A temporary Cloudflare address can change when the bridge restarts. A stable
hostname requires a Cloudflare-managed domain and additional setup. Credentials
and connection state are stored outside the workspace, in the OS app state
directory. Do not restart a working connection merely to inspect it.

## Optional task execution

Execution is disabled by default. Configure it on the computer where Codex
will run:

```sh
c2c tasks configure -w /absolute/workspace --codex /absolute/path/to/codex --enable
```

Configuration applies on the next bridge start, not immediately. Existing
read-only tokens do not gain execution permissions: a new authorization grant
must explicitly include `task.submit`.

The manual workflow is submit → local approval → run → release → review.
ChatGPT cannot approve Codex command/file escalations through the remote tools.
See [task execution](docs/task-execution.md) for commands and permission limits.

For a bounded session without copying IDs:

```sh
c2c tasks start -w /absolute/workspace --goal "Inspect the report tests without editing files." --max-tasks 2 --minutes 10 --allow-followups
```

Wait for `waiting_for_task`, then ask ChatGPT to submit that **exact goal text**
as a new task through the workspace plugin. It can wait for released results,
review them, and submit a follow-up within the authorized budget.

This command grants execution and result release for the selected client's
matching task chain. Follow-ups remain limited by the worker sandbox, not by a
proof of their natural-language meaning. Authorize only a trusted client and a
reviewed goal. Additional Codex permissions still require local review.

## Local dashboard

```sh
c2c dashboard -w /absolute/workspace
```

Keep the command running and open its single-use viewer link within five
minutes. The dashboard shows requests, released results, coordinator state,
and pending approval counts. It does not grant permissions, submit tasks, or
restart the bridge.

The dashboard is loopback-only. Never expose it through a tunnel or public
server. See [dashboard documentation](docs/dashboard.md), including Flatpak
usage and browser checks.

## Security boundaries

- OAuth grants and workspace paths are scoped to one workspace.
- Read tools enforce path containment and sensitive-file exclusions.
  `.c2cignore` adds project-specific exclusions.
- Optional execution uses a separate permissions profile and local approval
  workflow. It is not equivalent to the read-only access model.
- Keep secrets outside execution workspaces. Ignore patterns and sandbox tests
  are not a guarantee against every possible filesystem interaction.
- Results can contain project data. Review them before release, and keep
  pairing codes, access links, tokens, and local state private.
- A released result is available to read; it is not proof that ChatGPT read it.
  A task limit being reached is not proof that the requested goal is complete.

Read the [security model](docs/security.md) and the
[execution boundaries](docs/task-execution.md#execution-boundaries) before
enabling execution. This project does not claim a complete security audit.

## Development and verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

The default suite includes unit and integration checks. Real Codex execution
and browser tests are opt-in; skipped tests are not evidence those integrations
were verified. The exact acceptance commands and prerequisites are documented
in [task execution](docs/task-execution.md) and
[dashboard verification](docs/dashboard.md#verification).

Generated assets can be inspected through `read_image`. The local
`c2c asset import` command validates supported downloads before importing them
into a new workspace path; it does not overwrite existing files.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security](docs/security.md)
- [Task execution and coordination](docs/task-execution.md)
- [Local dashboard](docs/dashboard.md)
- [Troubleshooting](docs/troubleshooting.md)

## Attribution and license

Based on [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt).
Original attribution and the [MIT license](LICENSE) are retained.

Unofficial community project. Not affiliated with or endorsed by OpenAI.
