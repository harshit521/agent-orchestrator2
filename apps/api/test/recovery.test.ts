import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { createPrismaClient } from "../src/db/client.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

async function waitForStatus(
  app: FastifyInstance,
  runId: string,
  statuses: string[]
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/runs/${runId}` });
    const body = response.json();

    if (statuses.includes(body.run?.status as string)) {
      return body.run;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Run ${runId} did not reach ${statuses.join("/")}`);
}

describe("startup recovery", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let interruptedRunId: string;
  let interruptedTaskId: string;
  let queuedRunId: string;
  let queuedTaskId: string;

  beforeAll(async () => {
    db = createTestDatabase();
    const prisma = createPrismaClient(db.config.databaseUrl);

    const interrupted = await prisma.task.create({
      data: {
        title: "Interrupted run",
        prompt: "This run was executing when the process stopped",
        agentId: "research-agent",
        status: "running",
        priority: "medium",
        runs: {
          create: { agentId: "research-agent", status: "running" },
        },
      },
      include: { runs: true },
    });

    const queued = await prisma.task.create({
      data: {
        title: "Queued run",
        prompt: "This run was waiting for a slot",
        agentId: "research-agent",
        status: "queued",
        priority: "medium",
        runs: {
          create: { agentId: "research-agent", status: "queued" },
        },
      },
      include: { runs: true },
    });

    interruptedTaskId = interrupted.id;
    interruptedRunId = interrupted.runs[0]!.id;
    queuedTaskId = queued.id;
    queuedRunId = queued.runs[0]!.id;

    await prisma.$disconnect();

    app = buildApp({ logger: false, config: db.config });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.cleanup();
  });

  it("fails orphaned running runs instead of leaving them stuck", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${interruptedRunId}`,
    });
    const run = response.json().run;

    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("INTERRUPTED_BY_RESTART");
    expect(run.errorMessage).toContain("API restarted");
    expect(run.events.at(-1)).toMatchObject({
      type: "run.failed",
      data: { code: "INTERRUPTED_BY_RESTART" },
    });

    const task = await app.inject({
      method: "GET",
      url: `/tasks/${interruptedTaskId}`,
    });

    expect(task.json().task.status).toBe("failed");
  });

  it("drains queued runs normally after a restart", async () => {
    const run = await waitForStatus(app, queuedRunId, [
      "completed",
      "failed",
      "cancelled",
    ]);

    expect(run.status).toBe("completed");

    const types = run.events.map((event: { type: string }) => event.type);

    // The run was queued before this process started, so the first event the
    // scheduler records is the claim itself.
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");

    const task = await app.inject({
      method: "GET",
      url: `/tasks/${queuedTaskId}`,
    });

    expect(task.json().task.status).toBe("completed");
  });
});
