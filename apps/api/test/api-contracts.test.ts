import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { createTestDatabase, type TestDatabase } from "./helpers.js";

describe("API contracts", () => {
  let db: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createTestDatabase();
    app = buildApp({ logger: false, config: db.config });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.cleanup();
  });

  async function expectValidationError(
    response: { statusCode: number; json(): unknown },
    path: string
  ) {
    expect(response.statusCode).toBe(400);

    const body = response.json() as {
      success: boolean;
      error: string;
      issues: Array<{ path: string; message: string }>;
    };

    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid request.");
    expect(body.issues.some((issue) => issue.path === path)).toBe(true);
  }

  it("rejects create-task payloads that violate the schema", async () => {
    const missingPrompt = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { title: "No prompt" },
    });
    const blankPrompt = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt: "   " },
    });
    const badPriority = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt: "Bad priority", priority: "sometime" },
    });
    const badStart = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt: "Bad start", start: "yes" },
    });

    await expectValidationError(missingPrompt, "prompt");
    await expectValidationError(blankPrompt, "prompt");
    await expectValidationError(badPriority, "priority");
    await expectValidationError(badStart, "start");
  });

  it("rejects invalid run and activity query parameters", async () => {
    for (const url of [
      "/runs?limit=0",
      "/runs?limit=abc",
      "/runs?status=unknown",
      "/runs?agentId=",
      "/activity?limit=0",
      "/activity?limit=101",
    ]) {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode, url).toBe(400);
      expect(response.json().success).toBe(false);
      expect(response.json().issues.length).toBeGreaterThan(0);
    }
  });

  it("returns 404 for unknown tasks, runs and agents", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/tasks/missing-task" }),
      app.inject({ method: "GET", url: "/runs/missing-run" }),
      app.inject({ method: "GET", url: "/runs/missing-run/events" }),
      app.inject({ method: "GET", url: "/agents/missing-agent" }),
      app.inject({
        method: "PATCH",
        url: "/tasks/missing-task",
        payload: { title: "Still missing" },
      }),
      app.inject({ method: "DELETE", url: "/tasks/missing-task" }),
      app.inject({ method: "POST", url: "/tasks/missing-task/run" }),
      app.inject({ method: "POST", url: "/runs/missing-run/cancel" }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json().success).toBe(false);
    }
  });

  it("rejects unknown agents for create and run requests", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt: "Unknown agent", agentId: "ghost-agent" },
    });

    expect(created.statusCode).toBe(404);
    expect(created.json()).toMatchObject({
      success: false,
      error: "Unknown agent: ghost-agent",
    });
  });

  it("creates a queued task and starts it explicitly", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { prompt: "Explicit start", start: false },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      success: true,
      run: null,
      task: { status: "queued" },
    });
    expect(created.json().task.runs).toEqual([]);

    const taskId = created.json().task.id as string;
    const started = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/run`,
    });

    expect(started.statusCode).toBe(202);
    expect(started.json().task.id).toBe(taskId);
    expect(started.json().run.taskId).toBe(taskId);
    expect(["queued", "running", "completed"]).toContain(
      started.json().run.status
    );
  });

  it("exposes scheduler, integration and health contracts", async () => {
    const stats = await app.inject({ method: "GET", url: "/stats" });

    expect(stats.statusCode).toBe(200);
    expect(stats.json().scheduler).toMatchObject({
      activeRuns: expect.any(Number),
      queuedRuns: expect.any(Number),
      maxConcurrentRuns: expect.any(Number),
    });

    const integrations = await app.inject({
      method: "GET",
      url: "/integrations",
    });

    expect(integrations.statusCode).toBe(200);
    expect(integrations.json()).toMatchObject({
      success: true,
      health: { status: "ok" },
      llm: { provider: "stub" },
      worktrees: { enabled: false },
      security: { enabled: false, policy: "fail-closed" },
    });

    const health = await app.inject({ method: "GET", url: "/health" });

    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
  });
});
