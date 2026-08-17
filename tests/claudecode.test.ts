/**
 * The agent runtime, driven by a scripted fake instead of the real SDK.
 *
 * Nothing here spawns a model. What is being tested is the part YewReview owns and gets wrong
 * quietly: which conversation a turn is spoken into, what text is composed in front of it, and what
 * happens when the session the SDK was asked to reopen is not there any more. A real subprocess
 * would test the SDK.
 *
 * What this file cannot do is read the transcript, and that absence shapes every wait in it.
 * There is no `message` table: the SDK's session store is the only record of what was said, it is on
 * disk in a format this process does not own, and asserting against it here would be asserting
 * against the fake. So a turn is observed through what it EMITS — the frames a window would draw —
 * or through what the fake was handed, and those two are exactly the surfaces YewReview is
 * responsible for.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { agentHooks } from "../src/claudecode/hooks.ts";
import { buildAgentOptions } from "../src/claudecode/options.ts";
import { systemPrompt } from "../src/claudecode/prompt.ts";
import { ClaudecodeAgent, defaultTools } from "../src/claudecode/session.ts";
import type { QueryFn } from "../src/claudecode/session.ts";
import type {
  EventsFrame,
  OutboundFrame,
  ProcedureStart,
  ToolDeps,
} from "../src/protocol/types.ts";
import type { EffortLevel } from "../src/config.ts";
import { homeDir, paths, realPath } from "../src/config.ts";
import { newId } from "../src/db/tx.ts";
import { listErrors } from "../src/repo/logs.ts";
import { createRecipe, setRecipeStatus } from "../src/repo/recipes.ts";
import { RECORD_TABLES } from "../src/repo/records.ts";
import type { Resources } from "../src/resources/embed.ts";
import type { VenvStatus } from "../src/sandbox/venv.ts";
import { harness, seedRecipe, type Harness } from "./helpers.ts";
/**
 * The window's own opening lines, imported so the prompt can be locked against them.
 *
 * Two files have to agree about four sentences and there is no type that can say so: the window
 * sends them, and the prompt teaches the agent what to do when one arrives. A test importing both
 * is the only thing that fails when one side is reworded — which is the drift worth catching,
 * because the failure it causes is silent. The agent would answer an opening as ordinary
 * conversation, and nothing anywhere would report a fault.
 */
import {
  NEW_RECIPE,
  NEW_SCRIPT,
  NEW_SOURCE,
  NEW_THESIS,
} from "../web/src/lib/awareness.ts";

let h: Harness;
const opened: ClaudecodeAgent[] = [];

function fresh(): Harness {
  h = harness();
  return h;
}

afterEach(() => {
  // Before the database closes, because disposal ends a generation and an ending generation writes
  // an error row.
  for (const agent of opened.splice(0)) agent.dispose();
  h?.cleanup();
});

// -- the fake driver ---------------------------------------------------------------------------

type FakeCall = {
  options: Options;
  /** The text of each turn this session was sent, in order. */
  prompts: string[];
  interrupts: number;
  returned: boolean;
  /** Every model `setModel` was handed, in order. */
  models: (string | undefined)[];
  /** What `setModel` throws instead of answering, for the rollback case. */
  setModelThrows: string | null;
  /** Every effort level `applyFlagSettings` was handed, in order. Recorded the same way the models
   * are, since the two control-plane calls are the same kind of fact about a session. */
  efforts: (EffortLevel | null | undefined)[];
  /** What `applyFlagSettings` throws instead of answering, for the rollback case. */
  applyFlagSettingsThrows: string | null;
};

/** What a session says back to one turn. Throwing stands in for a session that would not open. */
type Scripted = (prompt: string, call: FakeCall) => SDKMessage[] | Promise<SDKMessage[]>;

/** One row of a scripted `supportedModels` answer, shaped like the SDK's `ModelInfo`. */
type ModelRow = { value: string; displayName: string; resolvedModel?: string };

function fakeSdk(script: Scripted): {
  fn: QueryFn;
  calls: FakeCall[];
  /** What every session's `supportedModels` answers, or null to make it fail. On the DRIVER rather
   * than on a call, because the fetch happens the instant a session opens — a knob on the call is
   * one a test can only reach after the answer it wanted to change has already been given.
   *
   * `resolvedModel` is optional here exactly as it is on the SDK's own type: a row may be an alias
   * for a canonical id, and the tests below that matter most are the ones where it is. */
  supported: ModelRow[] | null;
} {
  const calls: FakeCall[] = [];
  const driver = {
    supported: [
      { value: "claude-opus-5", displayName: "Opus 5" },
      { value: "claude-sonnet-5", displayName: "Sonnet 5" },
    ] as ModelRow[] | null,
  };
  const fn: QueryFn = ({ prompt, options }) => {
    const call: FakeCall = {
      options,
      prompts: [],
      interrupts: 0,
      returned: false,
      models: [],
      setModelThrows: null,
      efforts: [],
      applyFlagSettingsThrows: null,
    };
    calls.push(call);
    const source = prompt[Symbol.asyncIterator]();
    let pending: SDKMessage[] = [];
    return {
      // The control plane, recorded rather than driven: `setModel` and `supportedModels` are called
      // at most once per session and never inside a turn, so a driver that answers them honestly
      // and remembers what it was asked is the whole of what the tests below need.
      async setModel(model?: string): Promise<void> {
        call.models.push(model);
        if (call.setModelThrows !== null) throw new Error(call.setModelThrows);
      },
      async applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void> {
        call.efforts.push(settings.effortLevel);
        if (call.applyFlagSettingsThrows !== null) throw new Error(call.applyFlagSettingsThrows);
      },
      async supportedModels() {
        if (driver.supported === null) throw new Error("the CLI would not list its models");
        return driver.supported;
      },
      async next(): Promise<IteratorResult<SDKMessage, void>> {
        for (;;) {
          const ready = pending.shift();
          if (ready !== undefined) return { done: false, value: ready };
          const step = await source.next();
          if (step.done) return { done: true, value: undefined };
          const content = (step.value as { message: { content: unknown } }).message.content;
          call.prompts.push(typeof content === "string" ? content : JSON.stringify(content));
          pending = [...(await script(call.prompts[call.prompts.length - 1]!, call))];
        }
      },
      async interrupt() {
        call.interrupts += 1;
        return undefined;
      },
      async return() {
        call.returned = true;
        return { done: true, value: undefined };
      },
    };
  };
  return {
    fn,
    calls,
    get supported() {
      return driver.supported;
    },
    set supported(value) {
      driver.supported = value;
    },
  };
}

// Only the fields the handler reads are spelled; the SDK's own payloads carry two dozen more and a
// fixture that filled them in would be testing the fixture.
const init = (sessionId: string): SDKMessage =>
  ({ type: "system", subtype: "init", session_id: sessionId }) as unknown as SDKMessage;

const delta = (text: string): SDKMessage =>
  ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  }) as unknown as SDKMessage;

const says = (...texts: string[]): SDKMessage =>
  ({
    type: "assistant",
    message: { content: texts.map((text) => ({ type: "text", text })) },
  }) as unknown as SDKMessage;

const uses = (id: string, name: string, input: unknown): SDKMessage =>
  ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  }) as unknown as SDKMessage;

const toolResult = (id: string, text: string, isError = false): SDKMessage =>
  ({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] },
      ],
    },
  }) as unknown as SDKMessage;

/** The SDK folding the conversation down to a summary. `metadata` is omitted by one caller on
 * purpose: the trigger is the SDK's word and a message that carries none still has to reach the
 * window as something. */
const compaction = (metadata?: { trigger: string }): SDKMessage =>
  ({
    type: "system",
    subtype: "compact_boundary",
    ...(metadata ? { compact_metadata: metadata } : {}),
  }) as unknown as SDKMessage;

const done = (sessionId: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    total_cost_usd: 0.02,
    usage: { input_tokens: 10 },
    num_turns: 2,
  }) as unknown as SDKMessage;

const NO_ENGINE: VenvStatus = {
  ready: false,
  python: null,
  seikanBin: null,
  seikanVersion: null,
  dslGuide: null,
  error: "not provisioned in tests",
};

/**
 * An environment with the engine installed, for the suites that need one.
 *
 * The paths name nothing real and nothing here spawns them — what the session reads is `ready`, and
 * a generation refuses outright without it, so a procedure cannot be observed at all under
 * `NO_ENGINE`. `dslGuide` stays null: the prompt this venv would carry is the subject of another
 * suite, and filling it in here would make these tests depend on it.
 */
const WITH_ENGINE: VenvStatus = {
  ready: true,
  python: "/nonexistent/venv/bin/python",
  seikanBin: "/nonexistent/venv/bin/seikan",
  seikanVersion: "0.0.0-test",
  dslGuide: null,
  error: null,
};

// Only `claudeCli` is read when options are built; naming the rest would tie this suite to the
// shape of a bundle it has no opinion about.
const RESOURCES = { claudeCli: "/usr/bin/true" } as Resources;

/**
 * One agent, which is all there is.
 *
 * It takes no recipe. That is the whole shape of the runtime in one signature: the conversation
 * belongs to the installation, a recipe reaches it as an argument to a tool, and an agent built
 * for one would be a fixture the runtime cannot produce.
 *
 * THE TOOL DEPS ARE CAPTURED ON THE WAY PAST, which is how the tests below reach the generation
 * gate. Nothing outside a tool can open a procedure any more — the route that used to is gone, and
 * `startGeneration` went with it — so a test that wants one open has to arrive the way the model
 * does: through `deps.procedure.start`, the same object the real tool is handed. The factory is
 * otherwise the default one, so the roster the session serves is the real roster.
 */
function agentFor(script: Scripted, venv: VenvStatus = NO_ENGINE) {
  const sdk = fakeSdk(script);
  const events: EventsFrame[] = [];
  let captured: ToolDeps | null = null;
  const agent = new ClaudecodeAgent({
    db: h.db,
    settings: h.settings,
    resources: RESOURCES,
    venv: () => venv,
    events: (frame) => events.push(frame),
    queryFn: sdk.fn,
    tools: (deps) => {
      captured = deps;
      return defaultTools(deps);
    },
  });
  opened.push(agent);
  return {
    agent,
    sdk,
    events,
    /**
     * Open a procedure the way `start_generation` does, through the same object the real tool is
     * handed.
     *
     * The deps are minted when the session starts, which is when the first turn is submitted — and
     * a procedure needs a turn in flight to ride in any case, so every caller here is inside one by
     * the time it reaches this.
     */
    startGeneration(recipeId: string): ProcedureStart {
      if (captured === null) throw new Error("no tools built yet — submit a turn first");
      return (captured as ToolDeps).procedure.start(recipeId);
    },
  };
}

/** Attach a window and keep what it was sent. */
function watch(agent: ClaudecodeAgent): OutboundFrame[] {
  const frames: OutboundFrame[] = [];
  agent.attach((frame) => frames.push(frame));
  return frames;
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The wait almost every test here wants: the frame that says a turn is over. */
function arrives(frames: OutboundFrame[], type: OutboundFrame["type"]): Promise<void> {
  return waitUntil(() => frames.some((f) => f.type === type), `a ${type} frame`);
}

/** And the wait for a turn nobody is watching: the cost only lands once the result is read. */
function settled(agent: ClaudecodeAgent): Promise<void> {
  return waitUntil(() => agent.snapshot().totalCostUsd > 0, "the turn to finish unwatched");
}

/**
 * The wait for the SDK's own list to have replaced the fallback on a `ready` frame.
 *
 * It keys on ONE LABEL THE SCRIPTED DRIVER WROTE, and both cheaper discriminators are wrong here.
 * A count says nothing: both lists are curated on the way out — Fable is appended to any that lacks
 * it — so the driver's two entries and the hardcoded fallback come out the same length. And "a
 * label that is not its own id" says nothing either, because curation strips the vendor prefix from
 * every label it passes, so the fallback's own rows read "opus-5" beside `claude-opus-5` and satisfy
 * that test the moment the first frame lands. What only an answered list can carry is a name written
 * nowhere but the driver, so the caller names the one it scripted; the default is the row the driver
 * answers with unless a test replaced its list.
 */
function realModelList(frames: OutboundFrame[], displayName = "Opus 5"): Promise<void> {
  return waitUntil(
    () =>
      frames.some(
        (f) => f.type === "ready" && f.models.some((option) => option.displayName === displayName),
      ),
    `the model list the SDK answered with, labelling something ${displayName}`,
  );
}

/** The plain conversation: one turn, streamed, one answer. */
const plainScript = (sessionId = "session-1"): Scripted => {
  return () => [init(sessionId), delta("Rat"), delta("es."), says("Rates."), done(sessionId)];
};

// -- what a turn emits -------------------------------------------------------------------------

describe("what a turn emits", () => {
  test("the words arrive as deltas and the turn ends saying only how it ended", async () => {
    fresh();
    const { agent } = agentFor(plainScript());
    const frames = watch(agent);

    expect(agent.submitTurn("what moved?")).toBe(true);
    await arrives(frames, "turn_result");

    expect(frames.filter((f) => f.type === "text_delta").map((f) => f.text)).toEqual(["Rat", "es."]);
    const result = frames.find((f) => f.type === "turn_result");
    // THE WHOLE FRAME, because what it no longer carries is the assertion. It used to hand the
    // window the turn's cost, its token usage and how many turns the SDK took; nothing drew any of
    // them, and a frame carrying a number nobody reads is a promise between the two sides that goes
    // stale without ever failing. The subtype is what a window does draw — how the turn ended.
    expect(result).toEqual({ type: "turn_result", subtype: "success" });
    // And it names no message row, because there is no row to name. The window reads the transcript
    // back from the SDK whole rather than assembling it out of frames, so a field pairing a result
    // with a stored message would have no subject.
    expect(result).not.toHaveProperty("messageId");
    // The cost is still ACCUMULATED — it is a fact about the conversation, and the snapshot is where
    // a fact about the conversation belongs. What moved is where it is read from, not whether it is
    // kept.
    expect(agent.snapshot()).toMatchObject({ busy: false, totalCostUsd: 0.02 });
  });

  test("a tool call and its answer are one pair, and the answer is named from the call", async () => {
    fresh();
    const { agent } = agentFor(() => [
      init("s"),
      uses("t1", "Bash", { command: "ls run" }),
      toolResult("t1", "aapl_ohlcv.csv\nnvda_ohlcv.csv"),
      done("s"),
    ]);
    const frames = watch(agent);

    agent.submitTurn("look around");
    await arrives(frames, "turn_result");

    expect(frames.find((f) => f.type === "tool_start")).toMatchObject({
      tool: "Bash",
      toolUseId: "t1",
      summary: "ls run",
    });
    // The tool_result block carries no name of its own; the session remembers it from the call, and
    // a pair drawn without that memory would close a line the window never opened.
    expect(frames.find((f) => f.type === "tool_end")).toMatchObject({
      tool: "Bash",
      toolUseId: "t1",
      ok: true,
      summary: "aapl_ohlcv.csv nvda_ohlcv.csv",
    });
  });

  test("a failed tool call closes out as not ok", async () => {
    fresh();
    const { agent } = agentFor(() => [
      init("s"),
      uses("t9", "Read", { file_path: "/nope" }),
      toolResult("t9", "no such file", true),
      says("It is not there."),
      done("s"),
    ]);
    const frames = watch(agent);
    agent.submitTurn("read it");
    await arrives(frames, "turn_result");
    expect(frames.find((f) => f.type === "tool_end")).toMatchObject({ ok: false, tool: "Read" });
  });

  test("a turn runs to the end with no socket attached at all", async () => {
    fresh();
    const { agent, sdk, events } = agentFor(plainScript());

    // Nobody attached, and the turn still finishes: the words were produced and paid for, and the
    // SDK is writing them down for whoever comes back.
    agent.submitTurn("nobody is watching");
    await settled(agent);

    expect(sdk.calls[0]!.prompts).toEqual(["nobody is watching"]);
    expect(agent.snapshot()).toMatchObject({ sessionId: "session-1", totalCostUsd: 0.02 });
    expect(events.filter((f) => f.type === "sessions_changed")).not.toHaveLength(0);
  });
});

// -- the brief a generation answers with ---------------------------------------------------------

describe("the brief a generation answers with", () => {
  test("an ordinary turn carries nothing but what the user typed", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);

    agent.submitTurn("first");
    await arrives(frames, "turn_result");
    agent.submitTurn("second");
    await waitUntil(() => sdk.calls[0]!.prompts.length === 2, "the second turn");

    // Nothing is prefixed to a turn. There is one conversation across every recipe the
    // archive holds, so there is no specification that is "the" one to inject, and no earlier
    // message to quote into a question — the SDK's own history is what the model remembers.
    expect(sdk.calls[0]!.prompts).toEqual(["first", "second"]);
  });

  test("a generation names its recipe, quotes it whole, and ends with the procedure", async () => {
    fresh();
    const recipe = createRecipe(h.db, "Semiconductors", "Write two reports, weekly.");
    const turn = held();
    const { agent, sdk, startGeneration } = agentFor(turn.script, WITH_ENGINE);

    // INSIDE A TURN, because that is the only place a procedure can be opened now. The model asks
    // for one with a tool while it is answering; there is no longer any way to open one from
    // outside a conversation, and the gate refuses a procedure with no turn to ride.
    agent.submitTurn("write the semis report");
    await waitUntil(() => agent.snapshot().busy, "the turn to start");
    const started = startGeneration(recipe.id);
    expect(started.ok).toBe(true);
    const brief = started.ok ? started.brief : "";

    // Both the name and the id, because this text has two readers with different needs: the user
    // reads a transcript and knows the recipe by name, and the model calls tools that take an id.
    expect(brief.startsWith(`The recipe ${recipe.name} (id ${recipe.id}) —`)).toBe(true);
    // And the reason there is no version to pin: the text cannot move, so naming the row names the
    // bytes.
    expect(brief).toContain("A recipe's text is immutable");
    expect(brief).toContain("Write two reports, weekly.");

    // The specification first and the instruction last, which is where an instruction belongs when a
    // specification of unknown length precedes it.
    expect(brief.indexOf("Write two reports, weekly.")).toBeLessThan(
      brief.indexOf("Generation procedure."),
    );

    // AND NOTHING WAS SUBMITTED. The brief used to arrive as a whole new turn, queued by whoever
    // pressed the button; it comes back as the opening tool's result now, so the specification is
    // read inside the turn that asked for it. One prompt went to the model — the user's.
    expect(sdk.calls[0]!.prompts).toEqual(["write the semis report"]);
    turn.release();
  });

  test("the procedure it ends with is a constant nobody outside the session chose", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, startGeneration } = agentFor(turn.script, WITH_ENGINE);
    agent.submitTurn("go");
    await waitUntil(() => agent.snapshot().busy, "the turn to start");
    const started = startGeneration(recipeId);
    const brief = started.ok ? started.brief : "";

    // Every sentence below is doctrine the procedure must keep stating in these words. It is a
    // constant for a sharper reason than it used to be: the browser wording this instruction would
    // have made the recorded procedure a function of a request body, and the MODEL wording it would
    // make it no instruction at all.
    expect(brief).toContain(
      "Generation procedure. Produce and publish the report this recipe specifies.",
    );
    expect(brief).toContain(
      "every command goes through `run_shell`, `run_script` or `run_seikan`",
    );
    expect(brief).toContain("your own Bash is closed for the duration");
    // Both halves of the widening, because either alone teaches the wrong thing: the door is
    // closed to everything, AND an ordinary shell is on the other side of it.
    expect(brief).toContain("nothing you would otherwise type is denied");
    expect(brief).toContain("`publish_report` is available only here");
    // The two-phase log's rule reaches the model here as well as in the system prompt, because
    // this is the text it is working under.
    expect(brief).toContain("Wait for any command still running before you publish");

    // THE TWO SENTENCES THAT ARRIVED WITH THE FREEZE, and they are what make the rest of this
    // survivable: everything else the model might want to write is refused for the duration, so it
    // has to be told to store what it needs BEFORE it starts and to file its readings afterwards.
    expect(brief).toContain("The archive holds still for the duration");
    expect(brief).toContain("Store the scripts and theses you will need before you start");
    expect(brief).toContain("still redeemable by its run id");
    // And the turn boundary, which is the other thing a procedure riding a turn has to say out
    // loud: a model that stops intending to continue closes the procedure and leaves nothing to
    // publish into.
    expect(brief).toContain("The procedure lives inside the turn that opened it");
    expect(brief).toContain("publish before you stop");

    expect(
      brief.endsWith(
        "A procedure that ends without a report is a finished answer, not a failure.",
      ),
    ).toBe(true);
    turn.release();
  });
});

