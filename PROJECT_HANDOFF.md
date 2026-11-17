# TaskFleet — Project Handoff

> **Snapshot date:** 17 November 2026
> **Repository:** `agent-orchestrator` (product name: **TaskFleet**)
> **Branch:** `main`
> **Status:** M1, M2, and M3 implemented; Commit 4 hardening complete.

---

## 0. TL;DR

- M1 (real coding agent + Git worktrees), M2 (DB-backed scheduler and lifecycle), and M3
  (security gate, persisted results, SSE + lifecycle UI) are implemented and tested.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
- **Tests: 18 files / 75 tests passing.**
- Docker image and Compose file are updated, but **could not be built or run** because no Docker
  daemon was available in this environment.
- There is **no authentication**. Do not expose the API directly.
- Live OpenAI/Anthropic coding runs and live GitHub delivery were not exercised here; automated
  lifecycle tests use scripted agents.

---

## 1. Commits

The delivery is intentionally exactly four commits:

| Commit | Message | Scope |
|---|---|---|
| 1 | `fix: restore backend foundation and runtime` | Restored compilable M1 baseline: store types/exports, security config parsing, `start:false` contract, run-status query schema, test helpers; removed broken scheduler/doc files |
| 2 | `feat: complete task and run lifecycle` | DB-backed scheduler, queued creation, priority/FIFO claims, concurrency, cancellation, restart recovery, queue positions, `run.queued`/`run.cancelled` |
| 3 | `feat: integrate security events and run lifecycle UI` | Security gate, `RunSecurity` persistence, `security.*` events, run `security[]` DTO, queue/cancel/security UI, full SSE subscriptions |
| 4 | `test: harden and finalize project` | Recovery/API/failure/scheduler-error tests, Docker/compose fixes, accurate README and M2/M3 docs, final validation |

---

## 2. What is implemented

### Backend

- Fastify 5 API, native ESM, strict TypeScript, Zod validation.
- Prisma 7 + SQLite persistence: `Task`, `Run`, `RunEvent`, `RunArtifact`, `RunSecurity`.
- Agent contract + registry; `ResearchAgent`; real tool-calling `CodingAgent`.
- OpenAI-compatible, Anthropic, and offline `stub` LLM providers.
- Per-run Git worktree (`taskfleet/<runId>`), path-jailed file tools, allowlisted commands,
  automatic tests, diff, commit, optional push and PR.
- DB-authoritative scheduler:
  - priority (`urgent` → `high` → `medium` → `low`) then FIFO;
  - atomic claim with conditional `updateMany`;
  - `MAX_CONCURRENT_RUNS`;
  - queue positions;
  - queued cancellation and running abort;
  - startup recovery (`INTERRUPTED_BY_RESTART`).
- Security gate before commit:
  - `fail-closed` blocks on `failed`/`error`;
  - `warn-only` persists and continues;
  - `unavailable` scanners do not block;
  - one `RunSecurity` row per scanner plus a `security_scan` artifact.
- SSE per run with replay, dedupe, heartbeat, and terminal close.
- GitHub webhook signature verification and status mapping; PR client.
- Manual scanner endpoints (`GET /security/tools`, `POST /security/scan`).

### Frontend

React 19 + Vite + Tailwind dashboard with:

- Overview, Tasks, Task detail, Runs, Run detail, Agents, Agent detail, Security, Integrations;
- real SSE consumption, queue position, scheduler/concurrency strip;
- all five run states (queued, running, completed, failed, cancelled);
- cancel actions, cancellation panel, security panel;
- typed API client and stored query cache.

---

## 3. Verified commands

Run from the repository root:

```bash
npm run typecheck
npm test
npm run build
```

Latest results:

- `npm run typecheck` — **PASS** (API + web)
- `npm test` — **18 files / 75 tests PASS**
- `npm run build` — **PASS** (API `tsc`, Vite dashboard bundle)
- `npm run db:generate` — **PASS**
- `npm run db:push` — **PASS**
- Backend smoke test — health `200`, task creation → completed run, SSE replay, `/stats`
  scheduler block, security scan `503` when disabled, `404`/`400` contracts.

Manual API flow verified with the built server:

```bash
cd apps/api
DATABASE_URL=file:/absolute/path/test.db npx prisma db push
node dist/server.js
```

---

## 4. Test suite

`apps/api/test/` contains 18 files:

