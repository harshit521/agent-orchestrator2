# TaskFleet

A browser-based multi-agent DevOps orchestrator.

TaskFleet lets a team submit coding or research tasks, queue them, and watch every run from a
live dashboard. Coding tasks execute in isolated Git worktrees; every step is persisted and
streamed over Server-Sent Events (SSE).

Project: Semester Group Project · B.Tech CS · KIET Group of Institutions

---

## What is actually implemented

### Dashboard

The React console has nine pages:

| Page | What it shows |
|---|---|
| Overview | Task/run counts, scheduler slots, active runs, persisted recent activity |
| Tasks | Filterable table, create/edit/delete, priority, assignment, run history |
| Task detail | Prompt, metadata, active/queued run banner, run history |
| Runs | All runs with status filters, queue position, scheduler strip, cancel actions |
| Run detail | Live SSE timeline, queued/running/failed/cancelled panels, security panel, workspace artifacts |
| Agents | Registered agents, provider/model, per-agent statistics |
| Agent detail | Capabilities, status, recent runs |
| Security | On-demand scanner availability and scan results (when enabled) |
| Integrations | Provider, GitHub, worktree, and security configuration status |

All displayed values come from the API and SQLite database. There is no mock data or simulated
progress.

---

## Getting started

Requirements: Node.js 20+ (22 recommended), npm 10+, Git.

```bash
npm install       # installs workspaces and generates the Prisma client
npm run db:push   # creates apps/api/data/taskfleet.db
npm run dev       # API with hot reload on http://127.0.0.1:3000
npm run dev:web   # dashboard on http://localhost:5173 (second terminal)
```

The Vite dev server proxies `/api` to `http://127.0.0.1:3000`. `VITE_API_URL` can override the
API origin, but the API does not emit CORS headers; use the Vite proxy or serve the production
build from the API.

Single-process demo (API serves the built dashboard):

```bash
npm run build
npm start         # http://127.0.0.1:3000
```

### Verification

```bash
npm run typecheck   # strict TypeScript for API and web
npm test            # API unit/HTTP/integration suite
npm run build       # API + production dashboard bundle
```

Last verified in this repository: `npm run typecheck` passes, `npm test` passes
**18 files / 75 tests**, and `npm run build` completes.

### Docker

```bash
docker compose up --build   # http://localhost:3000
```

The image builds the API and dashboard and runs `prisma db push` before starting. The Compose
service includes a `/health` healthcheck and persists SQLite data in a named volume.

**Docker limitation:** the authored image is a demo/research deployment. It does not include the
repository's `.git` directory and is not set up for Git-worktree coding jobs, so coding runs that
require worktrees must run on a host checkout. The image was reviewed statically but could not be
built or run in the validation environment because no Docker daemon was available.

---

## Configuration

Copy `.env.example` to `apps/api/.env` (loaded automatically) or export variables.

### Server and persistence

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | HTTP bind address (use `0.0.0.0` in Docker) |
| `DATABASE_URL` | `file:./data/taskfleet.db` | SQLite location; relative paths resolve against `apps/api` |

### LLM

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `stub` | `stub`, `openai`, or `anthropic` |
| `LLM_API_KEY` | — | Required for live providers |
| `LLM_MODEL` | provider default | Model override |
| `LLM_BASE_URL` | — | OpenAI-compatible gateway URL |
| `LLM_MAX_TOKENS` / `LLM_TIMEOUT_MS` | `1024` / `60000` | Provider limits |

The offline `stub` provider cannot call tools, so it cannot drive the coding agent. Research runs
work with the stub.

