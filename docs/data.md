# Where data lives, and what is true of it

Everything YewReview keeps at runtime lives under one root — `var/`, or wherever `YEWREVIEW_VAR_DIR` /
`--var-dir` points. It is not in version control. A second installation is a second root and
nothing else: no global state, no files in a home directory, nothing to collide over.

```
var/
├── db/yewreview.sqlite    the ledger (WAL mode, so expect -wal and -shm beside it)
├── reports/assets/        the chart library published reports load from
├── home/                  the agent's own directory — downloads, working files, scratch
├── venv/                  the sandbox Python environment (the measurement engine)
├── cache/                 extracted resources, and compiled engine kernels
├── claudecode/            the claudecode harness's own: the CLI config dir, and its transcripts
├── opencode/              the opencode harness's own: its config, model pool and state
└── tmp/                   scratch that does not survive a restart
```

Each harness keeps its state in a directory of its own, and both are created whichever one is
running: an empty directory costs nothing, and a branch would be a second place that knows which
harness this is. What that buys is that `rm -rf var/` is a COMPLETE reset — including the
conversations, which used to live in the machine's `~/.claude` and outlive every reset that claimed
to be total.

**One root has one writer.** The first process to boot on a var root claims it — `BEGIN IMMEDIATE`
held on `db/writer.lock.db` for the process's life, released by the kernel however the process
ends — and every later process on the same root runs READ-ONLY for its whole life: its connection
is opened with SQLite's own read-only flag, every tool that is not read-only refuses with a
sentence naming the way out, and the three HTTP routes that write var files refuse too. There is
no promotion; a reader that should write is restarted after the writer exits. Authority is the
PROCESS's — every tool call from anywhere in its tree, subagents included, runs in the one server
process — so a subagent writes with exactly the main agent's pen. `db/writer.json` beside the lock
names the holder for banners, and decides nothing (`src/db/lock.ts`).

**A script is not a file, and neither is a report.** Both are columns in the database: a script's
program is written by `create_script` and read back by `get_script`, and a report's HTML is stored
by `publish_report` and served out of its own row at `/reports/<id>`. That leaves no tree holding
durable content the agent produced at all — a CSV a script writes is a working file in `home/` — and
`reports/assets/` as a directory only because a served document links a chart library, and a library
is a file the browser fetches.

**There is one home, because there is one conversation.** A directory per specification —
`recipes/<id>/`, with a recipe owning a session — would quietly decide two things it has no business
deciding: that a piece of work could not span two recipes, and that deleting one deleted files
nobody had called disposable. A recipe is a record, not a place: a name, the specification itself,
and the reports published under it. Deleting one takes rows and only rows — its reports among them,
deliberately — because nothing on disk is its. The same path is also the SDK's project key, which is
why there is exactly one of it and no setting to move it.

**Three things are deliberately absent.** There is no data directory, and no column anywhere stores a
file path: where a CSV sits is an argument to a run, not a fact about a thesis. There is no run
archive for its own sake: a command run outside a generation procedure writes nothing this database
keeps, and one run inside a procedure is kept as part of the publication it belongs to — beyond the
engine's own report, copied verbatim onto the assessment it produced. And there is no conversation
store — not a table, not a file, nothing.

**Nothing here writes down what was said.** There is no `message` table and nothing standing in for
one. The transcript lives in whichever harness's own store — `var/claudecode/projects/` for the
Claude Agent SDK, filed under the agent's home directory; the opencode child's state directory for
the other — and YewReview reads it through one seam (`src/server/sessions.ts`, implemented once per
harness) to draw a window. One conversation runs at a time; the ones this installation has already
had are listed and resumable by id; the store names them itself and compacts one that has grown too
long to send, which the window is told about rather than left to notice. An old one can be deleted
outright — dragged onto the Bin, or `DELETE /api/sessions/:id` — and **no ledger witnesses it**: the
deletion log holds records, and what was said was never one. The conversation the agent is in is
refused, because deleting the transcript being written into is not a state anything can be left in.
What that costs is everything a table would have made easy: no SQL over what was said, no message to
address by id, no carrying an old answer into a new question as a chip. What it buys is the one
thing two writers can never have — what the model remembers and what the user is shown are a single
artefact, so they cannot drift apart. A table's whole job would be to try, and it could only ever be
an optimistic copy.

## Fourteen tables, and three of them are not records

