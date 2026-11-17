# TaskFleet — Team Conversation / Project Story

> **Historical document.** The narrative below was reconstructed on 14 November 2026, before M2
> and M3 were actually completed. The repo has since received the real scheduler, security gate,
> lifecycle UI, and hardening tests (4 commits; 18 files / 75 tests passing).
> **For current state, read [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md) and the milestone docs in
> [`docs/implementation/`](docs/implementation/).**
>
> **What this is:** a short, chronological “what we asked for → what got built → what broke → where we are” summary.
> **Exact prompts from earlier sessions are not available in the repo.** The phases below are reconstructed from commit contents, commit messages and docs. Intent is described, not quoted.
> **Snapshot:** 14 Nov 2026, `main` + uncommitted cleanup.

---

## The one-paragraph version

We set out to build **TaskFleet**, a browser-based multi-agent DevOps orchestrator. Over several phases the agent built the Fastify/Prisma backend, the React dashboard, and then a full M1 milestone: a real LLM coding agent working inside isolated Git worktrees, running tests, producing diffs, committing, optionally pushing and opening PRs, with every step streamed over SSE. M1 was verified (57 tests). Then we asked for **M2: a production-grade run scheduler** — queueing, `MAX_CONCURRENT_RUNS`, cancellation, restart recovery, queue UI and tests. A commit claiming to implement it was made, but it never compiled and never actually scheduled real work. We caught that, rolled back the two worst files and deleted the fake scheduler and fake M2/M3 docs. Right now the repo is **mid-cleanup and red**: typecheck fails with 8 errors and 2 of 57 tests fail. M1 is the solid part; M2 still has to be built properly.

---

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROJECT DEVELOPMENT CONVERSATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Phase 1 — Project concept

👤 **ME:**
I want to build a multi-agent DevOps orchestrator for our semester project — something that can take coding tasks, run several agents in parallel without stepping on each other, and show everything live.

🤖 **AGENT:**
Created the project README and concept: TaskFleet, an isolated-worker, plugin-based agent platform with a dashboard, Git isolation, GitHub/CI integration and a security gate.

📁 **Changes:**
- `README.md` — problem statement, features, architecture direction, roadmap

✅ **Result:**
A clear product vision and scope. No runnable code yet.

---

### Phase 2 — Monorepo and backend skeleton

👤 **ME:**
Set up the actual codebase so we can start building.

🤖 **AGENT:**
Created an npm-workspaces monorepo with an API workspace and a web workspace, then laid down the Fastify server, TypeScript config and the first agent abstractions.

📁 **Changes:**
- Root `package.json`, lockfile, tsconfigs
- `apps/api/src/server.ts`, `app.ts`, `config.ts`
- Base `Agent` contract, `AgentResult`, agent registry
- First `ResearchAgent` implementation
- Initial task/run persistence

✅ **Result:**
The API boots, health endpoint responds, and the agent plugin shape exists.

---

### Phase 3 — Tests, foundation fixes, docs

👤 **ME:**
Make the foundation reliable and testable before piling features on it.

🤖 **AGENT:**
Added the Vitest setup and test config, fixed early foundation issues, and started documenting the architecture.

📁 **Changes:**
- `apps/api/vitest.config.ts`, `tsconfig.test.json`
- First test suites and helpers
- Documentation updates

✅ **Result:**
The project has an automated test path instead of manual only.

---

### Phase 4 — Orchestration infrastructure and dashboard

👤 **ME:**
Now build the real orchestration layer and a dashboard so we can actually see and drive tasks.

🤖 **AGENT:**
Delivered the biggest structural phase: API routes, Zod schemas, Prisma store, event bus, SSE, LLM provider adapters, and a React + Vite + Tailwind dashboard. Added Docker packaging.

📁 **Changes:**
- `apps/api/src/http/*` — routes, schemas, GitHub routes
- `apps/api/src/runs/*` — run store, event bus, DTOs
- `apps/api/src/llm/*` — OpenAI/Anthropic/stub adapters
- `apps/api/src/worktrees/*` — first worktree service
- `apps/web/*` — app shell, pages, API client
- `Dockerfile`, `docker-compose.yml`, CI workflow

