/**
 * Schema v1 — the whole database, in one statement list, applied once.
 *
 * There is no migration ladder and no migration table. This build claims its files with SQLite's
 * `application_id` header field and stamps `user_version = 1`; a file carrying anything else is
 * REFUSED rather than upgraded (see `open.ts`), whatever it claims to be. A migration nobody needs
 * is a second definition of every table it touches, and an unstamped file that happens to parse is
 * somebody else's data.
 *
 * Three ideas run through the whole of it.
 *
 * **A record is immutable, and judgement is a ledger.** A thesis is a container: its statement,
 * document and identity are fixed at creation and NOTHING about the row moves. What a thesis is
 * currently worth is not a column on it but the newest row of `thesis_assessment` — each one a tag,
 * the reasoning behind it, and the measurement it was read off, filed once and never edited. So a
 * re-reading adds to the record instead of overwriting it, and "what did we think of this in March"
 * is a question the database can answer. A script's program is likewise fixed and only its status
 * moves, and a recipe is the same shape: its text is fixed and only its status moves, so a method
 * that has changed is a NEW recipe with the old one set inactive rather than an edit that rewrites
 * what every report standing under it was written to. A published report does not change at all.
 * `abandoned` is a terminus: it is the LAST row a
 * thesis's ledger can take, because reviving one would put runs recorded before and after its
 * absence under a single identity as if nothing had ended.
 *
 * **A publication is one act, and its record is machine-written — ENTIRELY machine-written.** The
 * report and every command that produced it are written in a single transaction, and they leave
 * together or not at all. There are three kinds of command and all three are recorded: a run of a
 * stored script (`script_invocation`, naming the program), a run of the measurement engine
 * (`seikan_invocation`, whose output is the one thing this file keeps whole), and everything else
 * the shell was asked to do (`trivial_shell_history_for_report`, naming the command line). None is
 * a caller's summary of what it did. All three are written from the log a generation procedure
 * keeps while it runs, and all three carry what actually happened — the moment it started, how long
 * it took, the code it exited with, and what it printed.
 *
 * That last column is the change those two tables left in. A report used also to carry the
 * model's ACCOUNT of what it stood on — which readings it applied and which sentences it quoted
 * from where — and those two tables are gone. Nothing verified them; a citation was a claim about
 * the world that this database recorded as though it were a fact about the archive. What is left
 * is only what a machine observed: these commands ran, this is what they said. Less is claimed,
 * and all of it is true.
 *
 * **What is written stays written, and no column LOCATES anything.** A script's program and a
 * report's document live in this file, as columns, immutable with the rows that hold them — bytes
 * that cannot drift from the record describing them, because they ARE the record. No column exists
 * to say where bytes live: where a CSV sits is an argument to a run, not a fact about a thesis, so a
 * series is described by the script and argument that PREPARED it (`series_preparation`) rather than
 * by where it landed. The recorded shell history is not an exception to that and is worth being
 * exact about: `command` holds a command line and a command line often contains paths, the same way
 * any quoted prose might. It is stored as the TEXT OF WHAT RAN. Nothing resolves it, joins on it, or
 * reads it back as a location — which is the property the rule was always about. Scripts are
 * GLOBAL — a program is a program whoever wrote it, and two copies of one fetcher in two
 * conversations is a mistake, not independence — which is why they belong to the installation and
 * to nothing narrower. So are theses, sources and instruments: the only thing a report belongs to
 * is the recipe that specified it.
 *
 * **Every record has ONE name, and it is the one thing that moves.** The eleven record tables each
 * open with `name`: a short human-readable line, a condensed summary of what the row holds, unique
 * WITHIN ITS TABLE and nowhere wider. It is the tag the window draws, the word a reader uses to ask
 * for a row, and the one mutable column on rows this file otherwise freezes — which is why the
 * immutability triggers below are written `BEFORE UPDATE OF <every other column>` rather than
 * `BEFORE UPDATE`: a rename never mentions the columns that carry meaning, so it never wakes them,
 * and hand-written SQL that touches one still aborts. `repo/naming.ts` mints these and is the only
 * place one is written. A UNIQUE index per table is the whole of the guarantee; two tables may hold
 * the same name, because a name is only ever read alongside the table it belongs to. The junctions
 * and the two logs do not carry it: a junction has no identity of its own and a log row is not a
 * record.
 *
 * `target.name` is the exemption and the exception proves the shape of the rule. It is the
 * instrument's OFFICIAL FULL NAME — supplied by whoever records the target, never minted, never
 * shortened — and it is immutable, because unlike every other name here it is a claim about the
 * world rather than a label for our own convenience. A wrong one is corrected by deleting the target
 * and recording it again.
 *
 * **Two tables here are not records, and are marked as such.** `error_log` and `deletion_log` are
 * LOGS: capped at a thousand rows each and pruned oldest-first, so they forget, which is the one
 * thing no record in this file is allowed to do. They answer two questions an audit cannot ask of
 * the archive itself — what went wrong, and what left — and the second is the reason the deletion
 * log holds the whole vanished row as JSON: a record's last act is disappearing, and the archive by
 * construction keeps nothing about that. Neither table carries a foreign key ANYWHERE, so a log row
 * outlives the thing it describes and never stands in the way of deleting one; that is not an
 * oversight to tidy up later but the property that makes the log safe to write. `repo/records.ts`
 * lists them in `LOG_TABLES` rather than `RECORD_TABLES`, which is what keeps them out of the record
 * browser structurally instead of by remembering: a log is writing that must never be revised, and
 * the browser is for the writing that is.
 *
 * Conventions:
 *   - every table is STRICT — a column that says INTEGER means it;
 *   - every timestamp is INTEGER epoch milliseconds UTC, never a string, never local;
 *   - ids are uuid4 hex TEXT, except where a natural key already exists (`target.ticker`) or where
 *     ordering is the point and the rowid already provides it (the two logs);
 *   - a rule worth stating in prose is worth a CHECK or a TRIGGER: the repositories check first so
 *     the message is readable, and the schema checks last so the rule is true of the database.
 */

