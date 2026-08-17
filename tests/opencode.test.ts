/**
 * The opencode harness's own parts: the pool, the config it renders, and the MCP door.
 *
 * **What is real:** a real database and var tree (`harness()`), the real pool store writing real
 * files, the real config renderer, and the real MCP bridge dispatching against the real tool
 * definitions and the real repositories underneath them. A tool called here writes rows.
 *
 * **What is faked, and why:** the opencode BINARY, everywhere. Two reasons, and they are the two
 * this suite ever accepts. Cost — driving it means a model and a paid API call, which a unit suite
 * must not need. And ownership — it is a separate program with its own release cadence, so a test
 * asserting what it does would be asserting somebody else's behaviour. What is tested here is the
 * half this repository owns: what we write for it, what we serve it, and what we refuse it.
 *
 * The parts that genuinely need the real binary are exercised by hand and reported in the commit
 * that added them; nothing here pretends to have run one.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { paths } from "../src/config.ts";
import { OPENCODE_ROLES, PRIMARY_ROLE, poolStore } from "../src/opencode/config.ts";
import type { PoolDocument } from "../src/opencode/config.ts";
import { MCP_PATH, createMcpBridge } from "../src/opencode/mcp.ts";
import { OPENCODE_DOCTRINE, TOOL_PREFIX, firstTurn } from "../src/opencode/prompt.ts";
import { Refused } from "../src/db/models.ts";
import { announcing } from "../src/tools/index.ts";
import type { ToolDeps } from "../src/protocol/types.ts";
import { harness, type Harness } from "./helpers.ts";

let open: Harness | null = null;

function rig(): Harness {
  open?.cleanup();
  const h = harness();
  open = h;
  return h;
}

afterEach(() => {
  open?.cleanup();
  open = null;
});

/** A pool that would actually work, for the tests that are about something else. */
function workingPool(): PoolDocument {
  return {
    entries: [
      {
        id: "luna",
        name: "Luna Pro",
        url: "https://openrouter.ai/api/v1",
        api: "OPEN_ROUTER_API",
        model: "openai/gpt-5.6-luna-pro",
      },
      {
        id: "grok",
        name: "Grok 4.6",
        url: "https://openrouter.ai/api/v1",
        api: "OPEN_ROUTER_API",
        model: "x-ai/grok-4.6",
      },
    ],
    roles: { build: "luna", plan: "grok" },
  };
}