// -- sessions ----------------------------------------------------------------------------------

describe("sessions", () => {
  test("a boot starts talking to nothing, and learns the name of what it minted", async () => {
    fresh();
    const { agent, sdk, events } = agentFor(plainScript("its-own-name"));
    const frames = watch(agent);

    // No id is stored anywhere, so there is nothing to resume and the window is told so plainly:
    // a session is a live thing belonging to a process, and promising the next boot a conversation
    // it has no way to know still exists is the one thing this must never do.
    expect(frames[0]).toMatchObject({ type: "ready", fresh: true, sessionId: null });

    agent.submitTurn("hello");
    await arrives(frames, "turn_result");

    expect(sdk.calls[0]!.options.resume).toBeUndefined();
    // Re-emitted, and load-bearing rather than tidy: this window attached before the session
    // existed, and the id is what it fetches the transcript by afterwards.
    expect(frames.filter((f) => f.type === "ready").at(-1)).toMatchObject({
      fresh: true,
      sessionId: "its-own-name",
    });
    expect(agent.snapshot().sessionId).toBe("its-own-name");
    // Twice for one turn, and each poke is a different fact: the conversation acquired a name, and
    // then it acquired a turn the SDK may have renamed it from.
    expect(events.filter((f) => f.type === "sessions_changed")).toHaveLength(2);
  });

  test("a remembered id the SDK will not open is retried exactly once, fresh", async () => {
    fresh();
    const { agent, sdk, events } = agentFor((_prompt, call) => {
      if (call.options.resume === "gone") throw new Error("No conversation found with session ID");
      return [init("minted"), says("Still here."), done("minted")];
    });
    const frames = watch(agent);

    // The user picked a conversation out of the session list; the SDK has since pruned it. That is
    // ordinary rather than exceptional, and indistinguishable from a real failure until it is tried.
    expect(agent.resume("gone")).toEqual({ ok: true });
    agent.submitTurn("are you there?");
    await arrives(frames, "turn_result");

    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[0]!.options.resume).toBe("gone");
    expect(sdk.calls[1]!.options.resume).toBeUndefined();
    expect(sdk.calls[1]!.prompts).toEqual(["are you there?"]);

    // The whole arc, in order: attached to nothing, told to reopen, told the reopen failed, told
    // what the replacement is called. The middle two are the pair this retry owes the window — it
    // drew the conversation believing the model remembered it, and it does not.
    //
    // CONSECUTIVE REPEATS ARE COLLAPSED, because `ready` is also how the agent announces the model
    // list once the SDK has answered `supportedModels`, and that frame says nothing about which
    // conversation this is. The arc being asserted is the SESSION's, and a frame that reports the
    // same session twice has not moved it.
    const arc: [boolean, string | null][] = [];
    for (const frame of frames) {
      if (frame.type !== "ready") continue;
      const last = arc.at(-1);
      if (last !== undefined && last[0] === frame.fresh && last[1] === frame.sessionId) continue;
      arc.push([frame.fresh, frame.sessionId]);
    }
    expect(arc).toEqual([
      [true, null],
      [false, "gone"],
      [true, null],
      [true, "minted"],
    ]);
    expect(agent.snapshot()).toMatchObject({ fresh: true, sessionId: "minted", busy: false });
    expect(events.filter((f) => f.type === "sessions_changed").length).toBeGreaterThanOrEqual(3);
  });

  test("the model answering is the installation's default until somebody says otherwise", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);

    expect(agent.snapshot().model).toBe(agent.snapshot().model);
    expect(frames[0]).toMatchObject({ type: "ready" });
    // Before a session has ever opened there is no `Query` to ask, so the list is the fallback and
    // the installation's own model is first in it — the one entry certainly reachable.
    const first = frames.find((f) => f.type === "ready")!;
    expect(first.models[0]?.value).toBe(first.model);

    // The real list arrives once a session opens, and `ready` is re-sent to carry it.
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    await realModelList(frames);
    expect(frames.at(-1) !== undefined).toBe(true);
    const listed = frames.filter((f) => f.type === "ready").at(-1)!;
    // What the driver answered, in its order, plus the one entry curation adds to any list that
    // arrives without it — Claude Fable 5 is offered whatever the CLI says it can reach.
    expect(listed.models.map((option) => option.value)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
    ]);
    expect(sdk.calls[0]!.options.model).toBe(listed.model);
  });

  test("a model the CLI cannot reach is refused as a stale window rather than a conflict", async () => {
    fresh();
    const { agent } = agentFor(plainScript());
    const refused = await agent.setModel("gpt-4");
    expect(refused).toMatchObject({ ok: false, code: "invalid_request" });
    expect(refusalOf(refused)).toContain("not one this installation can reach");
  });

  test("changing it moves what the next session runs with, and tells every window", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);
    const installed = agent.snapshot().model;

    // First turn on the default, so there is a live query for the change to reach.
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    await realModelList(frames);

    expect(await agent.setModel("claude-sonnet-5")).toEqual({ ok: true });
    expect(agent.snapshot().model).toBe("claude-sonnet-5");
    // The live session is told — the SDK applies it to the NEXT turn — and every window is told,
    // because they are all drawing the same conversation.
    expect(sdk.calls[0]!.models).toEqual(["claude-sonnet-5"]);
    expect(frames.filter((f) => f.type === "ready").at(-1)!.model).toBe("claude-sonnet-5");

    // Putting the conversation down goes back to the installation's default: a model chosen for one
    // conversation was chosen for that conversation, and carrying it into the next would be this
    // process remembering a preference nobody expressed.
    expect(agent.clear()).toEqual({ ok: true });
    expect(agent.snapshot().model).toBe(installed);
  });

  test("chosen before the first turn, it is what the session is opened with", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);

    // No session exists yet, so there is no query to tell — the field alone is the whole of it, and
    // `startSession` is what turns it into the options a session actually runs with. This is the
    // half `Query.setModel` cannot do, and the reason both paths exist.
    expect(await agent.setModel("claude-sonnet-5")).toEqual({ ok: true });
    expect(sdk.calls).toHaveLength(0);

    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    expect(sdk.calls[0]!.options.model).toBe("claude-sonnet-5");
    // Told the field, never the live query: there was none when the choice was made.
    expect(sdk.calls[0]!.models).toEqual([]);
  });

  test("the SDK refusing the change rolls the choice back rather than lying about it", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    await realModelList(frames);

    const before = agent.snapshot().model;
    sdk.calls[0]!.setModelThrows = "the subprocess is not listening";
    const refused = await agent.setModel("claude-sonnet-5");
    expect(refused).toMatchObject({ ok: false, code: "conflict" });
    // The window would otherwise be told the model changed and every later turn would disagree.
    expect(agent.snapshot().model).toBe(before);
  });

  test("changing it is refused while a turn is in flight, on the guard resume and clear share", async () => {
    fresh();
    const turn = held();
    const { agent, sdk } = agentFor(turn.script);
    agent.submitTurn("what moved?");
    await waitUntil(() => (sdk.calls[0]?.prompts.length ?? 0) === 1, "the turn to be in flight");

    const refused = await agent.setModel("claude-sonnet-5");
    expect(refused).toMatchObject({ ok: false, code: "conflict" });
    expect(refusalOf(refused)).toContain("one answer written half by each");
    expect(sdk.calls[0]!.models).toEqual([]);

    turn.release();
    await settled(agent);
  });

  test("a fallback list stands when the CLI will not say what it can reach", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    // Set BEFORE the first session, because the fetch happens the instant one opens. A CLI too old
    // to answer, or one that failed: the picker is worth more with a handful of plausible names in
    // it than empty with an explanation, and a wrong name there costs a refusal rather than a
    // broken turn.
    sdk.supported = null;
    const frames = watch(agent);

    agent.submitTurn("hello");
    await arrives(frames, "turn_result");

    const listed = frames.filter((f) => f.type === "ready").at(-1)!;
    // The fallback and not the real list: the driver's entries carry display names of their own,
    // while every entry of this one is still labelled by its own value, minus the vendor prefix the
    // curation takes off every label on its way to the picker.
    expect(listed.models.length).toBeGreaterThan(2);
    expect(
      listed.models.every((option) => option.displayName === option.value.replace(/^claude-/, "")),
    ).toBe(true);
    // Whatever else is offered, the installation's own model is first — it is the one entry that is
    // certainly reachable, because it is the one already in use.
    expect(listed.models[0]?.value).toBe(listed.model);
    // And the same curation the answered list gets: Fable is among the hardcoded names, Haiku is
    // among none of them. A list that stands in for the real one has to stand for the same policy,
    // or the picker would offer a model for as long as a boot went unasked and then stop.
    expect(listed.models.map((option) => option.value)).toContain("claude-fable-5");
    expect(listed.models.some((option) => /haiku/.test(option.value))).toBe(false);
  });

  test("Haiku is dropped from what the CLI lists, and Fable is added to it", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    // Set BEFORE the first session, for the same reason as above. A CLI that offers Haiku under
    // both spellings, and no Fable at all: the two halves of the curation in one answer.
    sdk.supported = [
      { value: "claude-opus-5", displayName: "Opus 5" },
      { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
      { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
    ];
    const frames = watch(agent);

    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    await realModelList(frames);

    const listed = frames.filter((f) => f.type === "ready").at(-1)!;
    // Both spellings gone: the exclusion reads the name as a substring precisely so that a dated id
    // is not a way back in.
    expect(listed.models.some((option) => /haiku/.test(option.value))).toBe(false);
    expect(listed.models).toContainEqual({
      value: "claude-fable-5",
      displayName: "Fable 5",
    });

    // And the picker IS the whitelist, which is the whole reason curating one list is enough: what
    // it offers can be switched to, and what it hides is refused as a window that is out of date.
    expect(await agent.setModel("claude-fable-5")).toEqual({ ok: true });
    const refused = await agent.setModel("claude-haiku-4-5");
    expect(refused).toMatchObject({ ok: false, code: "invalid_request" });
    expect(refusalOf(refused)).toContain("not one this installation can reach");
  });

  test("a CLI that spells the models as aliases is curated by the ids they resolve to", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    // THE SHAPES BELOW ARE COPIED FROM A REAL ANSWER, not invented: this is verbatim what the
    // vendored CLI returns from `supportedModels()`. It is the case that matters, because not one
    // of these rows is spelled the way the model is named — Fable wears a bracketed context size
    // and Haiku is a bare alias — and a curation reading only `value` for an exact id sees a list
    // with no Fable in it and appends a second one. The picker then draws the same model twice.
    sdk.supported = [
      { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)" },
      { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)" },
      { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
    ];
    const frames = watch(agent);

    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    // Named rather than defaulted: this test scripted a list of its own, and none of its rows is
    // the one the driver would otherwise have answered with.
    await realModelList(frames, "Default (recommended)");

    const listed = frames.filter((f) => f.type === "ready").at(-1)!;
    // Exactly one Fable, and it is the CLI's own row rather than the written-in one: the model was
    // recognised, so nothing was added.
    const fable = listed.models.filter((option) => /fable/.test(option.value));
    expect(fable).toEqual([{ value: "claude-fable-5[1m]", displayName: "Fable" }]);
    // Haiku goes on the name it resolves to, which is the only place the word appears on that row.
    expect(listed.models.some((option) => /haiku/i.test(option.displayName))).toBe(false);
    expect(listed.models.map((option) => option.value)).toEqual([
      "default",
      "opus[1m]",
      "claude-fable-5[1m]",
      "sonnet",
    ]);
  });

  test("an effort level that is not one of the five is refused as a stale window", async () => {
    fresh();
    const { agent } = agentFor(plainScript());
    // The picker was drawn from these five names, so anything else is a window that is out of date
    // or a frame somebody wrote by hand — and neither gets better by being sent again, which is what
    // makes this `invalid_request` rather than a conflict to retry. The refusal names the five,
    // because the reader it is written for is the one debugging a frame.
    const refused = await agent.setEffort("extreme");
    expect(refused).toMatchObject({ ok: false, code: "invalid_request" });
    expect(refusalOf(refused)).toContain("is not an effort level");
    expect(refusalOf(refused)).toContain("low, medium, high, xhigh, max");
  });

  test("changing the level reaches the live session and every window, and clearing puts it back", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const one = watch(agent);
    // A second window, because the frame this change produces is broadcast rather than answered: a
    // tab that did not ask has to end up drawing the same conversation as the one that did.
    const two = watch(agent);
    expect(agent.snapshot().effort).toBe("high");

    // First turn on the default, so there is a live session for the change to reach.
    agent.submitTurn("hello");
    await arrives(one, "turn_result");

    expect(await agent.setEffort("max")).toEqual({ ok: true });
    expect(agent.snapshot().effort).toBe("max");
    // The live session is told through its flag layer — the SDK applies it to the NEXT turn — and
    // the level is the ONLY key merged into it. A second one appearing here would mean this agent
    // had quietly started writing settings it never asked for.
    expect(sdk.calls[0]!.efforts).toEqual(["max"]);
    expect(one.filter((f) => f.type === "ready").at(-1)!.effort).toBe("max");
    expect(two.filter((f) => f.type === "ready").at(-1)!.effort).toBe("max");

    // Putting the conversation down goes back to `high`, where every conversation starts. A level
    // chosen because THIS question was hard was chosen for this question, and carrying it into the
    // next one would be the agent remembering a preference nobody expressed.
    expect(agent.clear()).toEqual({ ok: true });
    expect(agent.snapshot().effort).toBe("high");
    expect(one.filter((f) => f.type === "ready").at(-1)!.effort).toBe("high");
  });

  test("a level chosen before the first turn is what the session is opened with", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);

    // No session exists yet, so there is no flag layer to merge anything into: the field alone is
    // the whole of it, and `buildAgentOptions` is what turns it into the options a session actually
    // runs with. This is the half `applyFlagSettings` cannot do, and the reason both paths exist.
    expect(await agent.setEffort("low")).toEqual({ ok: true });
    expect(sdk.calls).toHaveLength(0);

    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    expect(sdk.calls[0]!.options.effort).toBe("low");
    // Told the field, never the live query: there was none when the choice was made.
    expect(sdk.calls[0]!.efforts).toEqual([]);
  });

  test("the SDK refusing the level rolls the choice back rather than lying about it", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");

    const before = agent.snapshot().effort;
    sdk.calls[0]!.applyFlagSettingsThrows = "the subprocess is not listening";
    // A level the conversation is not already at, because a request for the one it is at is answered
    // without the live session being told anything — there would be nothing for the SDK to refuse.
    const refused = await agent.setEffort("low");
    expect(refused).toMatchObject({ ok: false, code: "conflict" });
    expect(refusalOf(refused)).toContain("would not change effort level");
    // Otherwise every window would be told the level moved while every later turn disagreed — and
    // the disagreement would only ever show up in what a turn cost.
    expect(agent.snapshot().effort).toBe(before);
  });

  test("changing the level is refused while a turn is in flight, on the guard the model shares", async () => {
    fresh();
    const turn = held();
    const { agent, sdk } = agentFor(turn.script);
    agent.submitTurn("what moved?");
    await waitUntil(() => (sdk.calls[0]?.prompts.length ?? 0) === 1, "the turn to be in flight");

    const refused = await agent.setEffort("max");
    expect(refused).toMatchObject({ ok: false, code: "conflict" });
    expect(refusalOf(refused)).toContain("one answer thought about half at each level");
    // Refused before anything was seated, so the live session was never told either — a rollback
    // that had to happen would mean the guard had let this through.
    expect(sdk.calls[0]!.efforts).toEqual([]);

    turn.release();
    await settled(agent);
  });

  test("a session that never opened at all is not retried a second time", async () => {
    fresh();
    const { agent, sdk } = agentFor(() => {
      throw new Error("the executable is missing");
    });
    const frames = watch(agent);

    agent.submitTurn("hello");
    await arrives(frames, "error");

    // Nothing was being reopened, so there is no lost conversation to explain the failure and
    // nothing to gain from opening a second identical session.
    expect(sdk.calls).toHaveLength(1);
    expect(frames.find((f) => f.type === "error")).toMatchObject({ code: "internal" });
  });

  test("neither resuming nor clearing may happen while a turn is in flight", async () => {
    fresh();
    const turn = held();
    const { agent, sdk } = agentFor(turn.script);
    agent.submitTurn("what moved?");
    await waitUntil(() => (sdk.calls[0]?.prompts.length ?? 0) === 1, "the turn to be in flight");

    const resumed = agent.resume("another");
    expect(resumed).toMatchObject({ ok: false, code: "conflict" });
    expect(refusalOf(resumed)).toContain("the agent is still working");
    expect(refusalOf(resumed)).toContain(
      "would leave an answer being written into one nobody is reading",
    );

    const cleared = agent.clear();
    expect(cleared).toMatchObject({ ok: false, code: "conflict" });
    expect(refusalOf(cleared)).toContain("would abandon a turn already in flight");

    // Refused, so nothing moved: the conversation is still the one being answered.
    expect(agent.snapshot()).toMatchObject({ sessionId: null, fresh: true });
    turn.release();
    await settled(agent);
  });

  test("a turn merely waiting behind the current one is enough to refuse both", async () => {
    fresh();
    const { agent } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("first");
    await arrives(frames, "turn_result");

    // Nothing is awaited between these lines on purpose. A turn that has been offered and not yet
    // picked up is its own branch of the guard — the agent is idle and something is still owed —
    // and it is the one a check that only ever read `busy` would miss.
    agent.submitTurn("second");
    expect(agent.snapshot()).toMatchObject({ busy: false, queued: 1 });
    expect(agent.resume("another")).toMatchObject({ ok: false, code: "conflict" });
    expect(agent.clear()).toMatchObject({ ok: false, code: "conflict" });

    await waitUntil(
      () => frames.filter((f) => f.type === "turn_result").length === 2,
      "the queued turn to run anyway",
    );
  });

  test("a generation in progress refuses them too", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, startGeneration } = agentFor(turn.script, WITH_ENGINE);
    agent.submitTurn("write it");
    await waitUntil(() => agent.snapshot().busy, "the turn to start");
    expect(startGeneration(recipeId).ok).toBe(true);

    // A procedure is a piece of work the conversation is carrying, not merely a turn in it, so it
    // guards the identity of the conversation for its whole length. The turn it rides would refuse
    // these two on its own now — a procedure cannot be open without one — and the gate's term in
    // the guard stays because that implication belongs to the tool layer rather than to this class.
    expect(agent.resume("another")).toMatchObject({ ok: false, code: "conflict" });
    expect(agent.clear()).toMatchObject({ ok: false, code: "conflict" });

    turn.release();
    await settled(agent);
  });

  test("resuming while idle closes the live session and the next turn reopens by name", async () => {
    fresh();
    const { agent, sdk, events } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("first");
    await arrives(frames, "turn_result");

    expect(agent.resume("an-older-one")).toEqual({ ok: true });
    // Ended FIRST, because there is only ever one session: a query still holding the old
    // conversation would answer the next turn out of it.
    expect(sdk.calls[0]!.returned).toBe(true);
    expect(frames.filter((f) => f.type === "ready").at(-1)).toMatchObject({
      fresh: false,
      sessionId: "an-older-one",
    });
    expect(events.filter((f) => f.type === "sessions_changed").at(-1)).toEqual({
      type: "sessions_changed",
    });

    // Nothing was started by the resume itself. A query opened for a conversation nobody has said
    // anything to yet would spend a subprocess on the chance that they will.
    expect(sdk.calls).toHaveLength(1);
    agent.submitTurn("second");
    await waitUntil(() => sdk.calls.length === 2, "the next turn to open the named session");
    expect(sdk.calls[1]!.options.resume).toBe("an-older-one");
  });

  test("clearing puts the conversation down and the next turn starts empty", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("first");
    await arrives(frames, "turn_result");
    expect(agent.snapshot()).toMatchObject({ sessionId: "session-1", fresh: true });

    expect(agent.clear()).toEqual({ ok: true });
    expect(sdk.calls[0]!.returned).toBe(true);
    // The old session is not deleted — it is still in the SDK's store, still resumable. "Clear" is
    // about what the model is carrying, not about what the archive keeps.
    expect(agent.snapshot()).toMatchObject({ sessionId: null, fresh: true });

    agent.submitTurn("second");
    await waitUntil(() => sdk.calls.length === 2, "the next turn to open a fresh session");
    expect(sdk.calls[1]!.options.resume).toBeUndefined();
  });

  test("a compaction reaches the window with the SDK's own word for why", async () => {
    fresh();
    const { agent } = agentFor(() => [
      init("s"),
      compaction({ trigger: "manual" }),
      says("Where were we."),
      done("s"),
    ]);
    const frames = watch(agent);
    agent.submitTurn("carry on");
    await arrives(frames, "turn_result");

    // It earns a frame because it is the one thing that happens to a conversation with nobody
    // asking: a window that refetches afterwards finds its earlier half gone, and without a marker
    // in the stream that reads as amnesia rather than as compaction.
    expect(frames.find((f) => f.type === "compacted")).toEqual({
      type: "compacted",
      trigger: "manual",
    });
  });

  test("a compaction with no stated trigger still says it happened", async () => {
    fresh();
    const { agent } = agentFor(() => [init("s"), compaction(), done("s")]);
    const frames = watch(agent);
    agent.submitTurn("carry on");
    await arrives(frames, "turn_result");
    expect(frames.find((f) => f.type === "compacted")).toEqual({ type: "compacted", trigger: "auto" });
  });
});