The schema creates fourteen. The file carries SQLite's `application_id` and `user_version = 1`, and
one stamped with anything else is refused at startup rather than upgraded, whatever it claims to be,
since there is no migration ladder and never will be. Eleven of the fourteen ADDRESS A RECORD — a
row with an identity, a label and a place in the browser. One is a junction (`regime`), and a
junction row is an EDGE: its whole content is the two ends it joins, so it is drawn on both of them
and cannot be opened on its own. The last two are logs, and they are the rest of this section.

No table holds a conversation, and none holds writing on its way to becoming a record. The harness
holds the transcript. The three rows the user authors — a recipe, an information source, a thesis's
claim — are drafted IN the conversation, rendered in a reply, argued with, rendered again, and become
rows only when the agent writes one on their word, so there is still nothing on the server for a
model and a person to have their hands on at once.

**`recipe` is one table where two used to be, and the pair it replaced is worth naming.** A recipe is
the report specification — what a report written to it must be, for whom, how often, what it must
contain — and every published report is written under exactly one. Instructions used to live in a
`playbook` table hung off a `workshop`, appended version by version, with the operative version
derived as the newest row and each report naming the version that wrote it. Two tables and a counter
were carrying one idea: that no report is ever left pointing at text that changed underneath it.
IMMUTABILITY BUYS THAT OUTRIGHT. A recipe's specification is fixed the moment it is stored —
`recipe_moves_only_its_status` guards its id, its content and its creation — and what moves afterwards
is its name and its `status`, which is `active` or `inactive` and is born active. So there is no
version column, no append-only lineage of instructions, and no "which one is in force" to derive from
a MAX(): a method that has moved on is a NEW recipe with the old one set inactive, which keeps its
text and every report published under it while the generation gate refuses to open a procedure there.
Nothing new is written to a retired specification, and that refusal is the whole point of the status.

**`information_source.hosts`** is a JSON array of the hostnames a source publishes at, and it is
ADVISORY. It used to be enforced: publishing matched every cited url's hostname against it, and that
check went with the citations themselves (see "Provenance" below). What the column is now is the
reader's own note of where a source publishes, for the agent to read while working.

One column does a different kind of work.

**`name` is on every one of the eleven record tables, and it is how a row is ADDRESSED.** It is a
condensed summary of what the row holds — `nvda-q3`, `margin-expansion`, `sec-gov-filings` — minted
when the row is written from a hint the writer supplies, as the bare slug of that hint, with four
random base36 characters appended only when the plain form is already taken. It is unique WITHIN its
table and nowhere wider: one UNIQUE index per table is the whole guarantee, and two tables holding a
row of the same name is not a collision, because a name is only ever read alongside the table it
belongs to.

It is drawn everywhere — in the graph, on a card, on a chip dragged into the conversation — and it
travels: a mention on the wire is `@table:name`, and `resolveRecordId` in `repo/naming.ts` turns the
pair back into an id for a tool, so every `*_id` argument accepts either. Ids did not go away and
are what every tool RESULT hands back, because an id survives a rename and a name does not.

It is also the one mutable column on rows that are otherwise frozen, which is why the immutability
triggers are written `BEFORE UPDATE OF <every other column>` rather than `BEFORE UPDATE`. A rename
never mentions a column that carries meaning, so it never wakes them; SQL written by hand that
touches one still aborts.

**`target.name` is the exemption, and it is the exception that shows the shape of the rule.** Every
other name here is ours — a line we composed for our own convenience, and the reader's to recompose.
A company's registered name is not: it is a fact somebody looked up, reports have been published
citing it, and quietly relabelling it would rewrite what those reports appear to be about. So it is
required when a ticker is first recorded, never minted, and never edited — `renameRecord` refuses
the table outright and `target_name_is_immutable` says the same to anything that reaches the
database another way. A wrong one is corrected by deleting the target and recording it again, which
the deletion log witnesses.

**The archive forgets nothing, so two tables are allowed to.** `error_log` holds what went wrong —
scope (`http`, `turn`, `generation`, `tool`, `run`), the sentence the failing layer already had, and
whatever structured detail it was holding. `deletion_log` holds what left: the table, the row's own
key, and the WHOLE VANISHED ROW as JSON, document columns and all. That last one is the point. The
archive is a record of what exists and by construction says nothing about anything else, so once a
row is removed this is the only copy of it that will ever exist.

