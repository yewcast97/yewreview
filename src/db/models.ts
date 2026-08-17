/**
 * Row shapes and the closed vocabularies the schema enforces.
 *
 * These are the types the repositories return and the server serializes — plain data, no methods.
 * Every timestamp is epoch milliseconds UTC; every path is var-relative POSIX.
 */

export type SourceType =
  | "issuer_primary"
  | "regulatory_government"
  | "trusted_data_vendor"
  | "sellside_research"
  | "buyside_public_disclosure"
  | "independent_research";

export const SOURCE_TYPES: readonly SourceType[] = [
  "issuer_primary",
  "regulatory_government",
  "trusted_data_vendor",
  "sellside_research",
  "buyside_public_disclosure",
  "independent_research",
];

/** What one ASSESSMENT read a thesis as. `approven` is the user's word and is treated as opaque.
 * A thesis with no assessment yet is untagged and live — a container nobody has measured. Every
 * reading files its own row, so a tag belongs to a moment rather than to the thesis; `abandoned` is
 * the last row a ledger can take, a judgement kept rather than a row destroyed. */
export type Tag = "approven" | "insightful" | "abandoned";
export const TAGS: readonly Tag[] = ["approven", "insightful", "abandoned"];

/** A script's standing. Its source never changes, so this is the only thing about it that moves:
 * `inactive` retires the program without deleting it or the files it produced, and an inactive
 * script is refused a run — a retired method does not go on quietly producing numbers. */
export type ScriptStatus = "active" | "inactive";
export const SCRIPT_STATUSES: readonly ScriptStatus[] = ["active", "inactive"];

/** A recipe's standing, and the same word for the same reason as a script's. `inactive` retires the
 * specification: its text stays, every report written under it stays, and the generation gate
 * refuses to open a procedure there. */
export type RecipeStatus = "active" | "inactive";
export const RECIPE_STATUSES: readonly RecipeStatus[] = ["active", "inactive"];

export type Source = {
  /** The row's name: a condensed summary of what it holds, unique within THIS table and nowhere
   * wider, and the user's to reword by asking for it. See `repo/naming.ts`. */
  name: string;
  id: string;
  source: string;
  type: SourceType;
  domain: string;
  method: string;
  /**
   * The hostnames this source publishes at, lowercase.
   *
   * The column is a JSON array and the repository parses it on the way out, the way `Thesis.regime`
   * is assembled from its own table — a caller that had to remember to `JSON.parse` a field is a
   * caller that will one day compare a string to an array and find nothing.
   */
  hosts: string[];
  failure_cases: string | null;
  auth_env: string | null;
  created_at: number;
  updated_at: number;
};

export type Target = {
  /**
   * The instrument's OFFICIAL FULL NAME, and the one name in this database that never moves.
   *
   * Every other record's name is ours — a line we minted so a reader can tell one row from another,
   * and theirs to reword. A company's registered name is a fact somebody looked up, so it is
   * recorded verbatim and never edited: a wrong one is corrected by deleting the target and
   * recording it again. Unique within this table, like every other name here. See `repo/naming.ts`.
   */
  name: string;
  ticker: string;
  market: string | null;
  unit: string | null;
  added_at: number;
};

export type TargetWithCounts = Target & {
  thesis_count: number;
};

/** A report specification: what a report written to it must be. Its text is fixed at creation and
 * only its status moves — see `repo/recipes.ts`. */
export type Recipe = {
  /** The row's name: a condensed summary of what it holds, unique within THIS table and nowhere
   * wider, and the user's to reword by asking for it. See `repo/naming.ts`. */
  name: string;
  id: string;
  content: string;
  status: RecipeStatus;
  created_at: number;
  /** The moment the status last moved. Nothing else about a recipe changes after it is stored. */
  updated_at: number;
};

export type RecipeCard = Recipe & {
  /** How many reports have been published under it — which is what a caller about to delete one
   * has to be told, because they all leave with it. */
  report_count: number;
};

/**
 * A published report, WITHOUT its document.
 *
 * The bytes live in `report.content` and are read on their own through `getReportContent`, because
 * everything else here is index-sized and the document is not: a listing that carried it would ship
 * megabytes of HTML to draw a row of titles. Nothing but the server route that serves the document
 * ever needs it.
 */