// -- backpressure and control ------------------------------------------------------------------

/** A turn the test holds open, so the conversation can be watched while it is actually working
 * rather than reconstructed from what it left behind. */
function held(): { script: Scripted; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    script: async () => {
      await gate;
      return [init("s"), says("Done."), done("s")];
    },
    release: () => release(),
  };
}

/** A held turn that falls over when it is released, for the endings that are failures rather than
 * stops. A procedure has to be opened from inside a turn, so a script that throws immediately
 * leaves no window to open one in. */
function heldThenThrows(): { script: Scripted; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    script: async () => {
      await gate;
      throw new Error("the subprocess died");
    },
    release: () => release(),
  };
}

/** An agent with a window already attached, for the tests that watch frames from the first one. */
function agentForWatched(script: Scripted, venv: VenvStatus = NO_ENGINE) {
  const built = agentFor(script, venv);
  return { ...built, frames: watch(built.agent) };
}

/** The sentence a refusal carried, for a union whose ok branch has no message. */
function refusalOf(result: { ok: true } | { ok: false; message: string }): string {
  if (result.ok) throw new Error("expected a refusal, got a result");
  return result.message;
}

// -- delegating ----------------------------------------------------------------------------------

/**
 * Turning delegation on and off, which is the one answering fact that cannot be moved under a live
 * session.
 *
 * Shaped like the effort block above because it answers the same kind of question about a
 * conversation, and it diverges in exactly one place: what a change COSTS. A model or a level
 * reaches the running subprocess through the control plane; an allow list is what the subprocess was
 * started with, so the agent ends the session and lets the next turn reopen the same conversation.
 * Every test here is about that end-and-reopen — that it happens, that it does not happen when there
 * is nothing to change, and that it is refused rather than done while somebody is waiting for an
 * answer.
 */
describe("delegating to subagents", () => {
  test("flipping it between turns ends the session and tells every window", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const one = watch(agent);
    // A second window, because this frame is broadcast rather than answered: a tab that did not ask
    // has to end up drawing the same conversation as the one that did.
    const two = watch(agent);
    expect(agent.snapshot().subagents).toBe(true);

    agent.submitTurn("hello");
    await arrives(one, "turn_result");

    expect(await agent.setSubagents(false)).toEqual({ ok: true });
    expect(agent.snapshot().subagents).toBe(false);
    // The live session is put DOWN rather than told anything: there is no control-plane call for
    // this, and a session that stayed open would go on answering with the surface it was started
    // with while every window drew the other one.
    expect(sdk.calls[0]!.returned).toBe(true);
    expect(one.filter((f) => f.type === "ready").at(-1)!.subagents).toBe(false);
    expect(two.filter((f) => f.type === "ready").at(-1)!.subagents).toBe(false);

    // And the conversation survives it. The session id was minted by the first turn and is still in
    // memory, so the next turn reopens THAT conversation — with the delegation tools gone, which is
    // the whole point of having ended the session.
    agent.submitTurn("and again");
    await waitUntil(() => sdk.calls.length === 2, "the next turn to reopen the conversation");
    expect(sdk.calls[1]!.options.resume).toBe("session-1");
    expect(sdk.calls[1]!.options.allowedTools).not.toContain("Agent");
  });

  test("flipping it mid-turn is refused, and nothing is ended", async () => {
    fresh();
    const turn = held();
    const { agent, sdk } = agentFor(turn.script);
    agent.submitTurn("what moved?");
    await waitUntil(() => (sdk.calls[0]?.prompts.length ?? 0) === 1, "the turn to be in flight");

    const refused = await agent.setSubagents(false);
    expect(refused).toMatchObject({ ok: false, code: "conflict" });
    expect(refusalOf(refused)).toContain("ends the session it is answering out of");
    // The guard is what stands between this control and an abandoned answer, so the session is still
    // open and the agent still holds the surface it started with.
    expect(sdk.calls[0]!.returned).toBe(false);
    expect(agent.snapshot().subagents).toBe(true);

    turn.release();
    await settled(agent);
  });

  test("asking for the surface it already has ends nothing", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");

    // Answered without touching anything. Tearing a session down to rebuild an identical one would
    // cost the model everything it was carrying, in exchange for a surface it already had.
    expect(await agent.setSubagents(true)).toEqual({ ok: true });
    expect(sdk.calls[0]!.returned).toBe(false);
    expect(sdk.calls).toHaveLength(1);
  });

  test("clearing and resuming both put it back to the default", async () => {
    fresh();
    const { agent } = agentFor(plainScript());
    expect(await agent.setSubagents(false)).toEqual({ ok: true });
    // A decision to answer one question without help was made about THAT question; carrying it into
    // the next conversation would be this process remembering a preference nobody expressed.
    expect(agent.clear()).toEqual({ ok: true });
    expect(agent.snapshot().subagents).toBe(true);

    expect(await agent.setSubagents(false)).toEqual({ ok: true });
    expect(agent.resume("an-older-one")).toEqual({ ok: true });
    expect(agent.snapshot().subagents).toBe(true);
  });

  test("turned off before the first turn, the first session simply opens without it", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);

    // Nothing exists to be ended yet, which is the case that would look identical if the flip were
    // silently doing nothing — so what it opens with is the assertion.
    expect(await agent.setSubagents(false)).toEqual({ ok: true });
    expect(sdk.calls).toHaveLength(0);

    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    for (const tool of SUBAGENT_TOOLS) {
      expect(sdk.calls[0]!.options.allowedTools).not.toContain(tool);
    }
    expect(sessionSettings(sdk.calls[0]!.options).enableWorkflows).toBeUndefined();
  });
});