Each log keeps the newest thousand rows and prunes the rest in the same statement that inserts, which
is the one property no record in this file is allowed to have. A log nobody prunes eventually becomes
the largest thing in the database, and the thousandth-newest failure has never once been the one
somebody was looking for.

**Neither table carries a foreign key anywhere, and that is a property rather than an oversight.** A
log row is written ABOUT something, most often about that thing ceasing to exist, so a key pointing
at it could only either block the deletion being recorded or cascade away the record of it. For the
same reason there is no `recipe_id`-shaped column: what a log row names, it names in prose or in
JSON, where nothing enforces that the subject still stands.

**Only the row actually deleted is logged, never the rows a cascade took with it.** Deleting a recipe
takes every report published under it and every part of those publications — three reports is
something like twenty rows across four tables — and exactly one entry is filed: the recipe's own row,
its whole specification inside it. A cascade is the schema's consequence of one act, not twenty more
acts, and logging the children would describe the database's plumbing where this log is meant to
describe a decision. It would also cost the most in the one place cost bites, since a report's
document rides whole in `row_json` and this table keeps a thousand rows.

Both sit outside the record browser structurally, not by anybody remembering: `repo/records.ts` lists
them in `LOG_TABLES` rather than `RECORD_TABLES`, so they have no cards, no ids on the wire and no
edges to walk, and `GET /api/logs` is the only door into either. That list is what makes the
separation structural, and the reason for it is that a log is writing that must never be revised.
What is NOT in the error log is as deliberate as what is: a refusal is an answer, not a failure, so
the model asking for something it may not have and being told so in a sentence is never filed. Six
real defects a month buried under a thousand ordinary conversations would be a log nobody reads.

## The rules

**No column is a path.** Not a relative one either. A schema describing a data tree — a row per CSV,
naming where it sat and hashing its bytes — would need rules about resolving, containing and
re-hashing those paths to keep that description honest, and it would still be describing an
afternoon's filesystem. What a measurement rests on is stated as the pair that would produce it
again, which is a thing that stays true when a file is moved, re-pulled or deleted.

**Resolve, then check containment.** This holds where a path does arrive from outside — the HTML the
agent wrote and asks to publish, a CSV it hands the engine. It is resolved to a real location
*before* it is compared against the home directory it is supposed to be inside, so `..` and symlinks
are judged by where they point rather than by how they are spelled.

**Refuse, never repair.** A CSV violating the strict contract is refused with the engine's own
message. Nothing is coerced, back-filled, re-indexed or rounded into acceptability — the file is
wrong, and the script that produced it is what gets fixed.

**A thesis names its series and locates none of them.** `data.targets` is a list of keys and the
engine is told which file each key is at invocation, so the identity hash covers the question rather
than the afternoon's filesystem, and the same exam re-runs against re-pulled data without becoming a
different exam.

## Provenance, stated honestly

Two kinds of row carry it, one column names what a report was written to, and this section is mostly
a story about what was TAKEN OUT.

**What used to be here and is gone: the citations, and the applied readings.** A report carried a
`reference` per source it said it had drawn on — an address, the source it attributed that address
to, and the sentence it said it read there — and an `application` per thesis assessment it said its
argument stood on. Both were written by the agent, in the publishing transaction, and both tables
were deleted.

The reason is worth keeping rather than the tables. Nothing ever fetched a cited page. Nothing
compared a quoted sentence against one. Two things WERE checked and both were fatal to the
publication — the anchor really appeared in the published bytes, and the url's hostname was one the
named source's own `hosts` list claimed — but read carefully, those bought only that a report was
INTERNALLY CONSISTENT ABOUT WHO SAID WHAT. The agent wrote the `hosts` list itself, so a mistake
about where a company publishes was a mistake in both halves at once; the quoted sentence was the
agent's copy of what it said it read, and this database had never seen the page, so it could not
tell a paraphrase from a quotation or an invention from either. A row that looks like evidence and
is not is worse than no row, because every reader of the schema comes away believing something was
witnessed. So the honest move was to stop recording the claim at all, and nothing here records it.

Two guards went with them, and their absence is a decision rather than an oversight: **a thesis and
an information source can now be deleted whatever has been written near them.** Nothing points at
either from a report any more. A published document is immutable, so what it said about a thesis it
goes on saying; what deleting one costs is the ability to look the measurement up, not the integrity
of anything already published. The deletion log holds the whole vanished row, as always.