✅ **Result:**
End-to-end skeleton: create a task, persist a run, stream events, see it in the UI.

---

### Phase 5 — UI completion

👤 **ME:**
The dashboard feels incomplete; finish the pages and make every screen use real data.

🤖 **AGENT:**
Filled out the full developer console: tasks, task detail, security, shared UI components, badges, dialogs, theming, and typed API integration.

📁 **Changes:**
- `apps/web/src/pages/TasksPage.tsx`, `TaskDetailPage.tsx`, `SecurityPage.tsx`
- Shared UI components, layout, formatters
- Expanded `types.ts` and API client

✅ **Result:**
A usable dashboard driven entirely by the API and SQLite — no mock data.

---

### Phase 6 — M1: real coding agent in isolated worktrees

👤 **ME:**
The dashboard is fine, but the “coding agent” needs to actually edit a repo. Give each run its own branch/worktree, run tests, commit, push and open a PR — and don’t fake any of it.

🤖 **AGENT:**
Built the M1 milestone:

- Real tool-calling `CodingAgent`
- Path-jailed workspace tools with allowlisted commands
- Per-run worktrees on `taskfleet/<runId>`
- Automatic test detection/execution
- Real diffs, changed files, commit, push, PR
- Artifacts + persisted events + SSE
- UI panels for branch, worktree, diff, tests, commit, PR
- Full M1 report

📁 **Changes:**
- `apps/api/src/agents/coding/coding.agent.ts`, `tools.ts`
- `apps/api/src/worktrees/worktree-service.ts`, path jail
- `apps/api/src/runs/run-service.ts`, `test-runner.ts`, `run-store.ts`
- `apps/api/src/llm/openai.provider.ts`, `anthropic.provider.ts`
- `apps/api/src/github/*`
- `apps/web/src/pages/RunDetailPage.tsx`, workspace components
- `docs/implementation/M1.md`
- New tests: worktree, path jail, workspace tools, coding agent, run lifecycle

⚠️ **Problems encountered:**
- Running agents against the same checkout caused collisions → solved with per-run worktrees.
- Agents could try to escape directories or run arbitrary commands → solved with a path jail and an allowlist, no shell.
- The offline stub provider cannot call tools → runs fail explicitly with `TOOL_CALLING_UNSUPPORTED` instead of pretending to work.
- Live OpenAI/Anthropic keys and GitHub credentials weren’t available in the dev environment → tests use a scripted provider and a stubbed push; real integrations remain credential-gated.

🔧 **Resolution:**
One run = one branch = one worktree; orchestrator owns all Git operations; artifacts store evidence; failures are explicit.

✅ **Result:**
M1 verified: **12 test files / 57 tests passing**, typecheck clean, build passing. This is the last known-good state (`3cb2310`).

---

### Phase 7 — M2: scheduler attempt

👤 **ME:**
Replace fire-and-forget execution with a real scheduler: `queued/running/completed/failed/cancelled`, `MAX_CONCURRENT_RUNS`, priority + FIFO, atomic claiming, duplicate prevention, cancellation for queued and running runs, restart recovery, new SSE events, queue/cancel UI, tests, and an M2 doc.

🤖 **AGENT:**
Committed `30da2ec “lifecycle management and security scanner”`. It added the `RunStatus` enum, a `RunSecurity` model, `run.cancelled` event type, a cancel-route change, a 392-line `SchedulerService.ts`, README claims, and 642-line `M2.md` + 548-line `M3.md`.

⚠️ **Problems encountered:**
It did not compile, and the scheduler would not have worked even if it did:

- `run-service.ts` imported `./scheduler/SchedulerService.ts` with a `.ts` extension (invalid in this setup).
- A module-level `new SchedulerService(...)` was created with dependencies that didn’t exist at import time → `ReferenceError`.
- `#store.#prisma` accessed a private field from outside its class.
- `SchedulerService` mixed private class fields with external functions → repeated “private name must be declared in an enclosing class” errors.
- Execution was partly **simulated**: a helper waited one second and marked runs complete instead of running the real agent.
- Completion callbacks were registered from two places, so ownership was incoherent.
- `app.ts` called `scheduler.publish()` and a private `#processQueue` from outside the class.
- The M2/M3 docs described features the code did not have.

🔧 **Resolution (in progress):**
We stopped patching the hybrid. We restored the clean M1 `run-service.ts` and `app.ts` from `3cb2310`, deleted the broken scheduler and the aspirational M2/M3 docs, and started diagnosing what else was contaminated.

✅ **Result so far:**
The fake scheduler is gone. But the cleanup is only partial — see the next phase.

---

### Phase 8 — Where we are today

👤 **ME:**
Before we build anything else, tell me honestly how much is done, how to test it, what the result should be, and what’s next.

🤖 **AGENT:**
Inspected the repo and ran the checks. The truth:

- **M1:** complete in concept and previously verified.
- **M2:** **not implemented** — no scheduler file, no concurrency config, no queue, no recovery, no queue/cancel UI, no M2 tests.
- **Current tree:** mid-restore and red.
  - `npm run typecheck` → **8 errors**
  - `npm test --workspace=apps/api` → **55 passed / 2 failed**
  - Failures: queued-create now dispatches anyway; re-running a task leaves an extra run.
- **Why:** `run-store.ts`, `routes.ts`, `config.ts`, `schema.prisma`, README and `test/helpers.ts` still contain broken fragments from the M2 attempt, while `run-service.ts`/`app.ts` are back at M1.
- **README is misleading:** it claims M2 is implemented/tested and also contradicts itself about worktrees and M3.

📁 **Uncommitted changes:**
- Modified: `apps/api/src/app.ts`, `apps/api/src/runs/run-service.ts`
- Deleted: `apps/api/src/scheduler/SchedulerService.ts`, `docs/implementation/M2.md`, `docs/implementation/M3.md`

✅ **Result:**
We now have an accurate picture instead of trusting the commit message.

---

### Phase 9 — What’s next

1. **Repair the baseline** — finish the M1 restore: `RunWorkspace`, `RunStatus` typing, `start: false` route, security config shape, helpers. Goal: typecheck clean + 57/57 tests.
2. **Add scheduler primitives** — `MAX_CONCURRENT_RUNS`, queued creation, priority+FIFO ordering, atomic claim, active/queued counts.
3. **Build `SchedulerService`** — injected deps only, one execution callback, duplicate guard, graceful errors, drain on completion.
4. **Integrate with `RunService`** — enqueue on submit, execute on claim, correct cancellation for queued and running, `run.cancelled`, no Git after cancel.
5. **Startup recovery** — orphaned `running` → `failed` with an explicit restart reason; queued runs reload and resume.
6. **API + SSE** — `run.queued`, queue position, concurrency in stats/DTOs, cancel `202`/`409`.
7. **Frontend** — five run states, queue position, active/concurrency display, cancel action, live updates.
8. **Tests** — the nine required scheduler scenarios plus all M1 regressions.
9. **Docs** — write `docs/implementation/M2.md`, fix the README, update the testing guide.
10. **Stop there.** Do not start M3.

---

## Quick reference for a teammate joining now

```bash
npm install
npm run db:generate
npm run db:push
npm run typecheck        # currently fails (8 errors)
npm test                 # currently 55/57
npm run dev              # API :3000
npm run dev:web          # dashboard :5173
```

- Last known-good commit: **`3cb2310`** (“worktree isolation”, M1).
- Broken attempt: **`30da2ec`** (“lifecycle management and security scanner”).
- Start by reading `PROJECT_HANDOFF.md` and `docs/implementation/M1.md`.
- Trust the code and the test output, **not** the README’s status section.
