import { describe, expect, it, vi } from "vitest";
import { Agent, AgentBusyError } from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import { type BranchingHistory, emptyHistory, type HistoryRepository } from "../src/history.ts";
import type { LlmCompletion } from "../src/llm-client.ts";
import { completionResponse, fakeClient } from "./support/fake-client.ts";

function setup(state = emptyHistory("branching")) {
  const fake = fakeClient(Array.from({ length: 30 }, () => ({ content: "ответ", totalTokens: 5 })));
  const repository = { load: vi.fn(() => state), save: vi.fn<HistoryRepository["save"]>() };
  const agent = new Agent({
    client: fake.client,
    historyRepository: repository,
    config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "branching", historyKeepLastMessages: 2 },
  });
  return { ...fake, agent, repository };
}

describe("branching", () => {
  it("creates independent branches from a stable checkpoint and sends only the full active history", async () => {
    const { agent, calls, repository } = setup();
    await agent.respond("общая цель");
    agent.createCheckpoint();
    agent.createBranch("вариант-а");
    await agent.respond("срок A");
    await agent.respond("детали A");
    agent.createBranch("вариант-б");
    const b = await agent.respond("срок B");
    expect(b.usage.session.totalTokens).toBe(20);
    expect(b.usage.factsCall).toBeNull();
    expect(calls[3]!.messages.slice(1)).toEqual([
      { role: "user", content: "общая цель" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "срок B" },
    ]);
    agent.switchBranch("вариант-а");
    await agent.respond("итог A");
    expect(calls[4]!.messages).toHaveLength(8);
    expect(JSON.stringify(calls[4])).not.toContain("срок B");
    const state = repository.save.mock.lastCall![0] as BranchingHistory;
    expect(state.checkpoint).toEqual([
      { role: "user", content: "общая цель" },
      { role: "assistant", content: "ответ" },
    ]);
    expect(state.branches.main).toEqual(state.checkpoint);
    expect(state.branches["вариант-б"]).toHaveLength(4);
    expect(agent.listBranches()).toEqual([
      { name: "main", active: false, messageCount: 2 },
      { name: "вариант-а", active: true, messageCount: 8 },
      { name: "вариант-б", active: false, messageCount: 4 },
    ]);
    expect(agent.getContextStatus()).toEqual({ strategy: "branching", activeBranch: "вариант-а" });
    const restored = setup(state);
    expect(restored.agent.getContextStatus().activeBranch).toBe("вариант-а");
    const result = await restored.agent.respond("после перезапуска");
    expect(result.usage.session.totalTokens).toBe(5);
    expect(restored.calls[0]!.messages.slice(1, -1)).toEqual(state.branches["вариант-а"]);
  });

  it("rejects absent checkpoint, duplicate and invalid names without saves or LLM calls", () => {
    const { agent, calls, repository } = setup();
    expect(() => agent.createBranch("a")).toThrow("Нет checkpoint");
    expect(() => agent.switchBranch("a")).toThrow("не существует");
    expect(() => agent.switchBranch("toString")).toThrow("не существует");
    for (const name of ["", "a b", "../a", "__proto__", "x".repeat(65)])
      expect(() => agent.createBranch(name)).toThrow("Имя ветки");
    expect(repository.save).not.toHaveBeenCalled();
    agent.createCheckpoint();
    agent.createBranch("a");
    expect(() => agent.createBranch("a")).toThrow("уже существует");
    expect(() => agent.createBranch("main")).toThrow("уже существует");
    expect(calls).toHaveLength(0);
    expect(repository.save).toHaveBeenCalledTimes(2);
  });

  it("detaches nested histories, facts-free snapshots and returned branch lists", async () => {
    const state: BranchingHistory = {
      kind: "branching",
      activeBranch: "a",
      branches: {
        main: [],
        a: [
          { role: "user", content: "original" },
          { role: "assistant", content: "answer" },
        ],
      },
      checkpoint: [],
    };
    const { agent, calls, repository } = setup(state);
    state.branches.a![0]!.content = "mutated after load";
    state.checkpoint!.push({ role: "user", content: "mutated" });
    repository.save.mockImplementation((snapshot) => {
      const branch = snapshot as BranchingHistory;
      branch.branches.a![0]!.content = "mutated during save";
      branch.checkpoint!.push({ role: "user", content: "mutated during save" });
    });
    agent.listBranches()[0]!.name = "mutated list";
    await agent.respond("first");
    await agent.respond("second");
    expect(calls[1]!.messages[1]!.content).toBe("original");
    agent.createBranch("b");
    await agent.respond("third");
    expect(calls[2]!.messages).toHaveLength(2);
    expect(agent.listBranches()[0]!.name).toBe("main");
  });

  it.each(["checkpoint", "create", "switch", "reset", "respond"])(
    "keeps all state and usage after failed %s save",
    async (operation) => {
      const { agent, repository, calls } = setup();
      await agent.respond("prefix");
      agent.createCheckpoint();
      agent.createBranch("a");
      await agent.respond("a-only");
      const before = structuredClone(repository.save.mock.lastCall![0]) as BranchingHistory;
      repository.save.mockImplementationOnce((state) => {
        (state as BranchingHistory).branches.main = [];
        throw new Error("disk");
      });
      switch (operation) {
        case "checkpoint":
          expect(() => agent.createCheckpoint()).toThrow("disk");
          break;
        case "create":
          expect(() => agent.createBranch("b")).toThrow("disk");
          break;
        case "switch":
          expect(() => agent.switchBranch("main")).toThrow("disk");
          break;
        case "reset":
          expect(() => agent.reset()).toThrow("disk");
          break;
        case "respond":
          await expect(agent.respond("failed")).rejects.toThrow("disk");
          break;
      }
      expect(agent.getContextStatus().activeBranch).toBe("a");
      const result = await agent.respond("continued");
      expect(result.usage.session.totalTokens).toBe(operation === "respond" ? 20 : 15);
      expect(calls.at(-1)!.messages.slice(1, -1)).toEqual(before.branches.a);
      agent.createBranch("b");
      expect((repository.save.mock.lastCall![0] as BranchingHistory).branches.b).toEqual(before.checkpoint);
      agent.reset();
      expect(repository.save).toHaveBeenLastCalledWith(emptyHistory("branching"));
      expect(agent.getContextStatus().activeBranch).toBe("main");
      expect((await agent.respond("fresh")).usage.session.totalTokens).toBe(5);
    },
  );

  it("blocks all branch mutations during a pending turn", async () => {
    let release!: (value: LlmCompletion) => void;
    const agent = new Agent({
      config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "branching" },
      client: {
        create: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    });
    const pending = agent.respond("q");
    for (const action of [
      () => agent.createCheckpoint(),
      () => agent.createBranch("a"),
      () => agent.switchBranch("main"),
      () => agent.reset(),
    ])
      expect(action).toThrow(AgentBusyError);
    expect(agent.listBranches()).toEqual([{ name: "main", active: true, messageCount: 0 }]);
    release(completionResponse({ model: "test", messages: [] }));
    await pending;
    agent.createCheckpoint();
  });

  it("rejects branch commands outside branching", () => {
    const agent = new Agent({ client: fakeClient([]).client, config: DEFAULT_AGENT_CONFIG });
    for (const action of [
      () => agent.createCheckpoint(),
      () => agent.createBranch("a"),
      () => agent.switchBranch("main"),
      () => agent.listBranches(),
    ])
      expect(action).toThrow("только в режиме branching");
  });
});