describe("backpressure and control", () => {
  test("a second message while a turn is in flight is refused as busy and never reaches the model", async () => {
    fresh();
    const turn = held();
    const { agent, sdk } = agentFor(async (_prompt, call) => {
      if (call.prompts.length === 1) return turn.script("", call);
      return [init("s"), says("ok"), done("s")];
    });
    const frames = watch(agent);

    expect(agent.submitTurn("q0")).toBe(true);
    await waitUntil(() => (sdk.calls[0]?.prompts.length ?? 0) === 1, "the first turn to start");

    // ONE TURN AT A TIME: there is no queue to get ahead of the agent into. The refusal names the
    // way out, because a refusal a person cannot act on is one they will retry.
    expect(agent.submitTurn("a second thought")).toBe(false);
    expect(agent.snapshot().queued).toBe(0);
    const refusal = frames.find((f) => f.type === "error");
    expect(refusal).toMatchObject({ code: "busy" });
    expect((refusal as { message: string }).message.toLowerCase()).toContain("interrupt");

    // And the refusal ends when the turn does: the same sentence, sent again, goes through.
    turn.release();
    await waitUntil(
      () => frames.filter((f) => f.type === "turn_result").length === 1,
      "the held turn to finish",
    );
    expect(agent.submitTurn("a second thought")).toBe(true);
    await waitUntil(
      () => frames.filter((f) => f.type === "turn_result").length === 2,
      "the second turn to run",
    );
    expect(sdk.calls[0]!.prompts).toContain("a second thought");
  });

  test("an interrupt reaches the session and a turn in the handoff window survives it", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("first");
    await arrives(frames, "turn_result");

    // Submitted while idle, so it is accepted — and interrupted before anything awaits it. The
    // only way a turn WAITS at all now is this handoff window between the offer and the drive loop
    // picking it up, and a question caught in it is still a question the user asked: dropping it
    // silently would answer nothing while looking like it had.
    agent.submitTurn("second");
    await agent.interrupt();
    expect(sdk.calls[0]!.interrupts).toBe(1);
    await waitUntil(
      () => frames.filter((f) => f.type === "turn_result").length === 2,
      "the accepted turn to still run",
    );
  });

  test("a listener that throws does not take the turn with it", async () => {
    fresh();
    const { agent } = agentFor(plainScript());
    agent.attach(() => {
      throw new Error("the socket closed mid-write");
    });
    const frames = watch(agent);
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
  });

  test("detaching stops delivery without stopping the conversation", async () => {
    fresh();
    const { agent } = agentFor(plainScript());
    const frames: OutboundFrame[] = [];
    const detach = agent.attach((frame) => frames.push(frame));
    detach();

    agent.submitTurn("closed the tab");
    await settled(agent);
    // Attaching is a subscription, not a session: the only frame this window ever saw is the one
    // it was given for attaching.
    expect(frames.map((f) => f.type)).toEqual(["ready"]);
  });

  test("an empty message is not a turn", () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    expect(agent.submitTurn("   \n ")).toBe(false);
    expect(sdk.calls).toHaveLength(0);
  });
});

// -- the generation procedure ------------------------------------------------------------------

describe("the generation procedure", () => {
  /**
   * An agent with a turn in flight, which is the only state a procedure can be opened in.
   *
   * A PROCEDURE RIDES THE TURN THAT OPENS IT. It used to be the other way round — a route opened one
   * and the harness queued a turn to work on it — so these tests used to start from an idle agent
   * and the gate refused if anything at all was in flight. The two arrangements want opposite
   * fixtures, which is why nearly every test in this describe changed shape rather than wording.
   */
  async function working(script: Scripted, venv: VenvStatus = WITH_ENGINE) {
    const built = agentFor(script, venv);
    const frames = watch(built.agent);
    built.agent.submitTurn("write the report");
    await waitUntil(() => built.agent.snapshot().busy, "the turn to be in flight");
    return { ...built, frames };
  }

  /** A start that was supposed to succeed, narrowed so a suite reports the refusal's own words
   * rather than failing on a property the refusal branch does not have. */
  function must(started: ProcedureStart): { generationId: string; recipeId: string } {
    if (!started.ok) {
      throw new Error(`the generation was refused: ${started.code} — ${started.message}`);
    }
    return { generationId: started.generationId, recipeId: started.recipeId };
  }

  /** The other side of the same union. */
  function refused(started: ProcedureStart): { code: string; message: string } {
    if (started.ok) throw new Error("the generation started when it should have been refused");
    return { code: started.code, message: started.message };
  }

  test("names the recipe it works to, on the frame and on the snapshot alike", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, frames, startGeneration } = await working(turn.script);
    expect(agent.snapshot().generation).toBeNull();

    const started = must(startGeneration(recipeId));
    // THE RECIPE IS THE WHOLE PIN, and this test used to be about a second one. Instructions were a
    // version ledger, so a procedure had to hold the workshop AND the exact version row in force
    // when it opened, and the test that stood here revised the playbook mid-procedure to prove the
    // pin did not follow the head. A recipe's text cannot change — `recipe_moves_only_its_status`
    // refuses the UPDATE, tested where it lives — so there is no second identifier to carry and no
    // drift for a test to construct. What is left to pin is that the ONE identifier is reported
    // identically everywhere.
    expect(started.recipeId).toBe(recipeId);
    // The recipe rides on the frame because the conversation is GLOBAL and the procedure is not:
    // "a generation started" without saying whose is a sentence no window can draw. The
    // whole-object comparison is what pins the frame's shape: the recipe's TEXT does not ride on it,
    // because a window draws a recipe as a record rather than out of a chat frame.
    expect(frames.find((f) => f.type === "generation_started")).toEqual({
      type: "generation_started",
      generationId: started.generationId,
      recipeId,
    });
    expect(agent.snapshot().generation).toEqual({ id: started.generationId, recipeId });

    turn.release();
    await arrives(frames, "generation_ended");
  });

  test("refuses a recipe nothing is stored under, by the id it was given", async () => {
    fresh();
    const nobody = newId();
    const turn = held();
    const { agent, startGeneration } = await working(turn.script);

    // The guarantee is enforced by naming rather than by construction — this agent reaches a
    // recipe only through the id it is handed — so a name nothing answers to is where it bites.
    // The tool resolves an id or a name before it gets here; this is the layer behind that, and it
    // is what answers for a recipe deleted between the two.
    const no = refused(startGeneration(nobody));
    expect(no.code).toBe("not_found");
    expect(no.message).toBe(`no recipe ${nobody}`);
    expect(agent.snapshot().generation).toBeNull();
    turn.release();
    await settled(agent);
  });

  test("refuses a retired recipe, and names the one move that would revive it", async () => {
    fresh();
    // A specification somebody stopped writing reports to. There is no such state for the thing
    // this replaced — a workshop was refused for having NO playbook at all, which a recipe cannot
    // be, since its text is written at INSERT and never moves.
    const recipe = createRecipe(h.db, "Retired semis", "Write two reports, weekly.");
    setRecipeStatus(h.db, recipe.id, "inactive");
    const turn = held();
    const { agent, startGeneration } = await working(turn.script);

    const no = refused(startGeneration(recipe.id));
    // A conflict rather than a not-found: the row is there and readable, and what is being refused
    // is writing something NEW to it.
    expect(no.code).toBe("conflict");
    expect(no.message).toContain("is inactive");
    expect(no.message).toContain("no longer in use");
    // The way out, because a refusal the caller cannot act on is just a retry — and the person who
    // meant to write this report is one call away from being able to.
    expect(no.message).toContain("set_recipe_status");
    expect(agent.snapshot().generation).toBeNull();
    turn.release();
    await settled(agent);
  });

  test("refuses when the measurement engine is not installed", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    // The default venv for this file, which is the honest state of most machines running the suite.
    const { agent, startGeneration } = await working(turn.script, NO_ENGINE);

    const no = refused(startGeneration(recipeId));
    expect(no.code).toBe("engine_unavailable");
    expect(no.message).toContain("could not measure anything it claims");
    expect(agent.snapshot().generation).toBeNull();
    turn.release();
    await settled(agent);
  });

  test("refuses when there is no turn in flight for the procedure to ride", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const { agent, frames, startGeneration } = agentForWatched(plainScript(), WITH_ENGINE);
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");

    // THE GUARD THAT REPLACED THE OPPOSITE ONE. The gate used to refuse while the agent was busy,
    // which was right when a route opened procedures from outside the conversation: an unrelated
    // turn still going would have put its runs in the report's log. In-turn, the work in flight IS
    // the caller — and what has to be refused instead is a start with no turn to ride, because
    // nothing would ever reach the turn-end that closes it. The archive would stay frozen and
    // `resume` and `clear` would refuse for the rest of the boot.
    //
    // Unreachable on this path, where tools run in-process during a turn; real on opencode's, where
    // a `tools/call` arrives over HTTP and can race an abort.
    const no = refused(startGeneration(recipeId));
    expect(no.code).toBe("conflict");
    expect(no.message).toContain("rides the turn that opens it");
    expect(no.message).toContain("nothing would ever close the procedure it opened");
    expect(agent.snapshot().generation).toBeNull();
    expect(frames.some((f) => f.type === "generation_started")).toBe(false);
  });

  test("refuses a second procedure and says which recipe is holding the first", async () => {
    fresh();
    const mine = seedRecipe(h.db, "mine");
    const yours = seedRecipe(h.db, "yours");
    const turn = held();
    const { agent, startGeneration } = await working(turn.script);
    const started = must(startGeneration(mine));

    // With one conversation for the whole installation this guard bites ACROSS recipes: two
    // procedures at once would interleave their measurements in a single stream of tool calls, and
    // neither report could say which runs were its own.
    const no = refused(startGeneration(yours));
    expect(no.code).toBe("conflict");
    expect(no.message).toContain(`a generation procedure is already running, under recipe ${mine}`);
    // The way out is what the caller can actually do about it. It used to say "cancel it", which
    // was advice for the person at the button; the caller here is the model, and what it can do is
    // finish the procedure it is already inside.
    expect(no.message).toContain("finish it");
    expect(agent.snapshot().generation).toMatchObject({
      id: started.generationId,
      recipeId: mine,
    });

    turn.release();
    await settled(agent);
  });

  test("a turn that finishes without publishing ends the procedure as completed", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, frames, startGeneration } = await working(turn.script);
    const started = must(startGeneration(recipeId));

    turn.release();
    await arrives(frames, "generation_ended");

    // Not an error. The agent was asked for a report and answered — saying why there is not one is
    // the finished answer this outcome exists to name. It is also what closes a procedure the model
    // opened and then wandered away from, which is why the brief tells it to publish before it
    // stops.
    expect(frames.find((f) => f.type === "generation_ended")).toEqual({
      type: "generation_ended",
      generationId: started.generationId,
      reason: "completed",
    });
    expect(frames.filter((f) => f.type === "generation_ended")).toHaveLength(1);
    expect(agent.snapshot().generation).toBeNull();
  });

  test("a second turn cannot enter a procedure: refused while it rides, run after it closes", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, frames, startGeneration } = await working(turn.script);
    must(startGeneration(recipeId));

    // The rule this used to pin by ORDERING — the drive loop closed the gate before taking the
    // next queued turn, so a waiting turn's runs could never land in the procedure's log — is now
    // pinned one step earlier: there is no queue, and a message sent while the procedure's turn is
    // in flight is refused outright. Same fact, sharper mechanism.
    expect(agent.submitTurn("and something else")).toBe(false);
    turn.release();
    await arrives(frames, "generation_ended");

    // The same sentence, sent after the close, runs as an ordinary turn outside any procedure.
    expect(agent.submitTurn("and something else")).toBe(true);
    await waitUntil(
      () => frames.filter((f) => f.type === "turn_result").length === 2,
      "both turns to finish",
    );
    const ended = frames.findIndex((f) => f.type === "generation_ended");
    const secondStarted = frames.map((f) => f.type).lastIndexOf("turn_started");
    expect(ended).toBeGreaterThan(-1);
    expect(ended).toBeLessThan(secondStarted);
    expect(frames.filter((f) => f.type === "generation_ended")).toHaveLength(1);
  });

  test("interrupting the turn ends the procedure as cancelled", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, sdk, frames, startGeneration } = await working(turn.script);
    const started = must(startGeneration(recipeId));

    // STOPPING THE TURN IS STOPPING THE PROCEDURE, and there is no other way to stop one: the
    // cancel route is gone, and so is the workshop-scoped `cancelGeneration` that answered it. The
    // procedure rides this turn and there is no other turn it could be riding, so the gesture that
    // stops a turn is the whole of what a cancel was.
    await agent.interrupt();
    expect(agent.snapshot().generation).toBeNull();
    // Cancelled rather than completed, which is the reason this is wired into `interrupt` at all:
    // letting the turn-end close it would tell the user the procedure "finished without
    // publishing" when what actually happened is that they stopped it.
    expect(frames.find((f) => f.type === "generation_ended")).toEqual({
      type: "generation_ended",
      generationId: started.generationId,
      reason: "cancelled",
    });
    expect(sdk.calls[0]!.interrupts).toBe(1);

    // And the turn running itself out is not a second ending: the procedure ended once, and a
    // client drawing a second would draw it for nothing.
    turn.release();
    await arrives(frames, "turn_result");
    expect(frames.filter((f) => f.type === "generation_ended")).toHaveLength(1);
  });

  test("interrupting with no procedure open ends nothing", async () => {
    fresh();
    const turn = held();
    const { agent, frames } = await working(turn.script);

    await agent.interrupt();
    expect(frames.some((f) => f.type === "generation_ended")).toBe(false);
    turn.release();
    await arrives(frames, "turn_result");
  });

  test("a turn that throws ends it as error, beside the failure itself", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = heldThenThrows();
    const { agent, frames, startGeneration } = await working(turn.script);
    const started = must(startGeneration(recipeId));

    turn.release();
    await arrives(frames, "generation_ended");

    expect(frames.find((f) => f.type === "generation_ended")).toEqual({
      type: "generation_ended",
      generationId: started.generationId,
      reason: "error",
    });
    // Both frames, because they answer different questions: what went wrong, and that the thing the
    // user is watching has stopped.
    expect(frames.find((f) => f.type === "error")).toMatchObject({ code: "internal" });
    void agent;
  });

  test("disposing the agent ends it as error rather than leaving it drawn as running", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, frames, startGeneration } = await working(turn.script);
    const started = must(startGeneration(recipeId));

    agent.dispose();

    // Emitted before the listeners are dropped, which is the whole reason the ordering in `dispose`
    // is what it is: anyone attached learns why it stopped instead of watching "generating" until
    // they reload.
    expect(frames.find((f) => f.type === "generation_ended")).toEqual({
      type: "generation_ended",
      generationId: started.generationId,
      reason: "error",
    });
    expect(agent.snapshot().generation).toBeNull();
    turn.release();
  });
});

// -- what a failure writes down -------------------------------------------------------------------