export const APPLICATION_ID = 0x79657772; // 'yewr'
export const SCHEMA_VERSION = 1;

export const TABLES = [
  "deletion_log",
  "error_log",
  "information_source",
  "recipe",
  "regime",
  "report",
  "script",
  "script_invocation",
  "seikan_invocation",
  "series_preparation",
  "target",
  "thesis",
  "thesis_assessment",
  "trivial_shell_history_for_report",
] as const;

export const SCHEMA_V1 = /* sql */ `
CREATE TABLE information_source (
  name          TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  type          TEXT NOT NULL CHECK (type IN (
                  'issuer_primary','regulatory_government','trusted_data_vendor',
                  'sellside_research','buyside_public_disclosure','independent_research')),
  domain        TEXT NOT NULL,
  method        TEXT NOT NULL,
  -- WHERE THIS SOURCE PUBLISHES: a JSON array of lowercase hostnames, at least one.
  --
  -- ADVISORY, and it used to be enforced. Publishing once checked every cited url's hostname
  -- against this list and refused the whole report when an address was not on it — but the citations
  -- that check ran over were the model's own account of what it had read, and there is no longer
  -- such a table. What is left is what it always really was: the reader's own note of where this
  -- source publishes, for the agent to read while working and for a person to read afterwards.
  hosts         TEXT NOT NULL CHECK (json_valid(hosts) AND json_type(hosts) = 'array'
                                     AND json_array_length(hosts) >= 1),
  failure_cases TEXT,
  -- The NAME of an environment variable holding a credential. Never the value: a database that
  -- holds secrets is a database that leaks them.
  auth_env      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_information_source_type ON information_source(type);

-- THE TYPE IS EDITABLE ON A STANDING ROW. The type is how far this source sits from the fact, and
-- everything written while trusting it was weighed against that distance — so reclassifying a
-- standing row does re-weigh every report that drew on it. Freezing it at creation would only mean
-- deleting a row and dictating six fields again to correct a typo, which protects nothing: what
-- keeps the change honest is that the user has to ask for it in the conversation and the agent has
-- to say back what it is about to do. There is no guard on deleting a source either: no report
-- points at one, so it can be deleted whatever has been written near it, and the deletion log is
-- the only witness.

-- The instrument the numbers are about. Its \`name\` is the exemption described in the header: the
-- OFFICIAL FULL NAME, recorded verbatim and never edited afterwards.
CREATE TABLE target (
  name     TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  ticker   TEXT PRIMARY KEY,
  market   TEXT,
  -- What one step of this instrument's own series MEANS ("dollar", "percent"). A display fact for
  -- chart commensurability; NULL is "unknown", never "same as its neighbour".
  unit     TEXT,
  added_at INTEGER NOT NULL
) STRICT;

-- The one name in this database that does not move. Every other name here is ours — a convenience
-- for addressing a row, and the user's to reword whenever a better line occurs to them. A company's
-- registered name is not ours: it is a fact somebody looked up, reports have been published citing
-- it, and quietly relabelling it would rewrite what those reports appear to be about. Correcting a
-- wrong one is deleting the target and recording it again, which the deletion log witnesses.
CREATE TRIGGER target_name_is_immutable
BEFORE UPDATE OF name ON target
BEGIN
  SELECT RAISE(ABORT,
    'a target''s name is the instrument''s official name and is never edited; delete the target and record it again under the right name');
END;

-- A RECIPE is a report specification: what kind of report gets written to it, for whom, how often,
-- what it must contain. It owns neither a conversation nor a directory — the conversation is global
-- and its transcript belongs to the harness's own session store — and a piece of research that
-- wants to work to two recipes at once is ordinary rather than impossible.
--
-- IT IS THE SHAPE OF A SCRIPT, AND FOR THE SAME REASON. Its text is fixed at creation and only its
-- status moves, because a recipe is what reports were written TO: an editable one would let a
-- report's stated provenance drift away from the instructions that actually produced it, and the
-- report would go on naming a row whose words had changed underneath it. A method that has moved on
-- is a NEW recipe with the old one set \`inactive\`, which retires it without deleting either its
-- text or the reports written under it.
--
-- THE VERSION LEDGER THIS REPLACED IS WORTH NAMING. Instructions used to live in a \`playbook\` table
-- hung off a \`workshop\`, appended version by version, with the operative one derived as the newest
-- row. Two tables and a counter were carrying what one immutable row and a status carry here: a
-- reader had to hold a number in their head to tell two rows apart, "which one is in force" was a
-- MAX() rather than a column anybody could read, and the workshop above it owned nothing but a name.
-- What the ledger bought — that no report is left pointing at text that changed — immutability buys
-- outright.
CREATE TABLE recipe (
  name       TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL CHECK (content <> ''),
  -- Whether reports are still written to this specification. \`inactive\` retires it: the text stays,
  -- every report written under it stays, and the generation gate refuses to open a procedure there.
  status     TEXT NOT NULL CHECK (status IN ('active','inactive')),
  created_at INTEGER NOT NULL,
  -- The moment the status last moved. Nothing else about a recipe changes after it is stored.
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER recipe_is_not_born_inactive
BEFORE INSERT ON recipe
FOR EACH ROW
WHEN NEW.status = 'inactive'
BEGIN
  SELECT RAISE(ABORT,
    'a recipe is not born inactive; store it active and set it inactive once the method has moved on');
END;

-- Column-scoped exactly as the script's is: the status moves, the specification does not.
CREATE TRIGGER recipe_moves_only_its_status
BEFORE UPDATE OF id, content, created_at ON recipe
BEGIN
  SELECT RAISE(ABORT,
    'a recipe''s specification and identity are immutable; only its status moves — store the new specification as a new recipe and set this one inactive');
END;

-- A published report names the EXACT recipe that produced it. Because a recipe's text cannot be
-- edited, that reference cannot rot: the instructions a report names are byte-for-byte the ones it
-- was written to, for as long as both rows stand.
--
-- The document itself is here, as a column. There is no path and no digest, because there is
-- nothing left for a digest to be about: the bytes a reader is served ARE the bytes this row holds,
-- and the immutability trigger below is what keeps them the ones the record was written about. A
-- report is served by id, out of the database, and a published document has no filesystem life.
CREATE TABLE report (
  name       TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id         TEXT PRIMARY KEY,
  recipe_id  TEXT NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (title <> ''),
  content    TEXT NOT NULL CHECK (content <> ''),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_report_recipe ON report(recipe_id);

-- A published document does not change, and neither does the row describing it. Everything a
-- report declared it stood on was declared in the transaction that published it, so an amendable
-- title or document would let the record drift away from what a reader already has.
--
-- COLUMN-SCOPED, and every one of these triggers is written the same way: the list is every column
-- except \`name\`, so renaming a row never wakes it. The list is spelled out rather than the name
-- being excluded, because SQLite has no "all but" — which means a column added later is unguarded
-- until it is added here too.
CREATE TRIGGER reports_are_immutable
BEFORE UPDATE OF id, recipe_id, title, content, created_at ON report
BEGIN
  SELECT RAISE(ABORT,
    'a published report is immutable; publish a new report, or delete this one and its whole record with it');
END;

-- A thesis is a CONTAINER: the statement in words, and the DSL document that makes the statement
-- measurable. Nothing here is a judgement, so nothing here moves — what the thesis is currently
-- worth lives in its assessment ledger below, newest row first. Splitting the two is what lets a
-- thesis be re-read without being rewritten: the document every round is evidence ABOUT stays the
-- byte-for-byte thing it always was.
CREATE TABLE thesis (
  name       TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  dsl_json   TEXT NOT NULL,
  dsl_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- Every column that carries meaning, which here is every column but the name: with the tag and its
-- reasoning living in the assessment ledger, a thesis has no mutable part left. An editable document
-- would make every assessment recorded against it evidence about bytes the edit erased. A rename
-- mentions none of these, so it passes; anything else about the row still aborts.
CREATE TRIGGER thesis_is_immutable
BEFORE UPDATE OF id, content, dsl_json, dsl_hash, created_at ON thesis
BEGIN
  SELECT RAISE(ABORT,
    'a thesis''s statement, document and identity are immutable, and its judgement is a ledger of its own; record an assessment, or store a new thesis instead of editing this one');
END;

-- One round of judgement on a thesis: what it was read as, why, and the measurement that reading
-- came off. Append-only, so the ledger IS the history and re-reading a thesis costs nothing that
-- was already written down.
CREATE TABLE thesis_assessment (
  name          TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id            TEXT PRIMARY KEY,
  thesis_id     TEXT NOT NULL REFERENCES thesis(id) ON DELETE CASCADE,
  tag           TEXT NOT NULL CHECK (tag IN ('approven','insightful','abandoned')),
  -- The reasoning behind THIS tag. A tag with no argument behind it is a mood.
  assessment    TEXT NOT NULL CHECK (assessment <> ''),
  -- The engine's own report for the run this round was read off, kept verbatim. NOT NULL because an
  -- assessment with no measurement under it is an opinion: this column is what makes "we called it
  -- insightful in March" checkable years later, against the numbers rather than against the memory
  -- of them — and it is the reason a re-reading has to re-measure rather than re-word.
  seikan_report TEXT NOT NULL CHECK (seikan_report <> ''),
  created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_thesis_assessment_thesis ON thesis_assessment(thesis_id, created_at);

CREATE TRIGGER thesis_assessments_are_immutable
BEFORE UPDATE OF id, thesis_id, tag, assessment, seikan_report, created_at ON thesis_assessment
BEGIN
  SELECT RAISE(ABORT,
    'an assessment is a judgement made at a moment and is never edited; the next reading is a new assessment, and the ledger keeps both');
END;

-- 'abandoned' is a terminus, not a stage — and in a ledger that means it is the LAST row. Nothing is
-- filed after it, not even a better-worded abandonment: a revived thesis would put the runs recorded
-- before its abandonment and the runs recorded after under one identity, as if nothing had ended.
CREATE TRIGGER abandoned_theses_are_never_revived
BEFORE INSERT ON thesis_assessment
FOR EACH ROW
WHEN (SELECT ta.tag FROM thesis_assessment ta
       WHERE ta.thesis_id = NEW.thesis_id
       ORDER BY ta.created_at DESC, ta.rowid DESC LIMIT 1) = 'abandoned'
BEGIN
  SELECT RAISE(ABORT,
    'an abandoned thesis is never revived, and never re-judged: abandoning was its last assessment. Store the replacement as a new thesis');
END;

-- The ledger is read newest-first, and every rule above — what may still be filed, which assessment
-- a report is allowed to apply — is an answer to "what is the newest row". Deleting one from the
-- middle rewrites that answer by subtraction, and deleting a trailing 'abandoned' would revive the
-- thesis around the trigger that forbids exactly that. So an assessment leaves only with the thesis
-- it judges. The WHEN clause stands down during that cascade, on the report precedent below: a foreign
-- key action runs AFTER the parent row is gone.
CREATE TRIGGER thesis_assessments_leave_only_with_their_thesis
BEFORE DELETE ON thesis_assessment
WHEN EXISTS (SELECT 1 FROM thesis WHERE id = OLD.thesis_id)
BEGIN
  SELECT RAISE(ABORT,
    'assessments are a thesis''s history, read newest-first; they are deleted only with their thesis');
END;

-- The engine's own word: a thesis's targets are its REGIME — the conjunction it must hold across,
-- or the basket it ranks within; the measured instruments, never a search axis.
CREATE TABLE regime (
  thesis_id TEXT NOT NULL REFERENCES thesis(id) ON DELETE CASCADE,
  -- No ON DELETE: this is what blocks deleting a target some thesis still measures. A thesis whose
  -- target vanished would still name that ticker in its DSL.
  ticker    TEXT NOT NULL REFERENCES target(ticker),
  PRIMARY KEY (thesis_id, ticker)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_regime_ticker ON regime(ticker);

-- One row per script: what it is called, its purpose, and its program. The program is a column —
-- there is no path and no digest, because the bytes are not somewhere else to be checked against.
-- There is no version history and no editing: a rewritable script is a provenance that says whatever
-- it was rewritten to say. A script that has been superseded or has failed for good is set
-- 'inactive', which retires it without deleting either its program or the record of what it
-- prepared — and an inactive script is refused a run, because a retired method is not one to keep
-- quietly producing numbers.
--
-- Scripts are GLOBAL. A program is a program whoever wrote it, and two conversations independently
-- keeping their own copy of one price fetcher is duplication wearing the costume of independence.
CREATE TABLE script (
  name       TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id         TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source <> ''),
  status     TEXT NOT NULL CHECK (status IN ('active','inactive')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
-- Twin programs are what this one is about, and it is scoped to the scripts still running: the
-- archive may hold a retired program byte-for-byte identical to the one that replaced it. Names need
-- no partial index of their own — every script's name is unique across active and inactive alike,
-- which is a stronger rule and one index below already makes it true.
CREATE UNIQUE INDEX idx_script_active_source ON script(source) WHERE status = 'active';

CREATE TRIGGER script_is_not_born_inactive
BEFORE INSERT ON script
FOR EACH ROW
WHEN NEW.status = 'inactive'
BEGIN
  SELECT RAISE(ABORT,
    'a script is not born inactive; store it active and set it inactive once it is judged done with');
END;

-- Column-scoped, exactly as the recipe's is: the status moves, the program does not.
CREATE TRIGGER script_moves_only_its_status
BEFORE UPDATE OF id, domain, source, created_at ON script
BEGIN
  SELECT RAISE(ABORT,
    'a script''s program and identity are immutable; only its status moves — save the corrected program as a new script instead of editing this one');
END;

-- What produced the series an assessment's round was measured over: the script, and the argument it
-- was given. One row per prepared input, filed with the assessment in one transaction.
--
-- A CSV's PATH is an argument to a run, not a fact about a thesis — the engine is told where its
-- data is at invocation and the document never names a file — so what is worth recording is not
-- where the bytes landed but what would produce them again. That is honest about what it is: a
-- DECLARATION, stated as the pair that can be re-run rather than as a location that can go stale.
CREATE TABLE series_preparation (
  name                 TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id                   TEXT PRIMARY KEY,
  thesis_assessment_id TEXT NOT NULL REFERENCES thesis_assessment(id) ON DELETE CASCADE,
  script_id            TEXT NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  -- '' is an answer, not a missing value: a run that took no arguments is honestly recorded.
  argument             TEXT NOT NULL,
  created_at           INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_series_preparation_assessment ON series_preparation(thesis_assessment_id);
CREATE INDEX idx_series_preparation_script     ON series_preparation(script_id);

CREATE TRIGGER series_preparations_are_immutable
BEFORE UPDATE OF id, thesis_assessment_id, script_id, argument, created_at ON series_preparation
BEGIN
  SELECT RAISE(ABORT,
    'what prepared an assessment''s inputs is part of that round''s record and is immutable; the next round declares its own preparations');
END;

-- What a report RAN to produce itself, in three tables because there are exactly three kinds of
-- command and they answer different questions: a run of a STORED script, which names the program;
-- a run of the MEASUREMENT ENGINE, which is always the same program and so names itself; and
-- everything else the shell was asked to do, which can only name the command line.
--
-- None is a caller's account of what it did. All are written from the run log the generation
-- procedure kept while the report was being produced, which is why they carry a moment of their own
-- rather than borrowing the report's: the moment is the RUN's, and a report that names a run nobody
-- logged is exactly what these tables exist to make impossible. During a procedure the shell has
-- exactly one door — the tool that writes these rows — so a command that ran and left no row here
-- is not a gap in the record, it is a command that was refused.
--
-- Four columns say what happened rather than what was intended. \`created_at\` is when the command
-- STARTED, \`duration_ms\` how long it took, \`exit_code\` what the shell said about it, and
-- \`"return"\` what it printed. A failed run is recorded exactly as carefully as a successful one:
-- a report leaning on a command that exited nonzero is a thing an auditor should be able to find,
-- and a record that quietly dropped the failures would be the one shape of this table worth
-- distrusting.
--
-- Deliberately not sets: the same program legitimately runs twice with different arguments, and
-- twice with the SAME argument is a fact about the procedure worth keeping.
CREATE TABLE script_invocation (
  name       TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id         TEXT PRIMARY KEY,
  report_id  TEXT NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  -- CASCADE, but a standing report still blocks deleting the script: the cascade fires the
  -- leave-only-with-their-report trigger below, whose WHEN finds the report still there and aborts,
  -- taking the script deletion down with it. The repository counts first so the refusal says why.
  script_id  TEXT NOT NULL REFERENCES script(id) ON DELETE CASCADE,
  -- '' is an answer, not a missing value: a program run with no arguments is honestly recorded.
  argument   TEXT NOT NULL,
  -- What it printed. '' is an answer here too — a program that ran silently said nothing, and that
  -- is different from nobody having looked. Quoted at every mention because RETURN is a keyword in
  -- enough dialects that an unquoted one is a trap for whoever writes the next query by hand.
  "return"   TEXT NOT NULL,
  exit_code   INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_script_invocation_report ON script_invocation(report_id);
CREATE INDEX idx_script_invocation_script ON script_invocation(script_id);

-- A measurement: a run of the engine, recorded exactly the way its two neighbours are.
--
-- An earlier design had a table of this name and it was deleted, and the difference between that
-- row and this one is the whole doctrine. The old row held a hand-built JSON account of what the
-- engine was ASKED — a description of a request, written by the caller — and this file keeps
-- nothing a machine did not watch happen. This row is the watched kind: it comes off the same
-- generation run log as its neighbours and carries the same four facts about what actually happened.
--
-- What earns the engine a table of its own is the READER. "Which of these commands were
-- measurements" is the first question an auditor asks of a report's procedure, and the answer
-- should be a table rather than a text search over command lines that happen to contain a word.
--
-- \`"return"\` here is the engine's own report, kept WHOLE — the one verbatim capture this database
-- records (see \`src/exec.ts\`). A measurement report is a document, and a clipped one is not a
-- smaller version of it but a broken one.
--
-- No thesis_id, deliberately. Nothing points at a thesis from a report, so theses delete freely —
-- and a key here would either take that back or let a thesis deletion tear a hole in an immutable
-- publication record. Which thesis was measured is in the command line, the way any quoted prose
-- carries names.
CREATE TABLE seikan_invocation (
  name        TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  -- The engine command line as it ran. Not a path, not resolved, not read back as one: see header.
  command     TEXT NOT NULL CHECK (command <> ''),
  "return"    TEXT NOT NULL,
  exit_code   INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_seikan_invocation_report ON seikan_invocation(report_id);

-- Everything else that ran: a directory listing, a checksum, an ad-hoc one-liner.
--
-- It is called trivial because no row here NAMES anything else in the archive — there is no program
-- to point at, only the line that was typed — and that is exactly why the line is kept verbatim.
-- Now that the measurements have a table of their own, what is left really is the residue, and the
-- name is more honest than it was. The alternative to recording it would be a report whose
-- procedure did work nothing can see, which is the failure the whole of this file is arranged
-- against.
CREATE TABLE trivial_shell_history_for_report (
  name        TEXT NOT NULL COLLATE NOCASE CHECK (name <> ''),
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  -- The command line as it ran. Not a path, not resolved, not read back as one: see the header.
  command     TEXT NOT NULL CHECK (command <> ''),
  "return"    TEXT NOT NULL,
  exit_code   INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_trivial_shell_history_report ON trivial_shell_history_for_report(report_id);

-- -- the names ------------------------------------------------------------------------------------
--
-- One index per record table, and together they are the WHOLE uniqueness guarantee: within a table,
-- duplication is impossible even for SQL written by hand, and across tables nothing is claimed. Two
-- tables holding a row called \`semis inventory\` is not a collision, because a name is only ever
-- read alongside the table it belongs to — \`repo/naming.ts\` mints and checks within one table, and
-- an address the agent is given is a pair. The columns are COLLATE NOCASE, so these indexes make
-- \`Semis Inventory\` and \`semis inventory\` the same name rather than two.
CREATE UNIQUE INDEX idx_information_source_name ON information_source(name);
CREATE UNIQUE INDEX idx_target_name ON target(name);
CREATE UNIQUE INDEX idx_recipe_name ON recipe(name);
CREATE UNIQUE INDEX idx_report_name ON report(name);
CREATE UNIQUE INDEX idx_thesis_name ON thesis(name);
CREATE UNIQUE INDEX idx_thesis_assessment_name ON thesis_assessment(name);
CREATE UNIQUE INDEX idx_script_name ON script(name);
CREATE UNIQUE INDEX idx_series_preparation_name ON series_preparation(name);
CREATE UNIQUE INDEX idx_script_invocation_name ON script_invocation(name);
CREATE UNIQUE INDEX idx_seikan_invocation_name ON seikan_invocation(name);
CREATE UNIQUE INDEX idx_trivial_shell_history_name
  ON trivial_shell_history_for_report(name);

-- DELETING A RECIPE TAKES ITS REPORTS, and there is deliberately no trigger standing in the way.
-- \`report.recipe_id\` is ON DELETE CASCADE and that cascade is the WHOLE meaning of the act: the
-- specification and everything published to it are one body of work, and removing the first without
-- the second would leave documents nothing can say the instructions for. A recipe that has been
-- superseded is not deleted at all — it is set \`inactive\`, which retires it while every report
-- written under it goes on being readable. \`repo/recipes.ts\` says how many reports would go before
-- it asks, and the tool says it again in the conversation; what the database guarantees is that
-- they leave together or not at all.
--
-- A publication is one act, and these four tables are its parts. They are written in the
-- transaction that publishes the report and they leave with it — never on their own, never edited
-- afterwards, because a record that can be amended piece by piece is not a record of what was
-- published. Each WHEN clause stands down during the report's own cascade: a foreign key action
-- runs AFTER the parent row is gone, and the subquery then finds no report — which is what lets
-- deleting a recipe take its reports and every part of those publications with it, in one act the
-- user asked for.
CREATE TRIGGER script_invocations_leave_only_with_their_report
BEFORE DELETE ON script_invocation
WHEN EXISTS (SELECT 1 FROM report WHERE id = OLD.report_id)
BEGIN
  SELECT RAISE(ABORT, 'an invocation is part of the publication record; it is deleted only with its report');
END;

CREATE TRIGGER script_invocations_are_immutable
BEFORE UPDATE OF id, report_id, script_id, argument, "return", exit_code, duration_ms, created_at
ON script_invocation
BEGIN
  SELECT RAISE(ABORT, 'the publication record is immutable; delete the report and publish again');
END;

CREATE TRIGGER seikan_invocations_leave_only_with_their_report
BEFORE DELETE ON seikan_invocation
WHEN EXISTS (SELECT 1 FROM report WHERE id = OLD.report_id)
BEGIN
  SELECT RAISE(ABORT, 'a measurement is part of the publication record; it is deleted only with its report');
END;

CREATE TRIGGER seikan_invocations_are_immutable
BEFORE UPDATE OF id, report_id, command, "return", exit_code, duration_ms, created_at
ON seikan_invocation
BEGIN
  SELECT RAISE(ABORT, 'the publication record is immutable; delete the report and publish again');
END;

CREATE TRIGGER shell_history_leaves_only_with_its_report
BEFORE DELETE ON trivial_shell_history_for_report
WHEN EXISTS (SELECT 1 FROM report WHERE id = OLD.report_id)
BEGIN
  SELECT RAISE(ABORT, 'a command is part of the publication record; it is deleted only with its report');
END;

CREATE TRIGGER shell_history_is_immutable
BEFORE UPDATE OF id, report_id, command, "return", exit_code, duration_ms, created_at
ON trivial_shell_history_for_report
BEGIN
  SELECT RAISE(ABORT, 'the publication record is immutable; delete the report and publish again');
END;

-- ── The two logs ────────────────────────────────────────────────────────────────────────────────
--
-- Everything above this line is a record: immutable, addressable, audited, and kept for ever.
-- Everything below is the opposite of the last of those on purpose. A log is a ring: it holds the
-- most recent thousand rows and drops what falls off the end, because a log nobody prunes is a log
-- that eventually costs more than the failures it describes.
--
-- NO FOREIGN KEY, ANYWHERE IN EITHER TABLE, AND NO TRIGGER. A log row is written ABOUT something —
-- often about that thing ceasing to exist — so a key pointing at it would either block the delete
-- being recorded or cascade away the record of it. \`recipe_id\`-shaped columns are absent for the
-- same reason: what a log row names, it names in prose or in JSON, where nothing enforces that the
-- subject still stands.
--
-- Both use INTEGER PRIMARY KEY because rowid order IS the log's order, and a page boundary drawn on
-- it lands in the same place every time, even for two rows written in one millisecond.

-- What went WRONG — never what was refused. A refusal is an answer: the model asked for something it
-- may not have and was told so in a sentence, and filing those here would bury the six or seven real
-- failures a month under a thousand ordinary conversations. What lands here is a defect: an
-- exception nobody expected, a procedure that died, a subprocess that came back non-zero.
CREATE TABLE error_log (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  -- Which layer noticed. Deliberately coarse: 'run' says a program the agent started failed, and the
  -- message says which and how, because a taxonomy fine enough to be interesting is a taxonomy that
  -- is wrong within a year.
  scope   TEXT NOT NULL CHECK (scope IN ('http','turn','generation','tool','run')),
  message TEXT NOT NULL CHECK (message <> ''),
  -- Whatever structured context the writer had, as JSON, or nothing. Not CHECKed for validity: this
  -- column is written from inside failure handlers, and a log that refuses a badly-shaped detail is a
  -- log that turns one failure into two.
  detail  TEXT
) STRICT;

-- What LEFT. The archive is a record of what exists, and it is silent by construction about what has
-- left it — so when a row is deleted, the whole row is written here as JSON first. That is the only
-- copy that will ever exist: nothing above this line remembers a deletion, and "what was removed,
-- and what was in it" is a question somebody will need answered.
--
-- ONLY THE ROW ACTUALLY DELETED is filed, never the rows a foreign key took with it. A cascade is
-- the schema's consequence of one act, not a second act, and logging six children would describe the
-- database's plumbing where the log is meant to describe a decision.
CREATE TABLE deletion_log (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name <> ''),
  -- The row's own key as text, whatever its type was — a uuid, or a ticker.
  row_id     TEXT NOT NULL CHECK (row_id <> ''),
  -- The whole row. CHECKed for validity here, unlike \`error_log.detail\`, because this one is not
  -- written from a failure handler and an unparseable row_json is a witness that witnesses nothing.
  row_json   TEXT NOT NULL CHECK (json_valid(row_json))
) STRICT;
`;
