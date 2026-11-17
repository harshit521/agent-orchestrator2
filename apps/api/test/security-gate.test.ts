import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type { Agent } from "../src/agents/base/agent.js";
import type { AgentContext } from "../src/agents/base/agent-context.js";
import { AgentRegistry } from "../src/agents/registry.js";
import type { SecurityGate, SecurityPolicy } from "../src/security/gate.js";
import type { ScannerResult } from "../src/security/scanner.js";
import { WorktreeService } from "../src/worktrees/worktree-service.js";
import {
  createTestDatabase,
  testConfig,
  type TestDatabase,
} from "./helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function codingAgent(): Agent {
  return {
    id: "security-coder",
    name: "Security Coder",
    description: "Writes one file into the assigned worktree.",
    capabilities: ["coding"],
    providerId: "scripted",
    model: "scripted-1",
    requiresWorkspace: true,
    async run(_input, context: AgentContext) {
      const workspace = context.workspace;

      if (!workspace) {
        throw new Error("No workspace");
      }

      writeFileSync(
        path.join(workspace.path, "SECURITY_CHANGE.md"),
        "# changed by the security test agent\n"
      );
      const now = new Date().toISOString();

      return {
        agentId: "security-coder",
        status: "completed",
        output: { summary: "Wrote SECURITY_CHANGE.md" },
        provider: "scripted",
        model: "scripted-1",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
      };
    },
  };
}

function finding(): ScannerResult {
  return {
    id: "fake-secret-scanner",
    label: "Fake secret scanner",
    status: "failed",
    exitCode: 1,
    durationMs: 3,
    output: "hard-coded secret detected",
  };
}

function gate(
  policy: SecurityPolicy,
  scan: () => Promise<ScannerResult[]>
): SecurityGate {
  return { policy, scan };
}

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

describe("security gate", () => {
  let db: TestDatabase;
  let worktreesRoot: string;
  let service: WorktreeService;
  const runIds: string[] = [];

  beforeAll(() => {
    db = createTestDatabase();
    worktreesRoot = mkdtempSync(path.join(tmpdir(), "taskfleet-security-"));
    service = new WorktreeService({
      repoRoot: REPO_ROOT,
      worktreesRoot,
      authorName: "TaskFleet Test",
      authorEmail: "test@taskfleet.dev",
    });

    // Keep the test offline even if a developer has GitHub configured locally.
    service.push = async () => undefined;
  });

  afterAll(() => {
    for (const runId of runIds) {
      try {
        execFileSync("git", ["branch", "-D", `taskfleet/${runId}`], {
          cwd: REPO_ROOT,
          stdio: "pipe",
        });
      } catch {
        // Fail-closed runs never create a branch/commit.
      }
    }

    execFileSync("git", ["worktree", "prune"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    rmSync(worktreesRoot, { recursive: true, force: true });
    db.cleanup();
  });

  async function startApp(securityGate: SecurityGate): Promise<FastifyInstance> {
    const base = testConfig(db.config.databaseUrl);
    const app = buildApp({
      logger: false,
      config: {
        ...base,
        worktrees: {
          enabled: true,
          root: worktreesRoot,
          keepOnFailure: false,
          keepOnSuccess: false,
        },
        agent: {
          ...base.agent,
          testCommand: 'node -e "process.exit(0)"',
          runTests: true,
          requireChanges: true,
        },
        security: {
          ...base.security,
          enabled: true,
        },
      },
      agents: new AgentRegistry().register(codingAgent()),
      worktreeService: service,
      githubClient: null,
      securityGate,
    });

    await app.ready();
    return app;
  }

  async function submit(app: FastifyInstance) {
    const response = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        prompt: "Write a file and run the security gate",
        agentId: "security-coder",
      },
    });

    expect(response.statusCode).toBe(202);
    const runId = response.json().run.id as string;
    runIds.push(runId);

    return runId;
  }

  it("blocks the commit under fail-closed and persists scanner findings", async () => {
    const app = await startApp(gate("fail-closed", async () => [finding()]));

    try {
      const runId = await submit(app);
      const run = await waitForRun(app, runId);
      const types = run.events.map((event: { type: string }) => event.type);

      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("SECURITY_FAILED");
      expect(run.commitSha).toBeNull();
      expect(types).toContain("security.started");
      expect(types).toContain("security.failed");
      expect(types).not.toContain("git.commit");

      expect(run.security).toHaveLength(1);
      expect(run.security[0]).toMatchObject({
        scannerId: "fake-secret-scanner",
        status: "failed",
        severity: "high",
      });
      expect(run.security[0].error).toContain("secret");

      const artifact = run.artifacts.find(
        (entry: { kind: string }) => entry.kind === "security_scan"
      );

      expect(artifact?.data).toMatchObject({
        status: "failed",
        policy: "fail-closed",
        blocking: true,
      });
    } finally {
      await app.close();
    }
  });

  it("records findings but continues under warn-only", async () => {
    const app = await startApp(gate("warn-only", async () => [finding()]));

    try {
      const runId = await submit(app);
      const run = await waitForRun(app, runId);
      const types = run.events.map((event: { type: string }) => event.type);
      const securityEvent = run.events.find(
        (event: { type: string }) => event.type === "security.failed"
      );

      expect(run.status).toBe("completed");
      expect(run.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(types).toContain("git.commit");
      expect(securityEvent.message).toContain("warn-only");
      expect(run.security[0]).toMatchObject({
        scannerId: "fake-secret-scanner",
        status: "failed",
      });
      expect(run.output).toMatchObject({
        security: {
          status: "failed",
          policy: "warn-only",
          blocking: false,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("fails closed when the gate itself cannot run", async () => {
    const app = await startApp(
      gate("fail-closed", async () => {
        throw new Error("scanner crashed");
      })
    );

    try {
      const runId = await submit(app);
      const run = await waitForRun(app, runId);

      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("SECURITY_FAILED");
      expect(run.errorMessage).toContain("scanner crashed");
      expect(run.security[0]).toMatchObject({
        scannerId: "security-gate",
        status: "error",
      });
    } finally {
      await app.close();
    }
  });
});