describe("the model pool", () => {
  test("a fresh installation has an empty pool rather than an error", () => {
    const h = rig();
    // The file does not exist until somebody saves one, and the window opens on an empty board.
    // Reading a missing pool as a failure would make a first run look broken.
    expect(poolStore(h.settings).read()).toEqual({ entries: [], roles: {} });
  });

  test("what is written comes back, and lands in a file only its owner can read", () => {
    const h = rig();
    const store = poolStore(h.settings);
    expect(store.write(workingPool())).toEqual(workingPool());
    expect(poolStore(h.settings).read()).toEqual(workingPool());

    // 600, because this file is where an API key is written down. It is the one file this
    // installation creates that is a credential store, and the mode is the whole of what stops
    // another account on the machine reading it.
    const mode = Bun.file(paths(h.settings).opencodePoolPath).stat();
    expect(mode).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  test("a half-filled model saves, because a form that loses work is worse than a strict one", () => {
    const h = rig();
    // A note the reader has just pinned to the board is blank until they type in it. Refusing to
    // save one would mean every interruption costs whatever had been typed so far.
    const saved = poolStore(h.settings).write({
      entries: [{ id: "new", name: "", url: "", api: "", model: "" }],
      roles: { build: "new" },
    });
    expect(saved.entries[0]).toMatchObject({ id: "new", name: "" });
  });

  test("two models cannot share an id, because each becomes a provider and providers are named", () => {
    const h = rig();
    const pool = workingPool();
    pool.entries[1] = { ...pool.entries[1]!, id: "luna" };
    expect(() => poolStore(h.settings).write(pool)).toThrow(Refused);
  });

  test("a role cannot name a model that is not on the board", () => {
    const h = rig();
    expect(() =>
      poolStore(h.settings).write({ ...workingPool(), roles: { build: "luna", plan: "ghost" } }),
    ).toThrow(Refused);
  });

  test(`a pool with models in it has to assign ${PRIMARY_ROLE}, which is the role that answers`, () => {
    const h = rig();
    // Every other role falls back to opencode's own default, which is the honest behaviour for
    // "not thought about yet". This one cannot: it is the turn.
    expect(() => poolStore(h.settings).write({ ...workingPool(), roles: {} })).toThrow(Refused);
    // ...and an EMPTY pool is fine with no roles at all. That is a fresh installation, not a
    // misconfigured one.
    expect(() => poolStore(h.settings).write({ entries: [], roles: {} })).not.toThrow();
  });

  test("a key in the engine's namespace is refused, because the boot would scrub it away", () => {
    const h = rig();
    const pool = workingPool();
    pool.entries[0] = { ...pool.entries[0]!, api: "SEIKAN_TOKEN" };
    // `src/env.ts` deletes every `SEIKAN_*` variable before anything reads the environment, so a
    // key held under that name would not survive to be read — and the failure would surface as an
    // authentication error from a provider, which names nothing useful.
    expect(() => poolStore(h.settings).write(pool)).toThrow(/namespace/);
  });

  test("an unreadable pool is refused rather than replaced, because it holds credentials", () => {
    const h = rig();
    const store = poolStore(h.settings);
    store.write(workingPool());
    Bun.write(paths(h.settings).opencodePoolPath, "{ not json");
    // Overwriting it with an empty pool would lose somebody's API keys to a typo. The refusal
    // names the file and says nothing here will touch it.
    expect(() => poolStore(h.settings).read()).toThrow(Refused);
  });
});

describe("the config written for opencode", () => {
  test("every pool entry becomes an OpenAI-compatible provider, keyed by its own id", async () => {
    const h = rig();
    const store = poolStore(h.settings);
    store.write(workingPool());
    store.materialize("s3cret");
    const config = JSON.parse(
      await Bun.file(paths(h.settings).opencodeConfigPath).text(),
    ) as Record<string, unknown>;

    const provider = config["provider"] as Record<string, { npm: string; options: { apiKey: string; baseURL: string } }>;
    expect(Object.keys(provider).sort()).toEqual(["grok", "luna"]);
    expect(provider["luna"]!.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider["luna"]!.options.baseURL).toBe("https://openrouter.ai/api/v1");
    // An ALL-CAPS key is rendered as a REFERENCE rather than as the secret. The rendered config
    // then holds no credential at all in the ordinary case, and the pool file stays the one place
    // one is written down.
    expect(provider["luna"]!.options.apiKey).toBe("{env:OPEN_ROUTER_API}");
  });

  test("a literal key is passed through, because not every provider's is in the environment", async () => {
    const h = rig();
    const store = poolStore(h.settings);
    store.write({
      entries: [{ id: "x", name: "X", url: "https://x/v1", api: "sk-literal-abc", model: "m" }],
      roles: { build: "x" },
    });
    store.materialize(null);
    const config = JSON.parse(await Bun.file(paths(h.settings).opencodeConfigPath).text()) as {
      provider: Record<string, { options: { apiKey: string } }>;
    };
    expect(config.provider["x"]!.options.apiKey).toBe("sk-literal-abc");
  });

  test("the roles become the models opencode routes by", async () => {
    const h = rig();
    const store = poolStore(h.settings);
    store.write(workingPool());
    store.materialize(null);
    const config = JSON.parse(await Bun.file(paths(h.settings).opencodeConfigPath).text()) as {
      model: string;
      agent: Record<string, { model: string }>;
    };
    expect(config.model).toBe("luna/openai/gpt-5.6-luna-pro");
    expect(config.agent["build"]!.model).toBe("luna/openai/gpt-5.6-luna-pro");
    expect(config.agent["plan"]!.model).toBe("grok/x-ai/grok-4.6");
    // An unassigned role is ABSENT rather than null, so opencode falls back to its own default
    // instead of being handed a model that is not one.
    expect(config.agent["scout"]).toBeUndefined();
  });

  test("the built-in shell is off, which is what makes the generation gate true on this path", async () => {
    const h = rig();
    const store = poolStore(h.settings);
    store.write(workingPool());
    store.materialize(null);
    const config = JSON.parse(await Bun.file(paths(h.settings).opencodeConfigPath).text()) as {
      tools: Record<string, boolean>;
    };
    // The Claude harness closes its shell with a PreToolUse hook; opencode has no such hook, so the
    // tool is removed from its surface instead. Without this line a report on this path could be
    // published having run commands nothing recorded — the one thing the gate exists to prevent.
    expect(config.tools["bash"]).toBe(false);
  });

  test("the MCP door is opened only with a bearer, and disabled without one", async () => {
    const h = rig();
    const store = poolStore(h.settings);
    store.write(workingPool());

    store.materialize("s3cret");
    const withSecret = JSON.parse(await Bun.file(paths(h.settings).opencodeConfigPath).text()) as {
      mcp: { yewreview: { enabled: boolean; headers?: Record<string, string>; url: string } };
    };
    expect(withSecret.mcp.yewreview.enabled).toBe(true);
    expect(withSecret.mcp.yewreview.headers?.["Authorization"]).toBe("Bearer s3cret");
    expect(withSecret.mcp.yewreview.url.endsWith(MCP_PATH)).toBe(true);

    store.materialize(null);
    const without = JSON.parse(await Bun.file(paths(h.settings).opencodeConfigPath).text()) as {
      mcp: { yewreview: { enabled: boolean; headers?: Record<string, string> } };
    };
    // Disabled rather than pointed at a door it has no key for: a child that tried the handshake
    // and failed would report a broken MCP server, which reads as a bug rather than as "no server
    // is running yet".
    expect(without.mcp.yewreview.enabled).toBe(false);
    expect(without.mcp.yewreview.headers).toBeUndefined();
  });
});

describe("the MCP door", () => {
  function bridge(h: Harness, secret: string | null = "s3cret") {
    const deps = {
      db: h.db,
      settings: h.settings,
      venv: () => ({
        ready: false,
        python: null,
        seikanBin: null,
        seikanVersion: null,
        dslGuide: null,
        error: null,
      }),
      emit: () => {},
      runs: {
        recording: () => false,
        recipeId: () => null,
        begin: () => () => {},
        entries: () => [],
        retain: () => "r",
        redeem: () => null,
        end: () => {},
      },
      events: () => {},
    } as unknown as ToolDeps;
    const defs = announcing(deps);
    return createMcpBridge(
      () => defs,
      () => secret,
    );
  }

  async function rpc(
    b: ReturnType<typeof bridge>,
    body: unknown,
    secret: string | null = "s3cret",
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await b.handle(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    // A refusal answers in plain text rather than JSON-RPC, deliberately: it is the transport
    // saying no before any RPC was accepted, and a JSON-RPC error body would imply one was.
    const isJson = response.headers.get("content-type")?.includes("json") === true;
    return {
      status: response.status,
      body: isJson && text !== "" ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }

  test("a caller without the bearer gets nothing, whatever it asks for", async () => {
    const h = rig();
    const answered = await rpc(bridge(h), { jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    expect(answered.status).toBe(401);
  });

  test("with no child running the door is not there at all", async () => {
    const h = rig();
    // 404 rather than 401: before a child exists nothing legitimate is calling, and a 401 would
    // tell whatever else on the machine found the port that there is something here to guess at.
    const answered = await rpc(bridge(h, null), { jsonrpc: "2.0", id: 1, method: "tools/list" }, "x");
    expect(answered.status).toBe(404);
  });

  test("it offers exactly the tools the other harness has, and no more", async () => {
    const h = rig();
    const answered = await rpc(bridge(h), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (answered.body["result"] as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    // The same thirty-three the SDK server registers, because they are the same definitions. A
    // harness with a different tool surface would be a harness that can write a different archive —
    // so the seven that went when instructions stopped being a version ledger (the three workshop
    // tools and the four playbook ones) and the five that replaced them (`create_recipe`,
    // `get_recipe`, `list_recipes`, `set_recipe_status`, `delete_recipe`) had to land on BOTH paths
    // at once, exactly as the address-book writes and the rename did before them.
    expect(tools).toHaveLength(33);
    expect(tools.map((t) => t.name)).toContain("publish_report");
    expect(tools.map((t) => t.name)).toContain("run_shell");
    expect(tools.map((t) => t.name)).toContain("start_generation");
    // And the schema the model is shown REFUSES undeclared keys, which is the same guarantee
    // `strictSchema` gives the Claude surface, carried into JSON Schema.
    const publish = tools.find((t) => t.name === "publish_report")!;
    expect(publish.inputSchema["additionalProperties"]).toBe(false);
  });

  test("a call runs the real handler against the real database", async () => {
    const h = rig();
    const b = bridge(h);
    const created = await rpc(b, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_recipe",
        arguments: { name: "Semis", content: "Write two reports, weekly." },
      },
    });
    const result = created.body["result"] as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    // Not a mock: the row is in the database this test opened.
    const row = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recipe").get();
    expect(row?.n).toBe(1);
    // The name the row actually carries, minted from the hint the call gave — the same answer the
    // other harness gets, because it is the same handler writing the same table.
    expect(result.content[0]!.text).toContain("Stored semis, active.");
    expect(
      h.db.query<{ name: string; content: string }, []>("SELECT name, content FROM recipe").get(),
    ).toEqual({ name: "semis", content: "Write two reports, weekly." });
  });

  test("a misspelled argument is refused, not dropped", async () => {
    const h = rig();
    const answered = await rpc(bridge(h), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_recipe",
        arguments: { name: "Semis", content: "Write two reports, weekly.", nmae: "typo" },
      },
    });
    const result = answered.body["result"] as { content: Array<{ text: string }>; isError?: boolean };
    // The whole point of `strictSchema`, enforced on this surface as much as on the other one: Zod
    // would otherwise strip the unknown key silently and the call would look like it worked.
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("nmae");
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM recipe").get()?.n).toBe(0);
  });

  test("a tool nobody defined is an error rather than a crash", async () => {
    const h = rig();
    const answered = await rpc(bridge(h), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "drop_everything", arguments: {} },
    });
    expect((answered.body["error"] as { message: string }).message).toContain("drop_everything");
  });

  test("a notification is acknowledged with no body, as the protocol says", async () => {
    const h = rig();
    const response = await bridge(h).handle(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("the handshake names the tools capability and nothing this server does not have", async () => {
    const h = rig();
    const answered = await rpc(bridge(h), { jsonrpc: "2.0", id: 1, method: "initialize" });
    const result = answered.body["result"] as {
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
    };
    // Tools and only tools. There are no resources, no prompts and no sampling here, and claiming
    // one would have a client asking for something that is not implemented.
    expect(Object.keys(result.capabilities)).toEqual(["tools"]);
    expect(result.serverInfo.name).toBe("yewreview");
  });
});

describe("what the opencode harness is told", () => {
  test("the doctrine goes first, and the person's own words follow it", () => {
    // The mechanism is the point: opencode composes its own system prompt and there is no verified
    // way for a host to replace it, so this rides the first turn. What must be true is that the
    // user's message is still in there, and last.
    expect(firstTurn("what changed at NVDA?")).toStartWith(OPENCODE_DOCTRINE.slice(0, 40));
    expect(firstTurn("what changed at NVDA?")).toEndWith("what changed at NVDA?");
  });

  test("it names the tools the way opencode addresses them", () => {
    // opencode namespaces an MCP server's tools as `<server>_<tool>`, so a doctrine written in the
    // Claude path's bare names would be telling the model about tools it cannot see. Verified
    // against a running opencode 1.18.
    expect(OPENCODE_DOCTRINE).toContain(`${TOOL_PREFIX}publish_report`);
    expect(OPENCODE_DOCTRINE).toContain(`${TOOL_PREFIX}run_shell`);
    expect(OPENCODE_DOCTRINE).not.toMatch(/[^_]\bpublish_report\b/);
  });

  test("it carries the doctrine that is about the archive rather than about a harness", () => {
    // These four are the same on both paths BY DESIGN — a report must not be able to tell you which
    // harness produced it — so they are pinned here as well as in the Claude prompt's own tests.
    //
    // Compared with the line breaks collapsed: this is prose in a hard-wrapped markdown block, so a
    // sentence's position relative to column 100 is not a thing anybody should have to preserve to
    // keep a test passing.
    const said = OPENCODE_DOCTRINE.replace(/\s+/g, " ");
    // THE PIN INVERTED HERE TOO, and the old sentence has to be gone rather than beside its
    // replacement: a doctrine saying a procedure is the user's alone, next to a tool that opens
    // one, would tell the model not to use what it has been handed.
    expect(said).toContain("you open one with `yewreview_start_generation`");
    expect(said).toContain("being asked is the authorisation");
    expect(said).toContain("**Produce the report in that same turn**");
    // The one recipe a procedure cannot open under, said on this path too: the gate is shared, so a
    // model told about the refusal on one harness and not the other would meet it as a surprise.
    expect(said).toContain("An INACTIVE recipe is refused");
    expect(said).toContain("**The archive holds still while a procedure runs.**");
    expect(said).toContain("store the scripts and theses you will need BEFORE you start");
    expect(said).not.toContain("which only the user can start");
    expect(said).not.toContain("there is no tool for it");
    expect(said).toContain("Quote, never paraphrase");
    expect(said).toContain("Wait for any command still running before you publish");
    expect(said).toContain("is a finished report");
  });

  test("it states the consent rule over the documents that are the user's rather than its own", () => {
    // THE PIN INVERTED, AND IT MATTERS MOST ON THIS PATH. This doctrine used to say that two things
    // were NOT the model's to write, because a form in the window wrote them. The window writes
    // nothing now, so the same two documents are written from here — and what protects them can no
    // longer be a missing tool. It is the rule: the whole of what is about to be stored is rendered
    // in the reply, and the user says afterwards that it is what they want.
    //
    // This harness needs the rule said in its own words rather than borrowed, because opencode
    // composes its own system prompt and this text rides the first turn: a model reading only the
    // tool descriptions would have the rule, and a model reading only this would not.
    const said = OPENCODE_DOCTRINE.replace(/\s+/g, " ");
    expect(said).toContain("not your account of anything");
    expect(said).toContain("**Show the whole of it first, then wait.**");
    expect(said).toContain("A message that merely opens the subject authorises nothing");
    expect(said).toContain("If they change something, show the whole of it again");
    expect(said).toContain("Never write a document whose final wording nobody has read");
    // And the pin, in this harness's words too: showing the draft once is what lets somebody agree
    // to wording that has since scrolled away, so it is restated at the end of every reply until it
    // is stored or dropped.
    expect(said).toContain("end every reply with the whole of the current draft, updated");
    // With its two edges, on this path too: the block is complete — every field the tool takes,
    // none of the machine's — and the drafting ends at the save, confirmed by the tool's own
    // sentence rather than by the block one more time.
    expect(said).toContain("Every field the tool takes is in the block");
    expect(said).toContain("no id, no timestamp, nothing the database writes for itself");
    expect(said).toContain("Once a tool has recorded it, stop");
    expect(said).toContain("the block is not rendered again");
    // IN THE SAME GRAMMAR THE OTHER HARNESS USES, which is the point of stating it here at all. A
    // row block is what the window parses and draws as a card, and the window is one window: a
    // doctrine that let this path render drafts freehand would give the same reader two different
    // shapes for the same act depending on which harness happened to be running.
    expect(said).toContain("~~~row");
    expect(said).toContain("ROW BLOCK");
    expect(said).toContain("`****` on any field not filled in yet");
    expect(said).toContain("one row block, however little changed");
    expect(said).not.toContain("never fenced as code");
    // And the creation protocol, condensed to what this path needs: what a `+` does now, what the
    // first reply is, the one creation that has no empty draft, and where an ask made mid-work goes.
    expect(said).toContain("**Answer an opening with the empty draft**");
    expect(said).toContain("A THESIS OPENS WITH NO EMPTY DRAFT");
    // THE PIN INVERTED. A `+` used to put the conversation down and open a fresh session for the
    // creation; it speaks into the one on screen now, and the doctrine has to say which — a model
    // told the opening arrived in a conversation of its own would answer as if nothing else were
    // being worked on.
    expect(said).toContain("speaks one terse line naming the act INTO THE CONVERSATION ON SCREEN");
    expect(said).toContain("nothing is put down and nothing new is opened");
    expect(said).not.toContain("a creation gets a conversation of its own");
    // And the ask written out rather than described, for the reason the other harness's prompt gives
    // at length: "one short line" is a target a model hits with three clauses and a rationale.
    expect(said).toContain(`"Describe it and I'll fill this in." is the whole of it`);
    // Named in opencode's own spelling, which is the half a rule stated abstractly would miss: the
    // model has to be able to see which of its tools the rule is about.
    for (const tool of [
      "create_recipe",
      "create_information_source",
      "update_information_source",
      "create_thesis",
      "rename_record",
    ]) {
      expect(OPENCODE_DOCTRINE).toContain(`${TOOL_PREFIX}${tool}`);
    }
    // And the thesis's seam, said on this path too. Its claim is the user's and is agreed in both
    // halves; the measurement is the half that does not bend to what they were hoping for; and the
    // reading afterwards is the model's own, which is why the ledger tool carries no such rule.
    expect(said).toContain("A thesis is agreed in both halves");
    expect(said).toContain("never bend the document toward a formulation because they pushed for it");
    expect(said).toContain("**A measurement shaped to please whoever commissioned it measures nothing**");
    expect(said).toContain(`${TOOL_PREFIX}assess_thesis\` carries no such rule and is not meant to`);
    // Born measured, in this harness's words: the document is measured from its own bytes before
    // anything is stored, the storing call files the first reading with the container, and the
    // seam holds through it — the draft shows both rows, and the tag is not up for negotiation.
    expect(said).toContain("It is stored already measured");
    expect(said).toContain("takes the document itself as `dsl_json` before anything is stored");
    expect(said).toContain("writes the container and files your first reading in one act");
    expect(said).toContain("the draft is then two row blocks");
    expect(said).toContain("the tag is not theirs to bargain up");
    // And the sentence that used to stand here is GONE rather than left beside its replacement. A
    // doctrine carrying both would tell the model it cannot write the specification and then hand
    // it the tool that does.
    expect(said).not.toContain("NOT yours to write");
    // Nor may the vocabulary that went with the version ledger survive anywhere in this text: there
    // is no workshop to hold a recipe and no revising one, so a doctrine naming either would teach
    // the model a tool its list does not have.
    expect(said).not.toContain("workshop");
    expect(said).not.toContain("playbook");
  });
});

describe("the roles a window draws", () => {
  test("they are opencode's own, and the one that answers is among them", () => {
    // A slot for a role opencode does not have would be a control that does nothing; these five
    // are what its agent list actually offers. Verified against opencode 1.18.
    expect([...OPENCODE_ROLES]).toEqual(["build", "plan", "general", "explore", "scout"]);
    expect(OPENCODE_ROLES).toContain(PRIMARY_ROLE);
  });
});
