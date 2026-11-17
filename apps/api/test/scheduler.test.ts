import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { Agent } from "../src/agents/base/agent.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { createTestDatabase, testConfig, type TestDatabase } from "./helpers.js";

interface BlockingAgent {
  agent: Agent;
  release(runId: string): void;
  started(): string[];
  maxActive(): number;
}

function blockingAgent(): BlockingAgent {
  const gates = new Map<string, () => void>();
  const startedRuns: string[] = [];
  let active = 0;
  let maxActive = 0;

  return {
    agent: {
      id: "blocking-agent",
      name: "Blocking Agent",
      description: "Waits until the test releases its run.",
      capabilities: [],
      providerId: "scripted",
      model: "scripted-1",
      async run(_input, context) {
        startedRuns.push(context.runId);
        active += 1;
        maxActive = Math.max(maxActive, active);

        return new Promise((resolve) => {
          gates.set(context.runId, () => {
            active -= 1;
            const now = new Date().toISOString();

            resolve({
              agentId: "blocking-agent",
              status: "completed" as const,
              startedAt: now,
              completedAt: now,
              durationMs: 0,
            });
          });
        });
      },
    },
    release(runId) {
      const gate = gates.get(runId);
      gates.delete(runId);
      gate?.();
    },
    started: () => [...startedRuns],
    maxActive: () => maxActive,
  };
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  message: string
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await check();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(message);
}

async function runStatuses(
  app: FastifyInstance
): Promise<Record<string, string>> {
  const response = await app.inject({ method: "GET", url: "/runs?limit=50" });
  const runs = response.json().runs as Array<{ id: string; status: string }>;

  return Object.fromEntries(runs.map((run) => [run.id, run.status]));
}

describe("scheduler", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let agent: BlockingAgent;

  beforeAll(async () => {
    db = createTestDatabase();
    agent = blockingAgent();
    app = buildApp({
      logger: false,
      config: {
        ...testConfig(db.config.databaseUrl),
        scheduler: { maxConcurrentRuns: 2 },
      },
      agents: new AgentRegistry().register(agent.agent),
      githubClient: null,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.cleanup();
  });

  async function submit(prompt: string) {
    const response = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt, agentId: "blocking-agent" },
    });

    expect(response.statusCode).toBe(202);
    return response.json().run.id as string;
  }

  it("runs at most the configured number of runs and starts the queued run on completion", async () => {
    const first = await submit("first");
    const second = await submit("second");
    const third = await submit("third");

    const started = await waitFor(async () => {
      if (agent.started().length < 2) {
        return null;
      }

      const statuses = await runStatuses(app);

      return Object.values(statuses).filter((status) => status === "running")
        .length === 2
        ? statuses
        : null;
    }, "two runs did not start");

    expect(started[third]).toBe("queued");
    expect(agent.maxActive()).toBe(2);

    // The third run has not begun while both slots are occupied.
    expect(agent.started()).not.toContain(third);

    agent.release(first);

    await waitFor(async () => {
      const statuses = await runStatuses(app);

      return statuses[third] === "running" ? statuses : null;
    }, "queued run did not start after a slot freed");

    expect(agent.started()).toContain(third);
    expect(agent.maxActive()).toBe(2);

    agent.release(second);
    agent.release(third);

    await waitFor(async () => {
      const statuses = await runStatuses(app);
      const terminal = [statuses[first], statuses[second], statuses[third]];

      return terminal.every((status) => status === "completed")
        ? statuses
        : null;
    }, "runs did not complete");
  });

  it("cancels a queued run without executing it", async () => {
    // Occupy both slots, then queue a fourth run behind them.
    const blockerOne = await submit("blocker one");
    const blockerTwo = await submit("blocker two");

    await waitFor(async () => {
      const statuses = await runStatuses(app);

      return statuses[blockerOne] === "running" &&
        statuses[blockerTwo] === "running"
        ? statuses
        : null;
    }, "blockers did not start");

    const queued = await submit("cancel me");
    const statuses = await runStatuses(app);

    expect(statuses[queued]).toBe("queued");

    const cancelled = await app.inject({
      method: "POST",
      url: `/runs/${queued}/cancel`,
    });

    expect(cancelled.statusCode).toBe(202);

    const detail = await app.inject({ method: "GET", url: `/runs/${queued}` });

    expect(detail.json().run.status).toBe("cancelled");
    expect(detail.json().run.events.at(-1)).toMatchObject({
      type: "run.cancelled",
    });

    agent.release(blockerOne);
    agent.release(blockerTwo);

    await waitFor(async () => {
      const current = await runStatuses(app);

      return current[blockerOne] === "completed" &&
        current[blockerTwo] === "completed"
        ? current
        : null;
    }, "blockers did not complete");

    expect(agent.started()).not.toContain(queued);

    const terminalCancel = await app.inject({
      method: "POST",
      url: `/runs/${queued}/cancel`,
    });

    expect(terminalCancel.statusCode).toBe(409);
  });
});