**A report names the exact recipe that produced it, and that reference cannot rot.** A recipe's text
is immutable, so naming the row names the bytes: the instructions a report was written to are
byte-for-byte the ones it goes on naming, for as long as both rows stand. That is where a check used
to live and no longer does. Publishing once re-read the operative playbook version and refused when
the head had moved since the procedure opened — the version ledger paying for itself, honestly, at
the price of a second identifier to carry and a race to describe. There is nothing left to re-read
and no revision for a report to have been overtaken by, so `publish_report` does not look. A
simplification that removes a guard is usually a loss; this one removed the condition the guard was
watching for. What a published report is recorded against, then, is two things: the recipe it was
written to, and any script it records running.

**What is left is what a machine watched happen.** `script_invocation`, `seikan_invocation` and
`trivial_shell_history_for_report` hang off a report and are not declarations at all: they are
written from the log the generation procedure kept while the report was being produced. A report
that names a run nobody logged is what those three tables exist to make impossible, and the model is
never asked what it did — `publish_report` takes no argument about its own work.

Three tables because there are three questions worth asking of a procedure: which stored program
ran, which measurements were taken, and what else the shell was asked to do. Which table a command
lands in is decided by the TOOL that spawned it, never by the model afterwards — `seikan_invocation`
carries a name an earlier design also used, for a table that recorded a hand-built account of what
the engine was ASKED. That one was deleted for being a description of a request; this one is the
line that ran.

Each row carries the moment the command STARTED, how long it took, the code it exited with, and what
it printed. A failed command is recorded exactly as carefully as a successful one; a record that
kept only the runs that worked would read as a straight line through work that was not one. The
output is kept head-and-tail with the omission named where it happened, except in
`seikan_invocation`, where it is the engine's own report and is kept WHOLE — a measurement report is
a document, and a clipped one is not a smaller version of it but a broken one. That is not a flag a
caller sets: it follows from the run being a measurement.

The log is written in two phases, which closes a real gap rather than being tidiness: an entry is
opened when a command is spawned and completed when it exits, and publishing is refused while any
entry is still open. Without that, a model could publish in the window between starting a long
command and its finishing, and the report's account of its own procedure would be missing exactly
the expensive run somebody would want to see.

**`series_preparation`** hangs off an assessment: for each series that round was measured over, the
script that produced it and the argument that run was given. It is a DECLARATION and immutable, and
it deliberately does not say where the file went — a location is a fact about one machine on one
afternoon, while a script and an argument are a thing somebody else can run.

**Scripts are global.** They belong to the installation, not to any recipe; deleting a recipe takes
its reports and touches no script. A program is a program whoever wrote it, and two conversations
keeping their own copy of one price fetcher is duplication wearing the costume of independence. A
script a published report records running cannot be deleted while that report stands — the last
refusal of that shape, and the one that survives because it is about a program whose bytes the
archive actually holds.

**Retiring a script is also how it stops being used.** `inactive` takes nothing away — the
invocations stand, the preparations that named it stand, the program itself is still stored and still
explains the numbers it produced — and `run_script` REFUSES an inactive script, so a method somebody
superseded does not go on quietly producing numbers a later reader would take for current. Retiring
used to free only the program-identity, which left the retired half of a replacement runnable by
anything that still held its id. What retiring still is not is a deletion: the record stays whole,
where deleting takes the program away with the row.

The enforced half of all this is the program: a script's source is a column of its row, immutable
under a trigger, so `get_script` returns exactly the bytes that were recorded and nothing — not the
agent, not a later revision of the method, not this program itself — can make a recorded script
drift away from the runs recorded against it. What is NOT proven is that the bytes a script wrote
are the bytes the engine then read. Inside a generation procedure the gap is narrow: the shell has
exactly one door and it is the one that writes these rows, so a command that ran and left no row is
a command that was refused rather than a gap in the record. Outside a procedure nothing observes a
run at all, and nothing needs to — there is no report for it to be part of. This file is where that
is written down instead of implied.

An assessment carries one more thing: the engine's own report for the run it was read off, stored
verbatim. That is what makes "we called this insightful in March" checkable years later against the
numbers rather than against the memory of them.

## Who holds the pen

**The agent writes every record, and mostly asks nobody.** All eleven record tables are written
through tools; for eight of them there is no approval step and no queue of proposed findings. That is
a decision rather than an absence of restraint: what the agent writes there is its own account of
what it did, and a queue of proposed findings is a conversation with extra ceremony. There is no
drafting apparatus behind it either — no draft tables, no lease store, no verifier.