- `tasks.crud.test.ts` — CRUD, validation, stats, activity, agent stats, cascade delete
- `api-contracts.test.ts` — schema rejection, query validation, missing resources, queued start
- `run-lifecycle.test.ts` — real worktree coding run, tests, commit/push/PR, SSE, cancellation
- `scheduler.test.ts` — concurrency, queue drain, queued cancellation
- `scheduler-errors.test.ts` — execution rejection, claim errors, recovery
- `recovery.test.ts` — orphaned running runs, queued-run draining after restart
- `security-gate.test.ts` — fail-closed, warn-only, gate error
- `security.test.ts` — scanner statuses, availability, root enforcement
- `failure-paths.test.ts` — agent crash, missing workspace, generic DB error response
- `coding-agent.test.ts` — tool calling, allowlist, provider limitations, cancellation
- `workspace-tools.test.ts`, `path-jail.test.ts`, `worktree.test.ts` — isolation and tools
- `github.test.ts` — signature, webhook mapping, PR client, invalid signature `401`
- `sse.test.ts` — replay/dedupe/terminal close
- `research.agent.test.ts`, `research.route.test.ts`, `registry.test.ts`

Test files run sequentially (`fileParallelism: false`) because several suites create real Git
worktrees in the same repository.

---

## 5. Important behaviours and contracts

- `POST /tasks`:
  - `start: true` (default) → `202` with task + queued run;
  - `start: false` → `201` with `run: null` and no runs.
- `POST /tasks/:taskId/run` → `202` with a queued run; `404` for unknown task/agent.
- `GET /runs` and `GET /runs/:runId` include `queuePosition` for queued runs.
- `POST /runs/:runId/cancel` → `202`; `404` unknown; `409` terminal.
- `GET /stats` includes `scheduler: { activeRuns, queuedRuns, maxConcurrentRuns }`.
- Run detail includes `events[]`, `artifacts[]`, and `security[]`.
- Cancelled queued runs never invoke the agent.
- Cancelled running runs skip commit/push and end `cancelled`; the task ends `failed`.
- Startup recovery marks orphaned `running` runs `failed` with `INTERRUPTED_BY_RESTART`.
- Security `unavailable` is non-blocking under both policies.
- Errors return `{ success: false, error }`; 5xx responses use a generic message and do not leak
  internals.

---

## 6. Current limitations / blockers

1. **No authentication or authorization.** Put the service behind an authenticated proxy or keep
   it on a private network.
2. **Docker not verified.** `Dockerfile` and `docker-compose.yml` were updated (Prisma schema
   available before `npm ci`, generated client ignored, healthcheck, env vars), but the daemon was
   down. The image also lacks the repository `.git` and is not configured for worktree coding runs,
   so those need a host checkout.
3. **No live LLM coding run.** Automated tests use scripted agents. `stub` cannot call tools.
   Live OpenAI/Anthropic behavior needs a key and a manual run.
4. **No live GitHub delivery.** Webhooks and PR creation are unit/integration tested; no real
   webhook or PR was created here.
5. **No live scanner binaries verified in final validation.** The gate is tested with injected
   scanner results; missing binaries are reported as `unavailable`.
6. **Multi-process concurrency.** Atomic claims prevent duplicate execution, but in-process slot
   accounting means each API process enforces its own `MAX_CONCURRENT_RUNS`.
7. **Not implemented:** container-per-worker isolation, GitHub OAuth, automatic CI → agent fix
   loop, task decomposition, analytics, PostgreSQL migration validation.

---

## 7. Next steps if continuing

1. Add authentication and per-user authorization (or document the required proxy).
2. Run one live coding task with an OpenAI/Anthropic key on a real checkout.
3. Install Gitleaks/Semgrep/Trivy and verify a real fail-closed and warn-only run.
4. Build and run the Docker image on a machine with a daemon; decide whether to ship a coding
   image that includes the repository and `git`.
5. Exercise a live GitHub webhook and PR against a test repository.
6. If multi-process deployment is required, move slot accounting into the database or add a
   distributed lease.

---

## 8. Useful files

| File | Why |
|---|---|
| `apps/api/src/runs/run-service.ts` | Lifecycle, execution, cancellation, recovery, security gate |
| `apps/api/src/scheduler/SchedulerService.ts` | Drain loop, concurrency, error handling |
| `apps/api/src/runs/run-store.ts` | Queue ordering, atomic claims, persistence, stats |
| `apps/api/src/security/gate.ts` | Gate construction and policy |
| `apps/api/src/security/scanner.ts` | Scanner definitions and runner |
| `apps/api/src/http/routes.ts` | Task/run APIs, cancel, queue positions, SSE, DTOs |
| `apps/api/prisma/schema.prisma` | Persistence model |
| `apps/web/src/pages/RunDetailPage.tsx` | Live timeline, cancel, security, state panels |
| `apps/web/src/pages/RunsPage.tsx` | Filters, scheduler strip, queue position, cancel |
| `apps/web/src/components/runs/SecurityPanel.tsx` | Persisted security results |
| `docs/implementation/M1.md` | Coding agent and worktrees |
| `docs/implementation/M2.md` | Scheduler and lifecycle |
| `docs/implementation/M3.md` | Security gate, events, UI |

---

## 9. Note on `PROJECT_CONVERSATION.md`

That file is a historical narrative reconstructed on 14 November 2026, before M2/M3 were actually
completed. Its opening banner now marks it as historical. Use this handoff and the milestone docs
for current state.
