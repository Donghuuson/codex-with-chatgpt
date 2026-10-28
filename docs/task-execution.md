# Task execution through the workspace bridge

The bridge can expose an opt-in task workflow over the same authenticated MCP
endpoint as the existing read tools. ChatGPT submits and reviews tasks; a
separate local Codex App Server executes them. It does not take control of an
existing VS Code conversation.

Execution is disabled by default. Old access and refresh tokens do not gain
`task.submit`; token refresh preserves their original scopes. A new grant must
explicitly include this scope and shows task submission on the pairing screen.

## Configure on the host

Use the machine where Codex will execute, particularly when VS Code runs inside
Flatpak. Both the executable and workspace must exist in that environment.

```sh
c2c tasks configure -w /absolute/workspace --codex /absolute/path/to/codex --enable
```

This writes workspace-specific settings with owner-only permissions. It does not
change the running bridge. The settings take effect on the next bridge start.
Omit `--enable` to save a disabled configuration for the next start. Restarting
may change a temporary public address and require updating the ChatGPT plugin.
Do not restart a working connection before the user is ready for that step.

## Local review

```sh
c2c tasks list -w /absolute/workspace
c2c tasks approve TASK_ID -w /absolute/workspace
c2c tasks run TASK_ID -w /absolute/workspace
c2c tasks approvals TASK_ID -w /absolute/workspace
c2c tasks decide TASK_ID REQUEST_ID accept -w /absolute/workspace
c2c tasks release TASK_ID -w /absolute/workspace
```

Inspect each request before accepting it: a Codex command or file approval may
request access beyond the task's sandbox. Use `decline` to refuse it. The bridge
does not automatically answer approvals. `reject` rejects a pending task and
`cancel` stops a running task. A successful result stays private until `release`.
Local CLI review uses the existing loopback-only admin API; OAuth clients cannot
approve, run, release or cancel tasks through the remote tools.

Tasks are stored outside the workspace with owner-only permissions. On restart,
formerly running tasks become interrupted and are not automatically rerun.
Each follow-up is a new pending task that resumes the parent's Codex thread.

## Bounded automatic coordination

### Start from a goal, without copying IDs

```sh
c2c tasks start -w /absolute/workspace --goal "Inspect the report tests without editing files." --max-tasks 2 --minutes 10 --allow-followups
```

This local command is the one-time authorization. It automatically selects the
only currently task-authorized client for this workspace. If none or more than
one exists, it fails closed; obsolete grants can be revoked or an operator can
explicitly select a client with `--client`. No token, client or task IDs need to
be copied in the usual single-connection flow.

Wait for `waiting_for_task`, then give ChatGPT the goal once, asking it to send
the **exact goal text** through `task_submit` as a **new task**, without an old
`parent_id`. ChatGPT uses the returned IDs internally for `task_wait` and any
later `parent_id`; the operator does not relay IDs or outputs.

Only new roots arriving after the local queue snapshot, from the selected
client, with exactly that first-task text can bind. Old pending jobs, different
clients, children of previous tasks and rewritten/expanded goals are ignored.
Multiple matching new roots block the session rather than selecting the latest.
Use `request_id` in ChatGPT retries to avoid creating duplicates. A root already
approved/running outside this session is not silently adopted. The original
time budget includes waiting for the first task and is not extended on binding.

The waiting state and subsequent execution share one audit session and one
workspace lock. The same task budget counts only the newly selected root and
its allowed descendants, not an old diagnostic anchor. Ctrl-C, expiry, errors,
client isolation and manual Codex escalation decisions remain unchanged. Add
`--json` for machine-readable status events. This companion command uses the
existing remote task tool; it needs no bridge restart or plugin re-pairing.

Exact goal matching is an authorization boundary, not semantic enforcement of
all future actions. Granting `--allow-followups` still authorizes the selected
client's linear descendants in the existing worker sandbox, as described below.

### Existing explicit-root command

Once a root task has been submitted, authorize its chain once on this computer:

```sh
c2c tasks supervise ROOT_TASK_ID -w /absolute/workspace --max-tasks 3 --minutes 10 --allow-followups
```

This is an explicit grant to approve, run and release results for the selected
root and its same-owner, linear follow-ups in that workspace. It is not merely
a status command. Follow-ups can modify workspace files within the worker's
existing sandbox; the coordinator does not prove their natural-language scope
matches the goal. Only authorize a trusted client for a goal you have reviewed.
For diagnostics, add `--allow-message 'exact first message' 'exact follow-up'`
to reject any other task text. Omit `--allow-followups` to execute only the root.