export type Report = {
  /** The row's name: a condensed summary of what it holds, unique within THIS table and nowhere
   * wider, and the user's to reword by asking for it. See `repo/naming.ts`. */
  name: string;
  id: string;
  recipe_id: string;
  title: string;
  created_at: number;
};

export type ReportCard = Report & {
  /** What the recipe it was published under is CALLED — the line a reader picks it out by. The id
   * is already on the row; this is the half a person reads. */
  recipe_name: string;
  /** How many runs of a stored script the generation log recorded behind its numbers. */
  script_invocation_count: number;
  /** How many measurements that same log recorded. */
  seikan_invocation_count: number;
  /** How many other commands that same log recorded. */
  shell_command_count: number;
};

export type Thesis = {
  /** The row's name: a condensed summary of what it holds, unique within THIS table and nowhere
   * wider, and the user's to reword by asking for it. See `repo/naming.ts`. */
  name: string;
  id: string;
  content: string;
  dsl_json: string;
  dsl_hash: string;
  created_at: number;
  /** The thesis's regime — the conjunction it must hold across, or the basket it ranks within;
   * the measured instruments, never a search axis. Hydrated by the repository. */
  regime: string[];
  /** How the newest assessment read it, or null while nobody has measured it yet. DERIVED from the
   * ledger on every read, never stored — a column here would be a second copy of the ledger's
   * answer, and second copies go stale. */
  latest_tag: Tag | null;
  /** The moment of that newest assessment; null while there is none. */
  assessed_at: number | null;
};

/** One round of judgement, as filed. */
export type ThesisAssessment = {
  /** The row's name: a condensed summary of what it holds, unique within THIS table and nowhere
   * wider, and the user's to reword by asking for it. See `repo/naming.ts`. */
  name: string;
  id: string;
  thesis_id: string;
  tag: Tag;
  assessment: string;
  /** The engine's own report for the run this reading came off, verbatim. */
  seikan_report: string;
  created_at: number;
};

/** What produced one series an assessment's round was measured over. */
export type SeriesPreparation = {
  /** The row's name: a condensed summary of what it holds, unique within THIS table and nowhere
   * wider, and the user's to reword by asking for it. See `repo/naming.ts`. */
  name: string;
  id: string;
  thesis_assessment_id: string;
  script_id: string;
  /** The argument line the producing run was given; '' when it took none. */
  argument: string;
  created_at: number;
};

export type Script = {
  /** The row's name: a condensed summary of what it holds, unique within THIS table and nowhere
   * wider, and the user's to reword by asking for it. See `repo/naming.ts`. */
  name: string;
  id: string;
  domain: string;
  /** The program itself. A script row IS its source; there is no file to read it back from. */
  source: string;
  status: ScriptStatus;
  created_at: number;
  /** The moment the status last moved. Nothing else about a script changes after it is saved. */
  updated_at: number;
};

/** What every recorded command tells a reader about how it went. */
type RunOutcome = {
  /** What it printed. Clipped for an ordinary command, verbatim for an engine run — see
   * `src/exec.ts`, which is the one place that decides. */
  return: string;
  exit_code: number;
  duration_ms: number;
  /** When it STARTED. With `duration_ms` beside it, when it finished needs no second column. */
  created_at: number;
};

/** A script run as a reader meets it: the program named, by the script's own name. */
export type ScriptRunBrief = RunOutcome & {
  id: string;
  script_id: string;
  script_name: string;
  argument: string;
};

/**
 * A measurement a report's procedure ran.
 *
 * The same shape as a shell line, because the same four facts are all a machine watched: the engine
 * is one program and the row does not name it twice. What makes it its own brief is the table it
 * came out of — that is the answer to "which of these were measurements", and it is a join rather
 * than a search through command text.
 */
export type SeikanRunBrief = RunOutcome & {
  id: string;
  command: string;
};

/** Every other command a report's procedure ran. The line is all there is to name it by. */
export type ShellRunBrief = RunOutcome & {
  id: string;
  command: string;
};

/**
 * A repository refusal the agent and the HTTP layer both render.
 *
 * Refusals are RETURNED to the model as tool results rather than thrown at it, so the `kind` is
 * what picks the remediation hint. It is thrown out of the repositories because a repository has
 * no idea who is calling.
 */
export class Refused extends Error {
  readonly kind: RefusalKind;
  constructor(kind: RefusalKind, message: string) {
    super(message);
    this.name = "Refused";
    this.kind = kind;
  }
}

export type RefusalKind =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "invalid_path"
  | "data_invalid";

