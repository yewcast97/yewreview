# YewReview

A local agent that writes market research reports. One command starts a server on this machine and
opens a board in the browser: one conversation with the agent, and every row it has recorded, in one
SQLite database. The only things that leave the machine are the model calls and whatever the agent
fetches to answer you.

## Build and install

```sh
git clone <this repo> && cd yewreview && bun install
bun run install:cli    # engine wheel, one compiled binary, onto your PATH
yewreview claudecode   # from any directory
```

You need [`bun`](https://bun.sh) and [`uv`](https://docs.astral.sh/uv/) TO BUILD. The binary needs
neither: it carries the Claude Code CLI, opencode and a copy of uv. The first start installs the
measurement engine into `<var-dir>/venv` from PyPI — once, a few minutes.

`install:cli` puts the binary in `~/.local/bin` or a directory you name; `bun run build` stops at
`dist/yewreview`; updating is rebuilding. No release binaries exist: the build embeds host-shaped
executables, and the file is half a gigabyte. macOS on Apple silicon or Intel; Linux on x64 or
arm64, glibc or musl, also needing `bubblewrap` and `socat` or the shell refuses; Windows via WSL2.

## Running it

```sh
yewreview claudecode      # the Claude Agent SDK, on this machine's Claude login
yewreview opencode        # an `opencode serve` child, on the models you put in the pool
bun run dev claudecode    # from a checkout
```

Name the harness; there is no default. The two share the database and the measurement engine and
nothing else: different session, transcript, models, prompt. Data lives at `~/.yewreview` for the
installed binary and `./var` in a checkout; `--var-dir` (or `YEWREVIEW_VAR_DIR`) overrides both and
is the whole of what makes a second instance. Deleting that root is a complete reset.

Credentials resolve the way Claude Code's do: this machine's Claude login, or `ANTHROPIC_API_KEY` if
you bill against the API (`claude setup-token` if you have never logged in). An **empty**
`ANTHROPIC_API_KEY` is the one thing that breaks it — it shadows the login rather than falling
through. Unset it, do not blank it. `yewreview --help` lists the flags; settings go in `.env`.

## What it does

- **Measures theses.** `vendor/seikan` is a Python measurement engine, vendored here, built into a
  wheel and installed read-only into a sandboxed venv; YewReview never imports it, it runs it
  confined. State a thesis mechanically — an entry condition, a horizon in bars — and each declared
  parameter and horizon cell is measured over the full sample, non-firing combinations included.
- **Reports; does not judge.** The engine crowns no best cell and returns no verdict; its per-cell
  checklist is a completeness and support check with no significance claim, and exit 0 says only
  that the run finished. The agent walks every cell in declaration order.
- **Writes reports to recipes you settle.** A recipe is the specification a report is written to;
  its text never changes once stored. A report is one HTML document with charts, pinned to that
  recipe and to every script it ran; its chart library is served by this machine, or inlined.
- **Immutable rows, witnessed deletions, appending ledgers.** Reports, script source, recipes and
  assessments are guarded by `BEFORE UPDATE` triggers; a correction is a deletion plus a fresh
  recording, the vanished row written to `deletion_log`. A thesis's standing is its newest row.
- **Records what it ran, and only tools record.** While a report is written the agent's own shell is
  denied and three run tools are the only door, each writing its row before and after the command;
  every other writing tool is frozen. Every record is a tool call, made after you have seen the row.

## What to be careful with

**Never name anything `SEIKAN_*`** — settings, environment variables, `sources.auth_env` values. The
engine owns that namespace and refuses to run on an entry it does not recognise, reported as a
threshold problem, which is not what it is. YewReview scrubs the namespace at boot.

**A second process on one var root is read-only.** The first to boot holds the writer lock for its
whole life; every later one warns, serves the archive for reading and refuses every write. There is
no promotion: restart it, or give it its own `--var-dir`.

**There is no migration ladder.** The schema stamps SQLite's `application_id` and a version, so a
database this build did not write — your own included, after a schema change — is refused at startup
rather than migrated. Move it aside and start fresh.

**Provenance is observed, and stops where observing does.** Witnessed: the machine-written run log,
immutable script source, and confinement (Seatbelt or bubblewrap) permitting writes only in the
agent's home, never degrading to unconfined; the network is open by design. Taken on the agent's
word: which script produced a CSV, and every quoted sentence. `docs/data.md` draws that line.

## Development

```sh
bun test                                          # the TypeScript suite
bun run typecheck                                 # both projects; some locks are compile-time only
bun run dev claudecode --no-browser --port 8788   # run from a checkout
bun run test:seikan && bun run lint:seikan        # the engine's own pytest and ruff (`uv` needed)
bun run typecheck:seikan                          # its mypy --strict, kept out of `typecheck`
```

Once it is running, ask the agent for the details. It knows its own tools, records and rules.