### GitHub (optional)

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` + `GITHUB_REPOSITORY` | Push branches and open pull requests |
| `GITHUB_WEBHOOK_SECRET` | Enables HMAC-verified `/webhooks/github` |
| `GITHUB_BASE_BRANCH` | PR target branch (default `main`) |
| `GITHUB_REMOTE_URL` | Optional push remote override |

Webhooks map PR and CI signals to task status. They do **not** automatically re-run an agent.

### Worktrees and coding agent

| Variable | Default | Purpose |
|---|---|---|
| `WORKTREES_ENABLED` | `true` | Enable Git worktree isolation |
| `WORKTREES_ROOT` | `.taskfleet/worktrees` | Worktree directory |
| `WORKTREE_KEEP_ON_SUCCESS` / `WORKTREE_KEEP_ON_FAILURE` | `true` | Retention policy |
| `AGENT_MAX_STEPS` / `AGENT_MAX_TOKENS` / `AGENT_MAX_TOOL_CALLS` | `20` / `100000` / `80` | Agent limits |
| `AGENT_COMMAND_TIMEOUT_MS` / `AGENT_TEST_TIMEOUT_MS` | `120000` / `180000` | Command and test timeouts |
| `AGENT_RUN_TESTS` / `AGENT_REQUIRE_CHANGES` | `true` | Verification policy |
| `AGENT_TEST_COMMAND` | auto-detect | Override test command |
| `AGENT_COMMAND_ALLOWLIST` | npm, npx, node, … | Comma-separated executables (no shell) |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | TaskFleet Agent | Commit identity |

### Scheduler

| Variable | Default | Purpose |
|---|---|---|
| `MAX_CONCURRENT_RUNS` | `3` | Maximum simultaneously executing runs |

### Security gate

| Variable | Default | Purpose |
|---|---|---|
| `SECURITY_ENABLED` | `false` | Enables the manual scan route and the per-run gate |
| `SECURITY_POLICY` | `fail-closed` | `fail-closed` or `warn-only` |
| `SECURITY_SCANNERS` | all | Comma-separated: `gitleaks,semgrep,trivy` |
| `SECURITY_SCAN_TIMEOUT_MS` | `120000` | Per-scanner timeout |

Scanners are external binaries. If one is missing, its result is `unavailable` and the gate does
not block on it.

---

## API

All routes are available at the root and under `/api` (the dashboard uses `/api`).

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/integrations` | Provider, GitHub, worktree, security status |
| GET | `/stats` | Task/run counts, scheduler state, active runs, activity |
| GET | `/activity?limit=` | Recent persisted activity |
| GET | `/agents` | Registered agents with statistics |
| GET | `/agents/:agentId` | One agent and recent runs |
| GET | `/worktrees` | Worktree list when enabled |
| POST | `/tasks` | Create a task. `start: true` → `202` + run; `start: false` → `201`, `run: null` |
| GET | `/tasks` / `/tasks/:taskId` | List or fetch tasks with runs and events |
| PATCH | `/tasks/:taskId` | Update title, prompt, priority, status, or agent |
| DELETE | `/tasks/:taskId` | Delete a task and cascade its runs |
| POST | `/tasks/:taskId/run` | Dispatch a queued task → `202` |
| GET | `/runs?limit=&status=&agentId=&taskId=` | List runs with queue positions |
| GET | `/runs/:runId` | Run detail with events, artifacts, security results, task prompt |
| GET | `/runs/:runId/events` | SSE: replay then live events |
| POST | `/runs/:runId/cancel` | Cancel a queued or running run (`409` when finished) |
| POST | `/research` | Synchronous research compatibility endpoint |
| GET | `/security/tools` | Scanner availability (when enabled) |
| POST | `/security/scan` | On-demand scan (when enabled, else `503`) |
| POST | `/webhooks/github` | HMAC-verified GitHub webhook |

SSE event types:

```
run.queued  run.started  workspace.created  workspace.removed
agent.started  agent.edit  run.progress  agent.progress
test.started  test.completed
security.started  security.completed  security.failed
git.commit  git.push  github.pr.opened  github.pr.skipped
agent.completed  agent.failed
run.completed  run.failed  run.cancelled
```

Example:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"Explain git worktrees","agentId":"research-agent","priority":"high"}'

