import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { LoggerLike } from "../src/runs/run-service.js";
import type { RunStore } from "../src/runs/run-store.js";
import { SchedulerService } from "../src/scheduler/SchedulerService.js";
import { testConfig } from "./helpers.js";

interface LogEntry {
  payload: Record<string, unknown>;
  message?: string;
}

function logger(errors: LogEntry[]): LoggerLike {
  return {
    info() {
      return undefined;
    },
    error(payload, message) {
      errors.push({ payload, ...(message ? { message } : {}) });
    },
  };
}

function config(maxConcurrentRuns = 2): AppConfig {
  return {
    ...testConfig(),
    scheduler: { maxConcurrentRuns },
  };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(message);
}

describe("scheduler error handling", () => {
  it("marks a run failed and frees its slot when execution rejects", async () => {
    const errors: LogEntry[] = [];
    const failures: Array<{ runId: string; code: string; message: string }> =
      [];
    let claimed = false;

    const store = {
      async claimNextQueuedRun() {
        if (claimed) {
          return null;
        }

        claimed = true;
        return { id: "run-1" };
      },
      async getRun(runId: string) {
        return { id: runId, status: "running" };
      },
      async markRunFailed(runId: string, code: string, message: string) {
        failures.push({ runId, code, message });
      },
      async countRunsByStatus() {
        return 0;
      },
      async listQueuedRuns() {
        return [];
      },
    } as unknown as RunStore;

    const scheduler = new SchedulerService({
      store,
      config: config(1),
      logger: logger(errors),
      execute: async () => {
        throw new Error("worker crashed");
      },
    });

    scheduler.drain();

    await waitFor(
      () => failures.length > 0 && scheduler.activeCount === 0,
      "scheduler did not persist the execution error"
    );

    expect(failures).toEqual([
      { runId: "run-1", code: "SCHEDULER_ERROR", message: "worker crashed" },
    ]);
    expect(
      errors.some((entry) => entry.message === "Scheduled run failed")
    ).toBe(true);
    expect(scheduler.activeCount).toBe(0);
  });

  it("logs a queue-claim error and recovers on the next drain", async () => {
    const errors: LogEntry[] = [];
    const executed: string[] = [];
    let claims = 0;

    const store = {
      async claimNextQueuedRun() {
        claims += 1;

        if (claims === 1) {
          throw new Error("database is locked");
        }

        return claims === 2 ? { id: "run-2" } : null;
      },
      async getRun(runId: string) {
        return { id: runId, status: "completed" };
      },
      async markRunFailed() {
        return undefined;
      },
      async countRunsByStatus() {
        return 0;
      },
      async listQueuedRuns() {
        return [];
      },
    } as unknown as RunStore;

    const scheduler = new SchedulerService({
      store,
      config: config(1),
      logger: logger(errors),
      execute: async (runId) => {
        executed.push(runId);
      },
    });

    scheduler.drain();

    await waitFor(
      () => errors.some((entry) => entry.message === "Scheduler drain failed"),
      "scheduler did not log the claim failure"
    );
    expect(executed).toEqual([]);

    scheduler.drain();
    await waitFor(() => claims >= 2, "scheduler did not drain again");
    await waitFor(
      () => executed.includes("run-2"),
      "scheduler did not execute the queued run after recovering"
    );

    expect(executed).toEqual(["run-2"]);
    expect(errors[0]?.payload.err).toBeInstanceOf(Error);
  });
});