**Three rows are not its account of anything, and those are the user's.** A `recipe` is the
specification they are commissioning work against, the one document here that says what they want.
Instructions used to arrive carrying a preset: five numbered lines this repository wrote, sitting in
the place a person's own specification belongs and read as theirs. The answer then was that a
workshop is born with NONE, an empty place where the preset had been. With the workshop gone the
question does not arise in that shape at all: a specification nobody has dictated is simply a row
that is not there, and a generation opens under a recipe somebody stored or does not open.

An `information_source` is their standing account of where their numbers come from. A `thesis` is
their claim about the market in their own words, and it splits along this line rather than sitting on
one side of it: what the thesis CLAIMS is theirs and is agreed, while how it READS once the engine
has measured it is this surface's own judgement and asks nobody. A thesis is also **born measured**:
`create_thesis` files the first round of the ledger with the container, in one transaction, against
a run of the exact document being stored — verified by the engine's canonical hash, since the run
was made before anything existed for an id to name. The seam holds through that one act: the first
reading is shown beside the draft, and consent is to the storing, never to the tag. A thesis with an
empty ledger is simply a readable state, not one this surface mints. The first two used to be
written from browser forms and are now written from the same tool surface as everything else, under
one rule that is stated on each of those tools rather than only in a prompt: **the whole of what is
about to be stored is rendered in the conversation first, and the user says afterwards that it is
what they want.** A message that merely opens the subject — including the line the window says on
the reader's behalf when somebody presses `+` — authorises nothing.

It is rendered in one fixed grammar, the **row block**: a `~~~row` fence holding the table name at
the margin, each field name indented under it, its value indented again, and `****` on any field not
filled in yet. The window parses that and draws a card (`web/src/lib/rowBlock.ts`). The grammar is
worth the coupling for one reason, which is the `****`: laid out freehand, a field the agent had not
settled could be a heading with nothing under it, a sentence apologising for the gap, or a line
simply absent, and the user was left inferring which parts of the row were still open from the prose
around it. What makes the convention safe to depend on is its failure mode — a fence the window
cannot parse keeps the ordinary code-block chrome, so a forgotten grammar shows the outline exactly
as it was typed rather than losing it.

The form was never what protected them, which is why moving the pen costs less than it reads. A
button is one click away wherever it sits, and a form let somebody press Save on text nobody had read
out loud. What holds is that the change is SHOWN and AGREED, and that the archive keeps both halves
afterwards. Every rule about what a specification and an entry ARE is still one layer down in the
repositories, where neither a route nor a tool can reach past it.

**What keeps it honest is not permission but the archive.** The immutable cores hold without
exception: a recipe's specification is fixed and only its standing moves, a published report and
everything it declared are immutable, a thesis's statement and document are fixed and its judgement
is an append-only ledger, and a script's program cannot be rewritten. So "editing" an immutable
record means DELETING IT AND RECORDING IT AFRESH, in the open — which for most of them anything still
standing on the row refuses until that is dealt with, which for a recipe means its reports leaving
with it, and which the deletion log witnesses with the whole vanished row either way. Which is
exactly why the ordinary answer for a recipe or a script is not deletion at all but `inactive`: the
row stays, everything recorded against it stays, and only what may happen NEXT changes. Authority is
broad; nothing it does is quiet.

**The browser writes nothing to the database.** Not a recipe, not a rename, not a deletion. The
`+` buttons and the bin send a MESSAGE — an ordinary user turn, visible in the transcript, saying
what the reader would like to start (`web/src/lib/awareness.ts`) — and the agent does the interview,
shows the draft and writes the row. EVERY ONE OF THEM SPEAKS INTO THE CONVERSATION ON SCREEN, and
there is one rule here where there were two. A creation `+` — a recipe, a source, a thesis, and now a
script — used to put the current conversation down through the clear route and open a fresh one to
say its opening line into, so that making a record would read afterwards as itself rather than as a
digression inside whatever else was being discussed. That was true about the session list and false
about the person, who was in the middle of something when they pressed the button and had the context
they were working in taken away; somebody raising a recipe while looking at a thesis is usually doing
ONE piece of work. So the report `+` and the bin are no longer the exceptions they looked like — what
made them exceptional was only that they are instructions about work already in front of the reader,
and that turns out to be the ordinary case rather than the special one. The window's remaining writes
touch no record: clearing or resuming a conversation decides which session the next turn belongs to,
which cannot be said inside a conversation without the sentence landing in the one being left;
retrying venv provisioning is operational, because the engine's absence is exactly the condition in
which the agent can fix nothing for you; an upload puts a dragged file where the agent can read it;
and the opencode model pool is a config file rather than a table. Generating a report was on this
list too, as the one write the window held and the agent did not; it is asked for in the
conversation now like everything else.