The coordinator never grants a Codex command/file escalation. It displays
`waiting_for_user` until the operator makes a local decision or stops the
session. Tasks from another owner, unrelated roots, concurrent work and forks
are not automatically accepted. Failures, ambiguous runs, limits and expiry
stop the session rather than retrying work. `limit_reached` means the task
budget was consumed, not that the engineering objective has been verified.

The command runs in the foreground. Ctrl-C stops supervision and requests
cancellation of its current worker. Keep it running for the authorized session;
it does not silently restart or restore a grant after a crash. An abrupt kill
can leave the current worker running until its own five-minute task timeout,
but cannot start another task. Cancellation requests are not proof that every
host process has already terminated. Review task state if cancellation is
reported as unconfirmed.

The real Codex runtime can create empty hidden metadata/denial directories
during worker setup, even for a prompt requesting no tools. A no-tools prompt
is not a guarantee of zero runtime filesystem activity; the integration test
uses explicit empty fixtures and verifies that no contents or extra paths are
written.

One exclusive lock is used per workspace. Stale locks are not automatically
discarded: first confirm the recorded process has stopped, then remove only
that lock. Private grant/status snapshots and event records live under
`<state-dir>/coordination/<workspace-id>/`, outside the source tree. The session
is bound to the current bridge credentials and does not reconnect to a new
daemon on its own. This companion command uses existing local APIs and does
not restart the running bridge or require re-pairing the ChatGPT plugin.

Start the ChatGPT conversation once with the goal, maximum task count and this
instruction:

> Use this workspace's plugin. Submit the first bounded task, then repeatedly
> call task_wait until its released result is available. Independently review
> it using the existing read tools. If a revision is necessary, submit it with
> parent_id pointing to the last completed task and wait again. Stay within the
> agreed goal and task budget. Do not ask me to relay messages or outputs. Stop
> and report failures or requests for additional authority; do not approve them.

After local session authorization there is no per-turn operator relay. ChatGPT
still needs to initiate/continue its own tool calls: the companion cannot wake
a web chat that has ended its turn or guarantee indefinite background operation.

## ChatGPT workflow

Select the workspace plugin and authorize `task.submit`. Then tell ChatGPT:

> Identify the workspace with workspace_info. Submit one bounded task through
> task_submit with a request_id. Wait with task_wait while I review it locally.
> After a completed result has been released, inspect it independently. If a
> revision is needed, submit a follow-up using parent_id and wait for local
> review again. Do not ask me to relay code or results between the two systems.
> Do not claim success on failed or interrupted tasks, and do not approve tasks
> yourself.

`request_id` makes retries of the same request idempotent. `task_wait` waits at
most 25 seconds per call. It returns task state and only released results.
ChatGPT controls subsequent tool calls in its conversation; the bridge cannot
force a web conversation to generate a new message or run indefinitely.

## Execution boundaries

The executor selects and verifies a named, per-process Codex permissions profile.
The profile grants minimal runtime reads, workspace writes, denies external
filesystem reads and command networking, and denies sensitive patterns plus
`.c2cignore` entries. Protected workspace metadata is read-only. Other configured
MCP servers are disabled for the worker thread. Unrelated credential environment
variables are removed from the worker process.

Ignore negations are deliberately not translated into permission grants. On
Linux, glob denies are expanded when a sandboxed process starts; they do not
protect a matching secret newly created during that process's lifetime. Keep
credentials out of execution workspaces. A tool approval can change access and
must be reviewed locally.

Linux sandboxing can let a command create a file in an ephemeral masked parent
directory. Therefore boundary tests verify the host filesystem is unchanged,
not only the command's exit status. No single test is proof of all possible
isolation properties.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
C2C_REAL_CODEX=/absolute/path/to/codex pnpm exec vitest run tests/real-execution.test.ts
```

Real tests are opt-in, use synthetic temporary workspaces, and consume the
signed-in Codex account's model usage. They test filesystem/network boundaries,
real execution and continuation, MCP submission through local CLI review, and
a two-turn automatic coordinator session with a real Codex worker. They do not
simulate a ChatGPT web session: that final
acceptance check must be performed with the installed plugin in ChatGPT.