describe("what a failure writes down", () => {
  test("a turn that throws leaves one row a person can read afterwards", async () => {
    fresh();
    const { agent } = agentFor(() => {
      throw new Error("the subprocess died");
    });
    const frames = watch(agent);

    agent.submitTurn("hello");
    await arrives(frames, "error");

    // Logged as well as emitted, and the two are not redundant: the frame reaches whoever is
    // watching right now, and a turn that fell over while nobody was is exactly the failure worth
    // being able to read later.
    const rows = listErrors(h.db).entries;
    expect(rows.map((row) => row.scope)).toEqual(["turn"]);
    expect(rows[0]!.message).toBe("the subprocess died");
    // The stack rides along, because a message is what a person reads and a stack is what tells
    // them where to look.
    expect(rows[0]!.detail).toContain("Error");
  });

  test("a generation that dies files a second row, because it is a second fact", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = heldThenThrows();
    const { agent, startGeneration } = agentFor(turn.script, WITH_ENGINE);
    const frames = watch(agent);
    agent.submitTurn("write it");
    await waitUntil(() => agent.snapshot().busy, "the turn to be in flight");
    expect(startGeneration(recipeId).ok).toBe(true);

    turn.release();
    await arrives(frames, "generation_ended");

    // Two rows for one collapse, deliberately: a turn failed, and a piece of work the user started
    // and is waiting on ended without producing anything. Reading the log for the second question
    // should not mean sifting every broken turn for the ones that happened to be procedures.
    const rows = listErrors(h.db).entries;
    expect(rows.map((row) => row.scope)).toEqual(["generation", "turn"]);
    expect(rows[0]!.message).toBe(
      `the generation procedure under recipe ${recipeId} ended in error`,
    );
    expect(rows[0]!.detail).toContain(recipeId);
  });

  test("a procedure that merely ends without a report files nothing", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const turn = held();
    const { agent, startGeneration } = agentFor(turn.script, WITH_ENGINE);
    const frames = watch(agent);
    agent.submitTurn("write it");
    await waitUntil(() => agent.snapshot().busy, "the turn to be in flight");
    expect(startGeneration(recipeId).ok).toBe(true);

    turn.release();
    await arrives(frames, "generation_ended");

    // `completed` is the procedure working. Filing it would bury the real failures under a record
    // of ordinary use, which is the one thing that makes a log nobody reads.
    expect(listErrors(h.db).entries).toHaveLength(0);
  });
});

// -- options and prompt ------------------------------------------------------------------------

/**
 * The five tools a session may delegate through, written out here rather than imported.
 *
 * `SUBAGENT_TOOLS` is private to the options module, and it stays that way: what this file is
 * checking is that the surface a session runs with is the one somebody meant, and a list imported
 * from the module under test would agree with itself no matter what it said. Spelled out, a name
 * dropped from the module is a failure here, and a sixth added there is a deliberate edit to this
 * list as well.
 */
const SUBAGENT_TOOLS = ["Agent", "Workflow", "TaskOutput", "TaskStop", "SendMessage"];

/**
 * The delegation tool this installation refuses, named on its own because the reason is not shape.
 *
 * `Monitor` takes a shell command of its own. The generation-time engine guard in `agent/hooks.ts`
 * is matched on the tool named `Bash`, so a command arriving under a second name is one that guard
 * never reads — and what that guard holds up is the promise that while a report is being generated
 * the engine is reached through the run tools that write the run log. This assertion is the lock on
 * that decision: granting `Monitor` is not a tweak to a list, it is a second door into the shell.
 */
const REFUSED_DELEGATION_TOOL = "Monitor";

/**
 * The settings object a session was built with.
 *
 * The SDK's own option is `string | Settings` — a path to a settings file, or the settings
 * themselves — and YewReview always passes the object: a path would name a file this process never
 * wrote. The narrowing is here so the assertions below can read a key instead of restating that
 * every time.
 */
function sessionSettings(options: Options): Exclude<Options["settings"], string | undefined> {
  const settings = options.settings;
  if (settings === undefined || typeof settings === "string") {
    throw new Error("the session's settings are built as an object here, never named as a file");
  }
  return settings;
}