curl -N http://127.0.0.1:3000/api/runs/<runId>/events
```

---

## Project structure

```text
agent-orchestrator/
├── apps/
│   ├── api/
│   │   ├── prisma/schema.prisma        # Task, Run, RunEvent, RunArtifact, RunSecurity
│   │   ├── src/
│   │   │   ├── agents/                 # Agent contract, registry, research + coding agents
│   │   │   ├── db/                     # Prisma client factory
│   │   │   ├── github/                 # PR client + webhook verification
│   │   │   ├── http/                   # Fastify routes, schemas, security routes
│   │   │   ├── llm/                    # OpenAI / Anthropic / stub adapters
│   │   │   ├── runs/                   # RunService, RunStore, event bus, DTOs, test runner
│   │   │   ├── scheduler/              # DB-backed scheduler
│   │   │   ├── security/               # Scanner runner + run security gate
│   │   │   ├── worktrees/              # Worktree service + path jail
│   │   │   ├── app.ts / config.ts / server.ts
│   │   └── test/                       # 18 Vitest files
│   └── web/
│       ├── src/
│       │   ├── components/             # layout, runs, tasks, shared, UI primitives
│       │   ├── hooks/                  # useQuery, useRunStream
│       │   ├── pages/                  # overview, tasks, runs, agents, security, integrations
│       │   ├── api.ts / types.ts       # typed API client and DTOs
│       │   └── index.css               # design tokens and themes
│       └── vite.config.ts
├── docs/implementation/                # M1.md, M2.md, M3.md
├── .github/workflows/ci.yml
├── Dockerfile / docker-compose.yml
├── .env.example
└── README.md
```

---

## Testing

```bash
npm test                         # all API tests
npm run test:watch               # watch mode
npx vitest run test/scheduler.test.ts   # one file (from apps/api)
```

Coverage includes:

- Task CRUD, validation, missing resources, and dashboard endpoints.
- Scheduler concurrency, priority/FIFO ordering, queue positions, queued cancellation.
- Running-run cancellation and child-process abort.
- Startup recovery of orphaned runs and queued-run draining.
- Security gate fail-closed, warn-only, and gate-error behavior.
- Worker failure paths (agent crash, missing workspace) and generic database error responses.
- Coding lifecycle against a real temporary Git worktree, including tests, commit, push, PR.
- SSE replay/dedupe and terminal close.
- GitHub webhook signature verification and status mapping.
- Path-jail, scanner runner, LLM tool calling, and registry behavior.

Several suites create real Git worktrees in the same repository, so test files run sequentially
(`fileParallelism: false`) to avoid Git lock contention.

---

## Known limitations

- **No authentication.** Every route is unauthenticated. Deploy behind an authenticated reverse
  proxy or private network; do not expose it directly to the internet.
- **Agent isolation is filesystem/Git-level, not a container sandbox.** The Docker image runs the
  API and dashboard, not one container per worker.
- **Docker image is not verified here.** No Docker daemon was available. The image also lacks the
  repository `.git` and `git` binary, so coding/worktree runs need a host checkout.
- **Live coding needs an LLM key.** The default `stub` provider cannot call tools. All automated
  lifecycle tests use scripted agents; a live OpenAI/Anthropic run was not performed here.
- **GitHub PRs need credentials.** Webhooks need a public URL and secret. No live GitHub delivery
  was exercised here.
- **Security scanners are external.** Gitleaks/Semgrep/Trivy must be installed. If absent, results
  are reported as `unavailable` and do not block. The gate itself is covered by tests with
  injected scanner results.
- **Webhooks do not auto-fix CI.** They update task status; the automatic CI → agent → fix loop is
  not implemented.
- **No GitHub OAuth, per-task Docker workers, task decomposition, or analytics.** These remain
  future scope.
- SQLite is the only configured datasource. The Prisma schema is portable, but PostgreSQL has not
  been exercised.

---

## Roadmap / future scope

- Authentication and per-user authorization.
- Container-per-worker isolation.
- Automated CI/review feedback loop that re-invokes an agent.
- PostgreSQL and migration-based deployments.
- Richer scheduling (fairness, per-agent limits) and analytics.
- Additional agent providers and Git hosts.

These are potential extensions, not completed features.

---

TaskFleet is conceptually inspired by Agent Orchestrator (AO) and adapts the multi-agent coding
orchestration concept into a browser-based, team-oriented platform.