**Starting a generation stopped being the write the agent may not make.** It was, and the reasoning
was that `publish_report` exists only inside a procedure, so an agent able to open one would always
open one first and the rule would mean nothing. What actually holds a report's provenance up is
narrower than that and does not depend on where the request came from: publishing takes no account
of the model's own work, the rows naming what produced the numbers are written from a log the machine
kept while the procedure was open, the recipe it works to is named when it opens and cannot be edited
afterwards, and — this is what was added when the button went — every other tool that writes a record
is REFUSED for the duration, so the archive the report is read against cannot move underneath it. An
inactive recipe is refused a procedure at the same door. The agent opens a procedure with
`start_generation` when it is asked for a report; stopping one is interrupting the turn it rides,
which is the same gesture that stops anything else.

**A record's own name is the user's, and it is the smallest write in the archive.** `rename_record`
moves `name` and nothing else — not on a `target`, whose name is the instrument's official one and is
refused.

**Deleting is guarded by what stands on a thing, not by who asked.** One thing a published report
holds down, and it holds it against either party, because the refusal is about a document being left
pointing at nothing: a script it records running. The remedy is what it always was — deal with the
reports first.

**The specification is the one that goes the other way, and the reversal is the point.** A report
used to hold down the playbook version it named, on exactly the reasoning above. `report.recipe_id`
CASCADES, so deleting a recipe takes every report published under it — the documents themselves,
since a report IS a row here — and every part of those publications with it. That is the meaning of
the act rather than an accident of a key: a report whose specification is gone is a document nothing
can say the terms of, and leaving it standing would be keeping the answer while throwing away the
question. It is also why `delete_recipe` counts the reports and says the number out loud before it
asks, and why the move for a specification that has merely been superseded is `inactive`, which keeps
every one of them readable.

The list was longer before that as well. A thesis and a source were held down too, by the readings a
report said it applied and the addresses it said it had read; those tables were deleted, so both
delete freely now. What is left is what the archive can actually prove it is holding: a script's
program is a document this database stores, and a recipe's specification is another — which is why
the recipe's deletion is loud rather than refused.

## What the sandbox permits

The agent's Bash runs under the operating system's own sandbox (Seatbelt on macOS, bubblewrap on
Linux). It may write in its own home directory and in `var/tmp`, and nowhere else. It may not write
to `db/`, `venv/` or `reports/` — each is somewhere a write would break a record rather than produce
one. `reports/` holds the chart library rather than the documents, which if anything makes it
more sensitive: an agent that can edit `echarts.min.js` can script every report ever published. The
SDK's own `Write` and `Edit` tools do not pass through the OS sandbox, so a pre-tool hook enforces
the same boundary for them.

**While a generation procedure is running, that shell is closed entirely.** Not the engine
specially and not the interpreter specially — every command, `ls` included. The same hook denies
them all, and `run_shell` is the shell for the duration: `/bin/sh` in the same home directory under
the same confinement, with the command and its outcome written into the procedure's log. The guard
used to be a string match for the engine binary and the venv path, and it was documented as
best-effort because a copied interpreter walked straight past it. A report that records every
command needs a door rather than a watchman, so it has one.

The network is not restricted. Research means fetching from places nobody enumerated in advance,
and an allow-list the agent can request additions to is an allow-list in name only. What the
sandbox bounds is the blast radius of a write; what a number came out of is what the three run tables
are for.

## The measurement engine

`vendor/seikan` is built into a wheel and installed read-only into `var/venv`. YewReview never imports
it — it spawns `var/venv/bin/seikan` as a subprocess, and so does the agent. The engine's own DSL
guide is read out of the *installed package* for the system prompt, so the instructions cannot
drift away from the engine they describe.

An unavailable engine degrades YewReview rather than stopping it: an agent that cannot measure a thesis
can still research, write and publish, and it has been told to say plainly that measurement is
unavailable rather than describe numbers it could not compute. The one condition that stops YewReview
from starting is a database it cannot read, because the alternative is writing into a file whose
shape it guessed.