describe("the options a session runs with", () => {
  test("the full builtin toolset, dontAsk, and the one home the installation has", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    agent.submitTurn("hello");
    await waitUntil(() => (sdk.calls[0]?.prompts.length ?? 0) === 1, "the session to open");

    const options = sdk.calls[0]!.options;
    // `tools` unset is the capability decision: the agent gets the whole builtin set.
    expect(options.tools).toBeUndefined();
    expect(options.allowedTools).toContain("Bash");
    expect(options.allowedTools).toContain("Write");
    // And delegation is ON unless the conversation says otherwise — the two capability tools are
    // allowed by default, and the feature they need is named in the session's settings. The pair is
    // asserted together because either alone is a surface that half works: the tools without the
    // feature, or a feature nothing may reach.
    expect(options.allowedTools).toContain("Agent");
    expect(options.allowedTools).toContain("Workflow");
    // Every name in the group, not just the two that are the capability: the three beside them are
    // what makes delegation finishable — start it, steer it, read it back — and a surface missing
    // one of those is the half-granted one this list exists to catch.
    for (const tool of SUBAGENT_TOOLS) expect(options.allowedTools).toContain(tool);
    // And the one that is refused even here, for the reason written at the constant.
    expect(options.allowedTools).not.toContain(REFUSED_DELEGATION_TOOL);
    expect(sessionSettings(options).enableWorkflows).toBe(true);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.settingSources).toEqual([]);
    expect(options.sandbox?.enabled).toBe(true);

    // The cwd is also the SDK's project key, which is why it must be ONE fixed directory: every
    // session this installation has ever had lands in a single bucket, and that bucket, listed, IS
    // the session list the window resumes from.
    expect(options.cwd).toBe(homeDir(h.settings));
    expect(options.env?.["YEWREVIEW_HOME"]).toBe(homeDir(h.settings));
    // There are no per-recipe directories to name, so there is no variable naming one — under
    // either spelling, since the record this env once pointed at is itself gone.
    expect(options.env?.["YEWREVIEW_RECIPE"]).toBeUndefined();
    expect(options.env?.["YEWREVIEW_WORKSHOP"]).toBeUndefined();
    expect(options.env?.["YEWREVIEW_VAR_DIR"]).toBe(h.settings.varDir);
    // No engine in this environment, so no interpreter is named — a path to one that does not
    // exist would only invite the agent to run it.
    expect(options.env?.["YEWREVIEW_PYTHON"]).toBeUndefined();

    // The store lands under `var/`, which is what makes `rm -rf var/` a complete reset and keeps
    // two installations pointed at different var-dirs from sharing one history.
    expect(options.env?.["CLAUDE_CONFIG_DIR"]).toBe(paths(h.settings).claudecodeDir);
    // And the LOGIN does not move with it. Defined-but-empty is how the CLI is told "credentials
    // live at the machine default" — undefined would make it derive them from the config directory
    // above, i.e. a keychain entry nobody has ever logged into. Asserted as `""` rather than as
    // "defined", because the whole meaning is in the emptiness.
    expect(options.env?.["CLAUDE_SECURESTORAGE_CONFIG_DIR"]).toBe("");
  });

  test("YewReview's own tools are wired in by default, qualified and allowed", async () => {
    fresh();
    // No `tools` factory is passed here on purpose: `main.ts` does not pass one either, so the
    // default is what actually ships. An agent that silently ran with no YewReview tools would look
    // fine in every other test in this file.
    const { agent, sdk } = agentFor(plainScript());
    agent.submitTurn("hello");
    await waitUntil(() => (sdk.calls[0]?.prompts.length ?? 0) === 1, "the session to open");

    const options = sdk.calls[0]!.options;
    expect(options.mcpServers).toHaveProperty("yewreview");
    expect(options.allowedTools).toContain("mcp__yewreview__*");
    expect(options.allowedTools).toContain("mcp__yewreview__publish_report");
    // Qualified once, by the module that owns the names.
    expect(options.allowedTools?.some((name) => name.startsWith("mcp__yewreview__mcp__"))).toBe(false);
    expect(options.strictMcpConfig).toBe(true);
  });

  test("with no tool surface there is no rule about a server that is absent", () => {
    fresh();
    const options = buildAgentOptions({
      settings: h.settings,
      resources: RESOURCES,
      venv: NO_ENGINE,
      mcpServer: null,
      toolNames: [],
    });
    expect(options.mcpServers).toBeUndefined();
    expect(options.allowedTools?.some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  test("the installation's effort level reaches the session", () => {
    fresh();
    const options = buildAgentOptions({
      settings: { ...h.settings, effort: "xhigh" },
      resources: RESOURCES,
      venv: NO_ENGINE,
      mcpServer: null,
      toolNames: [],
    });
    expect(options.effort).toBe("xhigh");
  });

  test("a conversation's own level overrides the installation's", () => {
    // Two facts wearing one name, and this is the line that keeps them apart: `settings.effort` is
    // where every conversation STARTS, while how hard to work on the question actually in front of
    // the agent is a property of one conversation — see `ClaudecodeAgent.setEffort`. A session built from the
    // settings while the agent held a different level would answer at the level nobody picked, and
    // the only visible symptom would be what the turn cost.
    fresh();
    const options = buildAgentOptions({
      settings: { ...h.settings, effort: "low" },
      effort: "max",
      resources: RESOURCES,
      venv: NO_ENGINE,
      mcpServer: null,
      toolNames: [],
    });
    expect(options.effort).toBe("max");
  });

  test("a conversation with delegation off runs the surface this agent had before it existed", () => {
    // OFF has to be byte-identical to the old surface rather than merely similar, which is why both
    // halves are asserted: not one of the six names is in the allow list, and `enableWorkflows` is
    // ABSENT rather than false — an unset key means whatever the installation would have done, and
    // a false one would be this agent turning a feature off on somebody's behalf.
    fresh();
    const options = buildAgentOptions({
      settings: h.settings,
      subagents: false,
      resources: RESOURCES,
      venv: NO_ENGINE,
      mcpServer: null,
      toolNames: [],
    });
    for (const tool of SUBAGENT_TOOLS) expect(options.allowedTools).not.toContain(tool);
    expect(sessionSettings(options).enableWorkflows).toBeUndefined();
    // And nothing else moved with it: the builtin surface is what it always was.
    expect(options.allowedTools).toContain("Bash");
    expect(options.tools).toBeUndefined();
  });

  test("a session built for no particular conversation still names a level", () => {
    // There is no state in which the agent has none. `effort` is optional on the input because a
    // caller may not be speaking for a conversation — this one is not — and what that omission means
    // is the installation's level, which `loadSettings` seats at `high` and nothing configures. The
    // key is always on the options, so the SDK is never left reading a session's level off whatever
    // the model happens to default to.
    fresh();
    const options = buildAgentOptions({
      settings: h.settings,
      resources: RESOURCES,
      venv: NO_ENGINE,
      mcpServer: null,
      toolNames: [],
    });
    expect(options.effort).toBe("high");
  });
});

describe("the system prompt", () => {
  test("is byte-stable across calls and says so when there is no engine", () => {
    const first = systemPrompt(NO_ENGINE);
    expect(systemPrompt(NO_ENGINE)).toBe(first);
    expect(first).toContain("measurement engine is not installed");
    expect(first).toContain("Building the report");
  });

  test("carries the engine's own reference when there is one", () => {
    const withEngine = systemPrompt({ ...NO_ENGINE, ready: true, dslGuide: "# the DSL, per seikan" });
    expect(withEngine).toContain("# the DSL, per seikan");
    expect(withEngine).not.toContain("measurement engine is not installed");
    // Cached per guide, so a re-provision is picked up rather than remembered wrongly.
    expect(systemPrompt(NO_ENGINE)).toContain("measurement engine is not installed");
  });

  test("frames the conversation as global and a recipe as a record reached by name", () => {
    // The prompt is byte-stable across every turn of every boot so the provider can cache its
    // prefix, which is only possible because nothing per-recipe is in it. This locks the framing:
    // there is one conversation, a recipe is a row it works on, and the only per-recipe text
    // the agent ever sees comes back from the call that opens a procedure.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("This conversation is **global**");
    expect(prompt).toContain("A **recipe** is a record");
    expect(prompt).toMatch(/that recipe comes back as the result of the call that starts it/);
    // One home for one conversation, and no variable naming a per-recipe directory, there being
    // no such directory to name.
    expect(prompt).toContain("$YEWREVIEW_HOME");
    expect(prompt).not.toContain("YEWREVIEW_RECIPE");
    expect(prompt).not.toContain("recipe directory");
    // AND THE VOCABULARY IT REPLACED IS GONE FROM THE DOCUMENT ENTIRELY, which is worth one line
    // rather than an assertion per section: a workshop holding playbook versions was the shape of
    // half this prompt, and a paragraph left behind would teach the agent a table nothing answers
    // to and a tool the list does not have.
    expect(prompt).not.toContain("workshop");
    expect(prompt).not.toContain("playbook");
  });

  test("states the measurement doctrine the engine's two target modes depend on", () => {
    // Each phrase is doctrine the prompt must keep saying in these words. A failure here means the
    // prose moved — put the phrase back, or move this lock as deliberately as the prose.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("seikan is the only measurement path for a thesis");
    expect(prompt).toContain("basket mode");
    expect(prompt).toContain("attribution");
    expect(prompt).toContain("profiles data and measures nothing");
    expect(prompt).toContain("`baseline`");
    expect(prompt).toContain("`episodes`");
  });

  test("states the orchestration doctrine, and that the agent writes both halves of it", () => {
    // Locked for the same reason as the doctrine above: the recipe and the scripts drift apart
    // silently, and a paraphrase that stops naming both halves stops preventing it. The move a
    // changed method implies is pinned rather than the sentence — a script is replaced, never
    // edited, so what follows `create_script` is the replacement-and-retirement pair. The word in
    // that pair moved with the column: a superseded script is `inactive` now, where it used to be
    // `abandoned`, and the two spellings must not both be in circulation.
    // Matched across whitespace rather than as a literal, because the paragraph is hard-wrapped and
    // the phrase straddles a newline. A soft wrap is not the doctrine moving, and
    // a lock that failed on one would train whoever hits it to delete the lock instead of the edit.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toMatch(/\*\*move\s+them together\*\*/);
    expect(prompt).toMatch(
      /`create_script`[\s\S]{0,160}replacement script[\s\S]{0,40}set inactive/,
    );

    // And that BOTH halves are the agent's to carry out, which is the sentence the orchestration
    // rule now leans on: the recipe half waits for agreement rather than for somebody else's
    // hands, so "raise the script work a week later" has stopped being the path of least effort.
    expect(prompt).toMatch(/Both halves are yours to\s+carry out/);
    expect(prompt).toMatch(/the recipe half still waits for their agreement/);
  });

  test("states that a recipe is the user's document, and that consent is what protects it", () => {
    // THE PIN INVERTED TWICE, AND IT IS STILL THE ONE WITH THE MOST WEIGHT ON IT. It read "there is
    // no tool for writing instructions" when a form wrote them, which was true of the tool list and
    // was never the thing doing the protecting: a form let somebody press Save on text nobody had
    // read out loud, and a button is one click away wherever it sits. The agent holds the pen now —
    // `create_recipe` — and what has to be locked is the rule that replaced the missing tool,
    // because a prompt that named the tool and dropped the protocol would be strictly worse than
    // either arrangement it came from.
    //
    // All four steps, because each is load-bearing on its own. A proposal that does not name the
    // sentence it disagrees with is drift; a recipe shown as a description rather than as text is
    // agreement to something nobody read; a call made off the message that OPENED the subject is
    // the failure this whole section exists to prevent; and a re-render after a change is what
    // keeps step two true the second time.
    //
    // Matched across whitespace where a sentence straddles the hard wrap: a soft wrap is not the
    // doctrine moving, and a lock that failed on one would train whoever hits it to delete the lock
    // rather than the edit.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("**A recipe is the user's document, written by you.**");
    expect(prompt).toMatch(/`create_recipe` stores one/);
    expect(prompt).toContain(
      "**So the rule is consent, and it is the same rule for every document of theirs you write.**",
    );
    expect(prompt).toMatch(
      /\*\*Name the sentence you think is wrong, say what you would put there instead, and say what in the\s+work showed it\.\*\*/,
    );
    expect(prompt).toContain("**Show the whole thing.**");
    // In the row block, which is where step two stopped being a matter of the model's judgement.
    // "Render it as markdown" left the SHAPE of the row to whatever the model felt like: a field it
    // had not filled in could be a heading with nothing under it, a sentence about the gap, or a
    // line simply absent, and the reader was left inferring which fields were still open. The
    // grammar fixes the row's shape and leaves the values' own shape alone.
    expect(prompt).toMatch(/Render the complete recipe in your reply, as a row block/);
    expect(prompt).toMatch(
      /Call `create_recipe` only after they have said, in a message sent AFTER seeing that,\s+that this is what they want recorded/,
    );
    expect(prompt).toMatch(/A message that merely opens the subject authorises\s+nothing/);
    expect(prompt).toContain("Silence is not agreement either.");
    expect(prompt).toContain("**If they change something, show the whole of it again.**");
    // And the fifth step, which is the one that survives a conversation scrolling. The four above it
    // are all satisfied by showing the document ONCE, which is how somebody comes to agree to
    // wording they can no longer see; the draft is therefore restated whole at the end of every
    // reply until it is recorded or dropped.
    expect(prompt).toContain("**Keep it pinned.**");
    expect(prompt).toMatch(/end every reply with\s+the complete current text/);
    expect(prompt).toMatch(/the whole document, as a row block/);
    expect(prompt).toMatch(/what they are agreeing to should be the last thing on their\s+screen/);
    // And the pin ENDS at the save. The step above makes the block the last thing in every reply,
    // so without this sentence the natural continuation is one more block after recording — which
    // reads as a draft still open, a question they have already answered.
    expect(prompt).toMatch(/The pin comes out when the call lands/);
    expect(prompt).toMatch(/do not render the document again/);
    // And why it is not ceremony, which the model has to be told or it will read the protocol as
    // paperwork to be got through rather than as the thing that makes the writing legitimate.
    expect(prompt).toMatch(/the button they used to press was not the\s+protection/);
    expect(prompt).toMatch(/the change is SHOWN and AGREED/);

    // THE ARCHIVE RULE THAT REPLACED THE LEDGER, and it is the one thing here the model would
    // otherwise get exactly backwards. Instructions were an append-only ledger and the operative
    // version was the newest row, so the prompt taught "record the whole new text" and a version
    // number was a thing to read. There is no revising a recipe at all now: the text is fixed, a
    // moved method is a NEW row, and the old one is RETIRED rather than superseded in place.
    expect(prompt).toContain("**A recipe's text never changes.**");
    expect(prompt).toMatch(/no version history to read/);
    expect(prompt).toContain("**So a method that has moved on is a NEW recipe.**");
    expect(prompt).toMatch(/retire the old one with `set_recipe_status`/);
    // What retiring costs and what it keeps, because the alternative act is the destructive one and
    // the difference is the whole reason the status exists.
    expect(prompt).toMatch(/`start_generation` refuses to open a procedure there/);
    expect(prompt).toContain(
      "`delete_recipe` is for one stored by mistake, and it TAKES EVERY REPORT PUBLISHED UNDER IT",
    );
    expect(prompt).toContain("A superseded recipe is set inactive instead");
    // And the count said out loud before the question is asked, since the documents themselves go
    // with the specification and the user cannot see how many that is.
    expect(prompt).toMatch(/Say how\s+many reports would go, in the conversation, before you ask/);
    // THE FREEZE, WIDENED AND SAID IN THE PROMPT'S OWN TERMS: it is not this tool that is refused
    // mid-procedure, it is every tool that writes a record, under every recipe, because a report is
    // read against an archive that must not move underneath it.
    expect(prompt).toMatch(
      /While any generation procedure is running, every tool that writes a record is refused, under every\s+recipe/,
    );

    // THE ABSENCES, and they are absences of things that CONTRADICT the above rather than of
    // capabilities. A revision tool must not be named at all: a recipe cannot be revised, and a
    // prompt offering one would have the model building a call it cannot make.
    expect(prompt).not.toContain("revise_recipe");
    // And the drafting apparatus went with the whole idea of it. There is no fence the user types a
    // document into for the agent to commit — committing another party's text is not writing — so
    // the grammar for one may not survive in the prompt, where it would have the model looking for
    // a block the window never sends.
    expect(prompt).not.toContain("yewreview-draft");
    expect(prompt).not.toContain("Drafts the user hands you");
  });

  test("teaches the one grammar every row it shows is written in", () => {
    // A CONVENTION THE MODEL HAS TO REMEMBER, WHICH IS WHY IT IS TAUGHT AT LENGTH AND LOCKED HERE.
    // The window parses `~~~row` fences (`web/src/lib/rowBlock.ts`) and draws them as cards, so this
    // section is one half of a contract whose other half is code. What makes it safe to depend on is
    // the fallback rather than the model's memory: a fence the parser cannot read keeps the ordinary
    // code chrome, so a forgotten grammar shows the reader the outline exactly as it was typed. That
    // is the difference from the arrangement this replaced, where the window guessed that a markdown
    // TABLE was probably a record and dressed every grid of numbers as one.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("## Showing a row");
    expect(prompt).toContain("~~~row");
    // The three parts the parser actually depends on: the fence marker, the indent that carries the
    // structure, and the fields being the tool's own rather than a summary.
    expect(prompt).toMatch(/The fence is TILDES carrying the word `row`/);
    expect(prompt).toMatch(
      /the table at\s+the margin, each field name two spaces in, its value two spaces further/,
    );
    expect(prompt).toMatch(/the fields are the ones the\s+tool that records it takes/i);
    // THE MARK FOR AN UNANSWERED FIELD, which is the part of this that is a product decision rather
    // than a format. An empty draft is the agent's first move in a creation conversation, so `****`
    // is what turns a card into a question — and the alternatives it forbids are named, because
    // "leave the field out" is what a model does naturally and is exactly the failure: an absent
    // line reads as a decision.
    expect(prompt).toContain("**`****` is the one mark for a field not filled in yet.**");
    expect(prompt).toMatch(/never the field left out/);
    // A value keeps its own kind inside the block: a program is still a fence, a document is still
    // markdown. That is what the block buys over a code fence around the whole row.
    expect(prompt).toMatch(/is its own backtick fence inside\s+the block/);
    expect(prompt).toMatch(/written as-is at value indent, headings and\s+lists included/);
    expect(prompt).toContain("One block per row, whole, every time.");
    // COMPLETENESS, both halves. Every field the tool takes is in the block — `****` where nothing
    // is settled, never left out to tidy the card — and the machine's columns are not fields at
    // all: a draft is what somebody is asked to agree to, and nobody agrees to a uuid or a
    // timestamp. The two worked examples carry the rule, so they are pinned complete: a prompt
    // whose own example omits a field teaches the omission, whatever the sentence beside it says.
    expect(prompt).toMatch(/ALL of them every time/);
    expect(prompt).toMatch(/never left out to tidy the card/);
    expect(prompt).toMatch(/Machine columns are\s+not fields/);
    expect(prompt).toMatch(/nobody agrees to a uuid/);
    const flowed = prompt.replace(/\s+/g, " ");
    expect(flowed).toContain("hosts fred.stlouisfed.org failure_cases **** auth_env ****");
    expect(flowed).toContain("script name **** domain **** source");
    // AND THE DRAFTING ENDS AT THE SAVE. "Whenever a reply puts a record in front of the user" is
    // an unconditional trigger, and a model following it faithfully would confirm a save by
    // showing the row one more time — a draft nobody can tell is closed. The tool's own sentence
    // is the confirmation, and the stored row is shown when they ask for it.
    expect(prompt).toContain("A row just recorded is not shown again.");
    expect(prompt).toMatch(/that sentence is the confirmation/);
    expect(prompt).toMatch(/Show a stored row when\s+they ask to see it/);
    // And the wording it replaced is gone rather than standing beside it. Two instructions about how
    // to render a draft is one the model gets to choose between, and the one it chose for years is
    // the one the window can no longer draw.
    expect(prompt).not.toContain("field by field");
    expect(prompt).not.toContain("as ordinary markdown");
  });

  test("teaches what a creation opening is, how to answer one, and where a mid-work ask goes", () => {
    // THE FOUR OPENING LINES ARE QUOTED FROM THE WINDOW ITSELF, which is the lock that matters in
    // this test. A `+` says one of these into the conversation on screen; the prompt tells the agent
    // that such a line means "answer with the empty row". If either side is reworded alone, the
    // agent stops recognising an opening and answers it as ordinary chat — a failure with no error
    // and no symptom except a worse conversation.
    //
    // ALL FOUR ARE QUOTED WHOLE NOW, which is a small consequence of a large change: a creation no
    // longer opens a session of its own, so no opener has to name the record it is being raised
    // beside, so none of them is composed at press time. They are four constants, the prompt carries
    // them verbatim, and the prompt stays byte-stable — which is the constraint this section had to
    // be written under, since the provider's prefix cache holds only while it does.
    const prompt = systemPrompt(NO_ENGINE);
    // Read with the hard wrap flattened, because the prompt is a wrapped document and an opener may
    // straddle a line break. A soft wrap is not the doctrine moving, and a lock that failed on one
    // would teach whoever hits it to delete the lock rather than fix the edit.
    const flowed = prompt.replace(/\s+/g, " ");
    const said = (text: string): string => text.replace(/\s+/g, " ");
    expect(prompt).toContain("# Creation openings");
    expect(prompt).toContain("**A creation is raised in the conversation on screen.**");
    for (const opener of [NEW_RECIPE, NEW_SOURCE, NEW_THESIS, NEW_SCRIPT]) {
      expect(flowed).toContain(said(opener));
    }
    // The line is an opening and nothing more, which is the same thing the consent rule says from
    // the other end: pressing a button is not agreeing to anything.
    expect(prompt).toMatch(/the line authorises NOTHING/);
    expect(prompt).toMatch(/The same words typed by hand mean the same thing/);

    // THE FIRST REPLY IS THE PRODUCT DECISION. The empty row block is what replaced the form: it
    // shows the reader exactly what is about to be stored and exactly how much of it is blank,
    // without asking them to type into a grid. One ask under it, condensed, because the block has
    // already said what the fields are.
    expect(prompt).toContain("**Answer an opening with the empty draft.**");
    expect(prompt).toMatch(
      /every\s+field `\*\*\*\*`, and under it ONE short line asking them to describe it/,
    );
    // AND THE ASK IS WRITTEN OUT, which is the part of this that stopped being a matter of degree.
    // "One condensed ask" is a target a model can hit with three clauses and a rationale; the whole
    // sentence is given instead, and the shape it is not is named beside it — because the failure
    // being prevented is a model that answers a one-line opening with a paragraph of interview.
    expect(flowed).toContain(said(`"Describe it and I'll fill this in." is the whole of it.`));
    expect(flowed).toContain("no list in prose of the fields the block is already showing");
    expect(flowed).toContain("no multi-clause question naming each thing you would like to know");
    // Then the loop the whole flow exists for: fill it in, say what will not do, check what is
    // cheaper to check than to ask, and show the newest draft whenever their eyes are needed.
    expect(prompt).toContain("**Then calibrate.**");
    expect(prompt).toMatch(/Check a fact yourself where checking is cheaper than asking/);
    expect(prompt).toMatch(/ends with the complete newest block/);

    // THE THESIS IS THE ONE CREATION WITH NO EMPTY DRAFT, and the reason is worth locking with the
    // rule: its fields are the agent's translation of the claim rather than anything the reader is
    // holding, so a block of `****` would be asking them to fill in the agent's half.
    expect(prompt).toContain("**A thesis opens with no empty draft.**");
    expect(prompt).toMatch(/would be asking them to fill in your\s+half/);

    // AND WHERE AN ASK MADE MID-WORK GOES — WHICH IS THE PIN INVERTED. The doctrine used to be to
    // point at the `+` and refuse to interview in place, because a creation got a session of its
    // own and starting one here would have put it in a transcript about something else. There is no
    // other conversation to move it to now, so the answer is to deal with it where it was raised.
    expect(prompt).toContain("**Raised in the middle of other work, it is dealt with there.**");
    expect(prompt).toMatch(/Draft it where the conversation is/);
    // The sentences that carried the old rule must be GONE rather than left standing beside their
    // replacement: a prompt saying both would tell the model to draft here and to refuse to.
    expect(prompt).not.toMatch(/point at the `\+`/);
    expect(prompt).not.toContain("Do not start the interview in place");
    expect(prompt).not.toContain("**A creation gets a conversation of its own.**");
    // The two presses that are NOT creations stay where they were pressed, and the prompt says so:
    // a report is not authored and a deletion is about a row already on screen.
    expect(prompt).toMatch(/A report is not a creation, and neither is a deletion/);
  });

  test("states what a record is called and that renaming one is asked for, never tidied", () => {
    // A NEW SECTION FOR A TOOL THAT USED TO BE A FORM. A name asserts nothing about the world and
    // nothing joins on it, so `rename_record` is the cheapest write on this surface — which is
    // exactly why the prompt has to say the part that is not about safety: a name is the user's,
    // and renaming rows nobody mentioned is moving the furniture in somebody else's study. Both
    // halves are pinned, because a prompt carrying only "this is safe" produces an agent that
    // tidies.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("## What a record is called, and how you rename one");
    expect(prompt).toContain("`rename_record` changes one, on any table.");
    expect(prompt).toMatch(/it is still not yours to do\s+unasked/);
    expect(prompt).toMatch(/do not tidy names\s+nobody mentioned/);
    expect(prompt).toMatch(/Moving the\s+furniture in somebody else's study is not a favour/);
    // The one table that refuses, said where the tool is introduced rather than left to be
    // discovered as a refusal: a target's name is the instrument's official one, and the way to
    // correct a wrong one is not a rename at all.
    expect(prompt).toContain("`rename_record` refuses it");
  });

  test("states how data reaches the engine, given that nothing records where it sat", () => {
    // There is no dataset tree, no series ledger and no path grammar, and what stands in their
    // place is weaker in a way the prompt has to keep saying out loud: a CSV is an untracked
    // working file, and the whole record of it is a script-and-argument pair the agent declares. So
    // both halves are locked — that no record names a file, and that the declaration is only worth
    // anything if the program actually run was the one fetched.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("There is no data directory, and no record anywhere names a file");
    expect(prompt).toContain("`series_preparation`");
    // `run_script` closed one of the two gaps and not the other, and the prompt has to say which.
    // The program cannot drift, because the bytes come out of the database at the moment they run;
    // which CSV then answered which series key is still nothing but the agent's word.
    expect(prompt).toContain(
      "executes those stored bytes rather than a copy that could have been touched on the way",
    );
    expect(prompt).toContain("there is nothing behind that statement but you");
    // Replacing a script rather than editing it is what lets an old declaration still name the
    // program behind its numbers, and deleting one destroys somebody else's account of a run.
    expect(prompt).toContain("A failing script is replaced, not worked around");
    expect(prompt).toContain("Deleting it destroys somebody else's account of what happened");
  });

  test("states that a fetcher validates what it fetched, and names the library it has for it", () => {
    // The one rule in this prompt about the agent's own code rather than about the archive, and it
    // is pinned because it is invisible when it is being kept: a script that validates and a script
    // that does not look identical until a source changes shape. Both halves are locked — the duty,
    // and the fact that the venv actually carries pydantic — because a duty naming a library that is
    // not installed is a rule the model can only break.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("A fetcher validates what it fetched, before it shapes it");
    expect(prompt).toContain("pandas, requests and pydantic");
    // Across whitespace, because the sentence straddles a hard wrap — the same allowance the
    // orchestration pin above makes, and for the same reason: a soft wrap is not the doctrine moving.
    expect(prompt).toMatch(/A\s+validation failure is a failing script/);
  });

  test("states that a thesis locates no data and the invocation binds it", () => {
    // The DSL declares keys and the run binds them, which is why a thesis's identity survives
    // re-pulled data. The agent is the only thing that can get the binding right, so the rule that
    // the set must answer the thesis exactly is pinned along with the key vocabulary.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("A thesis declares its series and locates none of them");
    // The binding is a `data` map on `run_seikan` rather than repeated `--data` flags, and the rule
    // with teeth in it is this: the set must answer the thesis exactly.
    expect(prompt).toContain(
      "`data` binds one key to one CSV, once per key, and the set must answer the thesis exactly",
    );
    expect(prompt).toContain("`FEED@TARGET`");
    // A target key that is a symbol is the ONLY signal YewReview has for a thesis's regime.
    expect(prompt).toContain("Name a target with its ticker whenever");
    expect(prompt).toContain("`tickers`");
  });

  test("states that a thesis is born measured and judgement is a ledger", () => {
    // Twice reversed, and both reversals were pinned here, which is why neither could be dropped
    // quietly. "Born tagged" fell to the ledger — one standing assessment made re-reading
    // destructive — and "stored before it is judged" fell to the archive presenting claims with
    // empty ledgers and no account of how they read. What holds now is the pair: the first round
    // rides the storing call, in one transaction, and the ledger's own rules — appending, never
    // overwriting, abandonment as a terminus — did not move an inch to make room for it.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("A thesis is a container, and judgement is a ledger");
    expect(prompt).toMatch(/files the first round of judgement with it, in one\s+transaction/);
    expect(prompt).toMatch(/a thesis is measured before it is stored/);
    expect(prompt).toMatch(/one you store is never on record\s+unmeasured/);
    // The flow follows the ordering: the document is measured from its own bytes, before an id
    // exists — which is also the run_seikan mode the engine section teaches.
    expect(prompt).toMatch(/`run_seikan` handed the `dsl_json` itself/);
    expect(prompt).toMatch(
      /`assess_thesis` files one round of judgement — every round after the first/,
    );
    expect(prompt).toContain("Re-reading a thesis appends; it never overwrites");
    expect(prompt).toContain("`abandoned` is the LAST row a ledger can take");
    expect(prompt).toContain("not a better-worded abandonment");
    // And the superseded sentence is GONE rather than standing beside its replacement: a prompt
    // carrying both would tell the model to store unmeasured and to refuse to.
    expect(prompt).not.toContain("a document is stored before it is judged");
    expect(prompt).not.toContain("It takes no tag and no assessment");
  });

  test("states that a thesis's claim is the user's, and that the measurement may not flatter it", () => {
    // THE SEAM, AND IT RUNS THROUGH THE MIDDLE OF ONE RECORD RATHER THAN BETWEEN TWO. `create_thesis`
    // carries the consent rule and `assess_thesis` deliberately does not: what a thesis CLAIMS is
    // the user's, in their terms and about their money, and how it READS once measured is the
    // agent's own judgement. A prompt that stated only the first half would invite a model to ask
    // permission for its own findings; one that stated only the second would let it write down a
    // claim the user never made.
    //
    // And the DSL is pinned as the half agreement does NOT reach, which is the sentence with the
    // most weight on it here. The pressure this anticipates is real and one-directional: a user who
    // wants an idea to work can push a formulation that measures something adjacent and flattering,
    // and a model that reads consent as "do what they asked" would store it. What makes that
    // uniquely bad is that the result is not a refusal or a wrong answer somebody can spot — it is a
    // document that looks exactly like a measurement and is wrong in every future reading of it.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("**The container is the user's, even though you hold the pen.**");
    expect(prompt).toMatch(/both halves are agreed before `create_thesis` is called/);
    expect(prompt).toMatch(
      /The message that opens the subject authorises nothing, including the one their window sends when\s+they press `\+` on the thesis box/,
    );
    // Both directions of the loyalty, because either alone reads as a different rule.
    expect(prompt).toContain(
      "**Correct their mistakes out loud, and do not bend the measurement to their preference.**",
    );
    expect(prompt).toMatch(
      /\*\*the DSL must honestly express\s+the hypothesis, even when they push a formulation that would flatter it\.\*\*/,
    );
    expect(prompt).toMatch(/is wrong in every future reading of it/);
    // And the ledger stays the agent's, which is what keeps the consent rule from spreading into the
    // one place it would do harm.
    expect(prompt).toMatch(/how it READS once measured is\s+assessed on your own authority/);
    expect(prompt).toContain("`assess_thesis` asks nobody");
    // The first round riding the consented call is where that seam is under the most pressure, so
    // its two halves are pinned by name: the reading is SHOWN — the draft becomes two row blocks,
    // one per row the call writes — and it is not negotiable, because consent is to the storing.
    expect(prompt).toMatch(/the draft is TWO row blocks/);
    expect(prompt).toMatch(/consent is to the STORING, and the\s+tag is not theirs to bargain up/);
    expect(prompt).toMatch(/it goes unstored/);
  });

  test("states that the engine's report is redeemed by id, never retyped", () => {
    // Redemption by id rather than "pasted verbatim", and it is the stronger rule rather than the
    // looser one: the bytes filed beside a judgement are taken from where the run tool kept them,
    // so a report improved, rounded or truncated on its way through a model is unreachable rather
    // than merely warned against. Both halves of the deal are pinned, including the one that costs
    // something: a run is spent once and does not survive a restart.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("the run it was read off, named by its `seikan_run_id`");
    expect(prompt).toContain("You never retype that report");
    expect(prompt).toContain("A run is redeemable ONCE, and only until the process restarts");
    expect(prompt).toContain("No run, no assessment");
    // And the tool that hands the id over says what it hands over: a digest of the run, not the
    // report, which is what stops the model reading numbers off a summary of its own.
    expect(prompt).toContain(
      "**What comes back is a `run_id` and a digest, never the report itself.**",
    );
    // TWO REDEEMERS NOW, split by what the run measured: a stored thesis's run is filed by
    // `assess_thesis`, and a document-mode run — the shape a first measurement has to take, since
    // nothing is stored yet for an id to name — belongs to `create_thesis`. Both halves of the
    // split are pinned, in the run tool's section and in the ledger's.
    expect(prompt).toMatch(/takes the `dsl_json` itself,\s*\n?which is how a thesis's first measurement happens/);
    expect(prompt).toMatch(/or\s+`create_thesis`, when the run measured a document on its way to being stored/);
    expect(prompt).toMatch(/a run of an unstored document belongs to\s+`create_thesis`/);
  });

  test("states the citation doctrine, which is now entirely the document's to carry", () => {
    // The citation table was deleted, and the prompt has the harder job because of it: with no
    // column to refuse a bad quotation there is nothing left but the instruction. So what is
    // locked here is that the doctrine got STRONGER rather than quieter — the faithful-copy rule,
    // the address, the attribution of the agent's own conclusions — plus the reason the table went,
    // because an agent told only "there is no citation argument" would reasonably infer that
    // citing had stopped mattering.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("Say where you got it, in the document");
    expect(prompt).toContain("**Quote, never paraphrase.**");
    expect(prompt).toContain("**Mark what is yours.**");
    expect(prompt).toContain("looked like evidence");
    // And the vocabulary of the deleted table is GONE rather than merely unused. A prompt still
    // describing an `anchor` to declare would have the agent building a call it cannot make.
    expect(prompt).not.toContain("retrieved_at");
    expect(prompt).not.toContain("**anchor** — where in the published document");
    expect(prompt).not.toContain("A report applies an ASSESSMENT, not a thesis");
  });

  test("states that the record of what ran is written from the log rather than declared", () => {
    // The prompt says this positively rather than leaving it unsaid: an agent left to infer the
    // rule from the tool list would work around a record it is in fact given, which is why the
    // absence pinned below matters too. What is locked is that the rows are not the agent's to
    // declare, that failed runs are in them, that publishing waits for a command still running —
    // the two-phase log's whole point — and that the record can only see what went through the
    // tools, which is what makes the prose the only place a number from elsewhere can be explained.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("`script_invocation`");
    expect(prompt).toContain("`seikan_invocation`");
    expect(prompt).toContain("`trivial_shell_history_for_report`");
    expect(prompt).toContain("**Publishing declares nothing");
    expect(prompt).toContain("The ones that FAILED are recorded too");
    expect(prompt).toContain("**Publish only when every command has finished.**");
    expect(prompt).toContain("what that record can say is bounded by what went through the tools");
    expect(prompt).not.toContain("Nothing in this build keeps that log");
    expect(prompt).not.toContain("Do not describe runs the record does not have");
  });

  test("states that the agent opens a procedure, and what holds while one is open", () => {
    // THE PIN INVERTED, AND THIS IS THE ONE THAT MOST NEEDED ITS OLD SENTENCE DELETED RATHER THAN
    // SUPPLEMENTED. The prompt used to say the user starts a procedure and no tool can, on the
    // argument that an agent able to open one would make "publish only inside one" meaningless. The
    // tool exists now, and a prompt saying both would hand the model a tool and tell it not to use
    // one — which is exactly the failure this file's other absence-pins exist to catch.
    //
    // What replaced the missing tool is what has to be locked instead: the ask is the
    // authorisation, the archive freezes for the duration, and the procedure lives inside the turn
    // that opened it. The last of those is the newest hazard — a model that ends its turn meaning
    // to carry on has closed the procedure and left nothing to publish into.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toMatch(
      /A report is produced inside a \*\*generation procedure\*\*, and \*\*you start it, with\s+`start_generation`\.\*\*/,
    );
    expect(prompt).toMatch(/being asked is the\s+authorisation/);
    // The one recipe a procedure cannot be opened under, said where the tool is introduced rather
    // than left to be discovered as a refusal: a retired specification is one nothing new is
    // written to, and the gate enforces it (see the suite above).
    expect(prompt).toMatch(/An INACTIVE recipe is refused/);
    expect(prompt).toContain("**Produce the report in the turn\nthat started it.**");
    expect(prompt).toContain("**The archive holds still while a procedure runs.**");
    expect(prompt).toMatch(/store what you will need, then start/);
    expect(prompt).toMatch(/\*\*the procedure lives inside the\s+turn that opened it\*\*/);
    expect(prompt).toContain("**Publishing happens inside a generation procedure and nowhere else**");
    expect(prompt).toContain("A procedure that ends without a report is a finished answer, not a");

    // AND THE OLD SENTENCES ARE GONE rather than left standing beside their replacements.
    expect(prompt).not.toContain("the user starts it — you cannot");
    expect(prompt).not.toContain("There is no tool that starts one");
    expect(prompt).not.toContain("let them press it");
  });

  test("states what the run tools are for, and where the guarantee now stops", () => {
    // The prompt has to teach a rule that CHANGED, which is the harder job: the shell used to be
    // watched for engine commands and is now closed outright for the duration. So three things are
    // locked. That the door is closed to everything rather than to measurements — an agent told
    // only "the engine is denied" would try `ls` and read the refusal as a bug. That `run_shell`
    // is the way through, or the widening reads as most of an afternoon's work becoming
    // impossible. And that the honesty survived the widening: the machine records what ran and
    // cannot record what it meant, which is where the agent's own discipline still lives.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("**Run it with `run_script`.**");
    expect(prompt).toContain("and outside one they record nothing");
    expect(prompt).toContain("your built-in Bash is closed, and these three are the shell");
    expect(prompt).toContain("Not the engine specially");
    expect(prompt).toContain("Nothing is lost by it");
    expect(prompt).toContain("The machine records what ran; it cannot record what it");
    // The old caveat must be GONE rather than left standing beside a rule it no longer describes.
    // A prompt carrying both would have the agent trusting a fence and distrusting it at once.
    expect(prompt).not.toContain("best-effort rather than a proof");
  });

  test("states the six source types and what the vocabulary leaves out", () => {
    // The individual tiers are not in the schema, so the prompt may not teach them — and the
    // absence needs its own instruction, or a person's blog post gets filed as
    // `independent_research` to make it storable.
    const prompt = systemPrompt(NO_ENGINE);
    for (const type of [
      "issuer_primary",
      "regulatory_government",
      "trusted_data_vendor",
      "sellside_research",
      "buyside_public_disclosure",
      "independent_research",
    ]) {
      expect(prompt).toContain(`\`${type}\``);
    }
    expect(prompt).not.toContain("individual_verified");
    expect(prompt).not.toContain("individual_unverified");
    expect(prompt).toContain("There is no type for a private individual");
    // The type is correctable, and the agent is what writes the correction — so what has to be said
    // is the CONSEQUENCE rather than a prohibition: a re-grading silently re-weighs every report
    // standing on the source, which makes it a judgement about the archive rather than a typo, and
    // therefore one the person whose archive it is makes.
    expect(prompt).toContain("**A source's type can be corrected, and correcting one is not a small edit.**");
    expect(prompt).toContain("silently re-weighs every report standing on it");
  });

  test("states that the agent records a source only after the interview and their agreement", () => {
    // Two things have to be said here at once. The row is the USER's account of where their numbers
    // come from even though the agent holds the pen, so the interview is a duty the prompt states
    // in prose and nothing else enforces; and `hosts` is the one field that ever had machinery
    // behind it. Lock both, because a prompt that dropped the first would leave an agent filing
    // places it never visited, and one that dropped the second would leave it writing a list it
    // does not know the state of.
    const prompt = systemPrompt(NO_ENGINE);
    // THE PIN INVERTED, AND THE WORK IT NAMES IS THE PART THAT DID NOT CHANGE. This used to read
    // "you do not record one, you ask for it" — the row went in through a form. The form is gone
    // and `create_information_source` is here, so what carries the weight now is the ORDER: go and
    // look, render the row, get it agreed to, and only then record it. An agent that could write the
    // row without the interview would be filing a standing claim about a place it had never visited,
    // which is the failure this section has always been about.
    expect(prompt).toContain("**You record one — after the interview, and with their agreement.**");
    expect(prompt).toContain("**render the row as a row block**");
    // With `****` on what the visit did not settle, which is this section's own reason for the mark:
    // a source row is written from what the agent SAW, and the fields it could not learn have to be
    // visible as open questions rather than quietly filled in from the name of the place.
    expect(prompt).toMatch(/`\*\*\*\*` on whatever\s+you could not learn/);
    // Explicitly the same rule as the recipe's, said in one clause rather than restated as a
    // second protocol that could drift from the first.
    expect(prompt).toMatch(
      /the same rule applies as to their recipe: show the\s+whole row, wait, and record it when they say so/,
    );
    expect(prompt).toMatch(/once they have agreed to it,\s+`create_information_source`/);
    // The two corrections, with the field-level care each needs: `hosts` replaces rather than
    // appends, and a re-grading of `type` re-weighs everything already standing on the row.
    expect(prompt).toContain("`update_information_source` corrects one");
    expect(prompt).toMatch(/`hosts` REPLACES the list\s+rather than adding to it/);
    // And the one act with a wrong reason to reach for it, named beside the tool that does it: a
    // source that has gone wrong is recorded as having gone wrong, not deleted.
    expect(prompt).toContain("`delete_information_source` is for a row that should not be there");
    expect(prompt).toContain("A source that has gone WRONG is not one to delete");
    // The names nothing answers to are still absent. `add_information_source` never existed under
    // that spelling, `record_source_failure` is a failure appended through the update tool, and the
    // drafting apparatus went with the whole idea of committing another party's text.
    expect(prompt).not.toContain("`add_information_source`");
    expect(prompt).not.toContain("`record_source_failure`");
    expect(prompt).not.toContain("_draft");
    // The reads are the agent's, and reading FIRST is the habit the rule below depends on.
    expect(prompt).toContain("`list_information_sources`");
    expect(prompt).toContain("`search_sources`");

    // Nothing enforces `hosts`, and the prompt has to say so IN THOSE WORDS.
    // A field described as checked and silently not checked is the one shape of instruction that
    // makes an agent careless in exactly the place it was trying to be careful.
    expect(prompt).toContain("**`hosts` is a note rather than a rule");
    expect(prompt).toContain("nothing enforces this field now");
    expect(prompt).not.toContain(
      "a report citing an address that is on nobody's list is refused",
    );
    // The rule everything else here serves, and the sentence that stops a row the agent has just
    // laid out in the conversation from being mistaken for a recorded one. It matters MORE now that
    // the agent holds the pen, not less: the interview and the render are steps on the way to a row
    // rather than a substitute for one, and the boundary is `create_information_source` coming back.
    expect(prompt).toContain("**You may not use data from a place that is not recorded.**");
    expect(prompt).toContain("A draft rendered in the conversation is NOT a recorded source");
    expect(prompt).toMatch(
      /the row exists when `create_information_source` has come back, and not a moment\s+earlier/,
    );
  });

  test("teaches the mention grammar the window actually produces", () => {
    // The record panel writes these into the composer, and this prompt is the only place the model
    // learns to read one. The grammar carries the row's NAME rather than its id, so both spellings
    // are locked — the bare minted slug, and the quoted form a name with a space in it needs — and
    // beside them the rule that makes a mention safe: a name is an address, not the record. A
    // paraphrase that drops the resolution step turns every mention into a guess about which row
    // was meant.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("@table:name");
    expect(prompt).toContain("@thesis:semis-inventory-glut");
    expect(prompt).toContain("A mention names the record, not its contents");
    // There is no transcript number, because there is no `message` table. Nothing mints one, and a
    // grammar teaching a form the window cannot produce is a grammar teaching a guess.
    expect(prompt).not.toContain("@message");
    // The quoted branch is ORDINARY now rather than theoretical — a target's name is the
    // instrument's official one and arrives with spaces in it — so the prompt has to teach it with
    // an example the window really produces rather than as a curiosity.
    expect(prompt).toContain("is double-quoted");
    expect(prompt).toContain('@target:"NVIDIA Corporation"');
    expect(prompt).not.toContain("database mints an id like that");
    // The vocabulary is the addressable tables, not a list that resembles them: a table the browser
    // can hand over and the prompt never names is a mention the model has not been taught to read.
    for (const table of RECORD_TABLES) expect(prompt).toContain(`\`${table}\``);
  });

  test("teaches that a name addresses a row and an id outlives one", () => {
    // Both halves, because either alone is a rule the model would apply wrongly. Without "a tool
    // takes either" it would go looking for an id it was never handed; without "prefer the id you
    // are holding" it would re-address rows by a name the user can reword mid-turn.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("unique WITHIN its table");
    expect(prompt).toContain("takes either the id or the name");
    expect(prompt).toContain("**Prefer an id when you are holding one**");
    // The one name that is a claim about the world rather than a label, and the one the model can
    // permanently get wrong: it is required, it is never editable, and the prompt says to look it
    // up. Nothing else in this database has to be right the first time.
    expect(prompt).toContain("OFFICIAL full name");
    expect(prompt).toContain("Look it up rather than");
  });

  test("teaches the column form of a mention, and that it is still an address", () => {
    // The panel can hand over one FIELD of a record — a script's program, an assessment's stored
    // engine report — and those are exactly the columns big enough that answering from the name
    // would be most tempting. So the suffix is taught in the same section, with the resolution rule
    // restated for it: `#source` is the name of a field, not the program inside it.
    const prompt = systemPrompt(NO_ENGINE);
    expect(prompt).toContain("`@table:name#column` names one column of that record");
    expect(prompt).toContain("@script:daily-prices#source");
    expect(prompt).toContain("#seikan_report");
    expect(prompt).toContain("#return");
    expect(prompt).toContain("a column mention is still an address");
  });
});

// -- the file-write guard ----------------------------------------------------------------------

/** What a PreToolUse hook answers with, in the two fields these suites read. */
type Decision = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

/**
 * The hook registered for one matcher, found by NAME rather than by position.
 *
 * Two guards live on PreToolUse — the shell one and the file one — and a suite that picked
 * either by index would quietly start asserting about the other the day a third is registered or
 * the order changes. That is precisely the failure that would leave the file guard untested while
 * every one of its tests still passed, because a Bash guard handed a `file_path` and no command
 * lets everything through.
 */
function guardFor(matcher: string, generating?: () => boolean) {
  const hooks = agentHooks(h.settings, generating);
  const hook = hooks.PreToolUse?.find((entry) => entry.matcher === matcher)?.hooks[0];
  if (!hook) throw new Error(`no PreToolUse hook is registered for ${matcher}`);
  return hook;
}

describe("the PreToolUse guard", () => {
  async function decide(filePath: string) {
    const output = await guardFor("Write|Edit")(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: filePath },
        tool_use_id: "t1",
        session_id: "s",
        transcript_path: "",
        cwd: homeDir(h.settings),
      },
      "t1",
      { signal: new AbortController().signal },
    );
    return output as Decision;
  }

  test("one guard for the shell and one for the tools that write files", () => {
    fresh();
    // Both matchers, in the order they are registered, so the file guard cannot be dropped or
    // renamed without this saying so — and so the suites below are known to be selecting a real one.
    expect(agentHooks(h.settings).PreToolUse?.map((entry) => entry.matcher)).toEqual([
      "Bash",
      "Write|Edit",
    ]);
  });

  test("lets a write into the home directory through", async () => {
    fresh();
    expect((await decide("draft.html")).hookSpecificOutput).toBeUndefined();
    expect((await decide("run/notes.md")).hookSpecificOutput).toBeUndefined();
  });

  test("denies every tree that has a tool for a door, and names the door", async () => {
    fresh();

    // Three trees, and there is no fourth: there is no `dataset/` and no ledger describing one, so
    // a CSV a script writes is an ordinary file in the agent's home and needs no door at all.
    // `reports/` holds no documents either — a report is a row, served out of the database — so the
    // refusal says what publishing IS, rather than pointing at a file the agent could imagine
    // writing next to.
    const report = await decide(`${h.varDir}/reports/q3.html`);
    expect(report.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(report.hookSpecificOutput?.permissionDecisionReason).toContain(
      "a report is stored in the database and served from it, and publish_report is the door",
    );
    expect(report.hookSpecificOutput?.permissionDecisionReason).toContain(
      "the chart library your published pages load, which nothing edits",
    );

    const engine = await decide(`${h.varDir}/venv/bin/python`);
    expect(engine.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(engine.hookSpecificOutput?.permissionDecisionReason).toContain(
      "an engine you can edit is not evidence about anything",
    );

    const ledger = await decide(`${h.varDir}/db/yewreview.sqlite`);
    expect(ledger.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(ledger.hookSpecificOutput?.permissionDecisionReason).toContain(
      "the ledger is written through your tools, never as a file",
    );
  });

  test("a path with no door at all is told where a write does land", async () => {
    fresh();
    // Outside var entirely, so there is no tool to name — a denial the model cannot act on is just
    // a retry, and the two writable places are the thing it can act on.
    const stray = await decide("/tmp/not-the-var-dir/notes.md");
    expect(stray.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(stray.hookSpecificOutput?.permissionDecisionReason).toContain(
      "your home directory and var/tmp are the two places a file write lands",
    );
    expect(stray.hookSpecificOutput?.permissionDecisionReason).toContain(homeDir(h.settings));
  });

  test("a tree inside var that simply is not the home directory is denied too", async () => {
    fresh();
    // The shape of the rule itself, with no workshop tree for it to be about: the boundary is the
    // home directory rather than `var/`, so being under var buys nothing, and a tree with no door
    // falls through to the same sentence an outside path gets.
    const cache = await decide(`${paths(h.settings).cacheDir}/resources/echarts.min.js`);
    expect(cache.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(cache.hookSpecificOutput?.permissionDecisionReason).toContain(
      "your home directory and var/tmp are the two places a file write lands",
    );
  });

  test("a symlink planted in the home directory is judged by where it points", async () => {
    fresh();
    const home = homeDir(h.settings);
    mkdirSync(home, { recursive: true });
    // `reports/assets/` is the sharpest case there is: the chart library every published document
    // loads, one symlink away from a directory the agent may write in freely.
    symlinkSync(`${h.varDir}/reports`, `${home}/shortcut`);

    const decision = await decide("shortcut/assets/echarts.min.js");
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain("publish_report");
  });

  test("a call with no path is left to the tool's own refusal", async () => {
    fresh();
    const output = (await guardFor("Write|Edit")(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: {},
        tool_use_id: "t1",
        session_id: "s",
        transcript_path: "",
        cwd: homeDir(h.settings),
      },
      "t1",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: unknown };
    expect(output.hookSpecificOutput).toBeUndefined();
  });
});

// -- the shell guard a generation runs behind ----------------------------------------------------

describe("the shell guard while a generation is running", () => {
  /**
   * The Bash guard, built ONCE over a `generating` the caller can move.
   *
   * That is how a session actually holds it — one set of hooks outlives many procedures — so a
   * suite that rebuilt the hooks between the on and off cases would be testing something the
   * runtime never does.
   */
  function shellGuard(generating: () => boolean) {
    const hook = guardFor("Bash", generating);
    return async (command: string | null): Promise<Decision> => {
      const output = await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: command === null ? {} : { command },
          tool_use_id: "t1",
          session_id: "s",
          transcript_path: "",
          cwd: homeDir(h.settings),
        },
        "t1",
        { signal: new AbortController().signal },
      );
      return output as Decision;
    };
  }

  /** The recipes the prompt itself taught before the run tools existed, which is exactly why they
   * are the ones a model reaches for out of habit mid-procedure. */
  function engineCommands(): string[] {
    return [
      '"$YEWREVIEW_VENV/bin/seikan" run thesis.json --data NVDA=run/nvda.csv --report-out r.json',
      '"$YEWREVIEW_VENV/bin/seikan" check-data run/nvda_ohlcv.csv --shape ohlcv',
      '"$YEWREVIEW_PYTHON" fetch.py --ticker NVDA',
      "${YEWREVIEW_VENV}/bin/python fetch.py",
      // Spelled with no variable at all: the resolved venv path is matched as written, because a
      // path is not a word and a model that has read `$YEWREVIEW_VENV` once can print it.
      `${realPath(paths(h.settings).venvDir)}/bin/python fetch.py`,
    ];
  }

  test("denies the engine and the venv interpreter while a generation is in progress", async () => {
    fresh();
    const decide = shellGuard(() => true);
    for (const command of engineCommands()) {
      const decision = await decide(command);
      expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });

  test("allows every one of them when no generation is running", async () => {
    fresh();
    const decide = shellGuard(() => false);
    for (const command of engineCommands()) {
      // Outside a procedure there is no log for the run to be missing from, so the shell is the
      // agent's own business — the guard buys nothing here and would only cost a recipe.
      expect((await decide(command)).hookSpecificOutput).toBeUndefined();
    }
  });

  test("the same guard follows the procedure it was given, on and off", async () => {
    fresh();
    let generating = false;
    const decide = shellGuard(() => generating);
    const command = '"$YEWREVIEW_VENV/bin/seikan" run thesis.json --report-out r.json';

    expect((await decide(command)).hookSpecificOutput).toBeUndefined();
    generating = true;
    expect((await decide(command)).hookSpecificOutput?.permissionDecision).toBe("deny");
    generating = false;
    expect((await decide(command)).hookSpecificOutput).toBeUndefined();
  });

  test("denies the ORDINARY command too, which is the point of the widening", async () => {
    fresh();
    const decide = shellGuard(() => true);
    // These used to be allowed, and allowing them was right while a report only recorded its
    // MEASUREMENTS. A report records every command a procedure ran, and a record of every command
    // is worth having only if it is a record of every command — so the shell has one door for the
    // duration and this is what closing the others looks like. None of this work is denied; it is
    // routed through `run_shell`, which does the same thing and writes the row.
    for (const command of [
      "head -3 run/nvda_ohlcv.csv",
      "mkdir -p drafts && ls drafts",
      "curl -s https://example.com/prices.csv -o run/prices.csv",
    ]) {
      expect((await decide(command)).hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });

  test("the refusal names the three tools that do the same thing on the record", async () => {
    fresh();
    const decide = shellGuard(() => true);
    const reason =
      (await decide('"$YEWREVIEW_VENV/bin/seikan" run thesis.json --report-out r.json'))
        .hookSpecificOutput?.permissionDecisionReason ?? "";

    // A denial the model cannot act on is just a retry, so the refusal carries the way through:
    // all three tools by name, and the reason the shell is not one of them. `run_shell` is the
    // load-bearing one now — without it named, a model reading this refusal would conclude the
    // whole afternoon's ordinary work had become impossible mid-procedure.
    expect(reason).toContain("run_shell");
    expect(reason).toContain("run_script");
    expect(reason).toContain("run_seikan");
    expect(reason).toContain("record every command that produced it");
    expect(reason).toContain("Outside a generation your shell is your own");
  });

  test("a Bash call with no command is denied like any other, rather than slipping through", async () => {
    fresh();
    // The guard no longer reads the command at all, and this is the pin on that: it used to parse
    // the input to decide, so a malformed call fell through the parse and was allowed. Nothing is
    // parsed now, so there is no shape of input that gets past it — which is the difference between
    // a best-effort match and a closed door.
    expect((await shellGuard(() => true)(null)).hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("the session's own options carry the guard, wired to its procedure", async () => {
    fresh();
    // The seam `options.ts` threads: a `generating` that never reached `agentHooks` would leave
    // every test above passing about a guard no session actually runs.
    const options = buildAgentOptions({
      settings: h.settings,
      resources: RESOURCES,
      venv: WITH_ENGINE,
      mcpServer: null,
      toolNames: [],
      generating: () => true,
    });
    const hook = options.hooks?.PreToolUse?.find((entry) => entry.matcher === "Bash")?.hooks[0];
    if (!hook) throw new Error("the session's options registered no Bash guard");
    const decision = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: '"$YEWREVIEW_VENV/bin/seikan" run thesis.json --report-out r.json' },
        tool_use_id: "t1",
        session_id: "s",
        transcript_path: "",
        cwd: homeDir(h.settings),
      },
      "t1",
      { signal: new AbortController().signal },
    )) as Decision;
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

// -- the one agent ------------------------------------------------------------------------------

describe("the agent", () => {
  test("disposing asks the subprocess to close and leaves the store alone", async () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    const frames = watch(agent);
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");

    agent.dispose();
    // The query is asked to end; what was said stays in the SDK's own store, which is the part that
    // lasts and the part this process does not own.
    expect(sdk.calls[0]!.returned).toBe(true);
  });

  test("a window that reconnects after the shutdown is told the conversation is closed", () => {
    fresh();
    const { agent, sdk } = agentFor(plainScript());
    agent.dispose();

    // Attaching still works — a socket can open against a dead process and deserves an answer
    // rather than silence — and the answer to anything typed into it is a refusal.
    const frames = watch(agent);
    expect(agent.submitTurn("anyone there?")).toBe(false);
    expect(frames.find((f) => f.type === "error")).toMatchObject({
      code: "closed",
      message: "the agent has been shut down; restart YewReview to keep talking",
    });
    expect(sdk.calls).toHaveLength(0);
  });

  test("a generation cannot be started after the shutdown either", async () => {
    fresh();
    const recipeId = seedRecipe(h.db);
    const { agent, frames, startGeneration } = agentForWatched(plainScript(), WITH_ENGINE);
    // One turn first, because the tools — and with them the door onto the gate — are minted when
    // the session opens. Then the shutdown, which is what this is about.
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");
    agent.dispose();

    // `closed` is checked before the turn-in-flight rung, so a disposed agent still says the
    // useful thing rather than complaining about a turn nobody could have started.
    const started = startGeneration(recipeId);
    expect(started).toMatchObject({ ok: false, code: "closed" });
    expect(refusalOf(started)).toContain("restart YewReview before starting anything");
  });

  test("the installation's channel can be pointed somewhere after the agent is built", async () => {
    fresh();
    const { agent, events } = agentFor(plainScript());
    // The order boot actually runs in: the agent exists before the socket hub does, so the
    // broadcast is handed over afterwards — and a tool or a turn minted before the handover has to
    // announce into the live one rather than into whatever it closed over.
    const broadcast: EventsFrame[] = [];
    agent.attachEvents((frame) => broadcast.push(frame));

    const frames = watch(agent);
    agent.submitTurn("hello");
    await arrives(frames, "turn_result");

    expect(broadcast.filter((f) => f.type === "sessions_changed")).toHaveLength(2);
    expect(events).toHaveLength(0);
  });
});
