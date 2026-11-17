import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { Agent } from "../src/agents/base/agent.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { createPrismaClient } from "../src/db/client.js";
import { RunStore } from "../src/runs/run-store.js";
import { createTestDatabase, testConfig, type TestDatabase } from "./helpers.js";

async function waitForRun(app: FastifyInstance, runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/runs/${runId}` });
    const body = response.json();

    if (
      body.run?.status === "completed" ||
      body.run?.status === "failed" ||
      body.run?.status === "cancelled"
    ) {
      return body.run;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Run ${runId} did not finish in time`);
}

const throwingAgent: Agent = {
  id: "throwing-agent",
  name: "Throwing Agent",
  description: "Throws before returning a result.",
  capabilities: [],
  async run() {
    throw new Error("agent exploded");
  },
};

const workspaceAgent: Agent = {
  id: "workspace-agent",
  name: "Workspace Agent",
  description: "Requires a worktree that the test does not provide.",
  capabilities: ["coding"],
  requiresWorkspace: true,
  async run() {
    throw new Error("the agent should never be invoked");
  },
};

function buildFailureApp(db: TestDatabase) {
  return buildApp({
    logger: false,
    config: testConfig(db.config.databaseUrl),
    agents: new AgentRegistry()
      .register(throwingAgent)
      .register(workspaceAgent),
    githubClient: null,
  });
}

describe("worker failure paths", () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createTestDatabase();
    app = buildFailureApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.cleanup();
  });

  it("persists a thrown agent error as a failed run", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt: "Explode", agentId: "throwing-agent" },
    });

    expect(created.statusCode).toBe(202);

    const run = await waitForRun(app, created.json().run.id);

    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("AGENT_CRASHED");
    expect(run.errorMessage).toContain("agent exploded");
    expect(run.completedAt).toEqual(expect.any(String));
    expect(run.events.at(-1)).toMatchObject({
      type: "run.failed",
      percent: 100,
    });

    const task = await app.inject({
      method: "GET",
      url: `/tasks/${created.json().task.id}`,
    });

    expect(task.json().task.status).toBe("failed");
  });

  it("fails a coding run when no workspace can be created", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt: "Needs a worktree", agentId: "workspace-agent" },
    });

    expect(created.statusCode).toBe(202);

    const run = await waitForRun(app, created.json().run.id);

    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("WORKSPACE_UNAVAILABLE");
    expect(run.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.failed",
          data: expect.objectContaining({ code: "WORKSPACE_UNAVAILABLE" }),
        }),
      ])
    );
  });
});

describe("database failure responses", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let prisma: ReturnType<typeof createPrismaClient>;

  beforeAll(async () => {
    db = createTestDatabase();
    prisma = createPrismaClient(db.config.databaseUrl);
    const store = new RunStore(prisma);

    store.listTasks = async () => {
      throw new Error("database is unavailable: secret connection string");
    };

    app = buildApp({ logger: false, config: db.config, store });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    db.cleanup();
  });

  it("returns a generic 500 instead of leaking database errors", async () => {
    const response = await app.inject({ method: "GET", url: "/tasks" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      success: false,
      error: "An unexpected error occurred.",
    });
    expect(response.body).not.toContain("secret connection string");
  });
});
