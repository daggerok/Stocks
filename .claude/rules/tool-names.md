# Tool names are case-sensitive

Agents (including subagents and forked workers) keep calling `bash` and getting
`Error: No such tool available: bash. Tool names are case-sensitive: call Bash instead`.
Use the exact names:

- `Bash`, `Read`, `Write`, `Edit`, `Agent`, `Skill`, `ToolSearch` - capitalized, never `bash`, `read`, `edit`
- Deferred tools (`Monitor`, `SendMessage`, `TaskStop`, `WebFetch`) must be loaded with
  `ToolSearch("select:<Name>")` before the first call, otherwise the call fails with an input validation error
- A long command goes to `Bash` with `run_in_background: true`; to wait for it, use one `Bash`
  call with an `until` loop (one notification) or `Monitor`, never repeated polling
- Prefer the dedicated tools over shell: `Read` instead of `cat`/`head`, `Edit` instead of `sed -i`

When you write a prompt for a subagent, include one line: "Tool names are case-sensitive: `Bash`,
`Read`, `Write`, `Edit`".

**Why:** the owner saw the same `No such tool available: bash` error repeated many times in
parallel agent runs and asked for a permanent fix in `.claude/` (2026-10-03).

**How to apply:** check the tool name before the first call of a session or a subagent; on this
error fix the name once and do not retry the lowercase form.
