import type { AppConfig } from "../config.js";
import type { LoggerLike } from "../runs/run-service.js";
import type { RunStore } from "../runs/run-store.js";

export interface SchedulerDeps {
  store: RunStore;
  config: AppConfig;
  logger: LoggerLike;
  /** Executes one already-claimed run. Must settle after the run is terminal. */
  execute: (runId: string) => Promise<void>;
}

export interface SchedulerState {
  activeRuns: number;
  queuedRuns: number;
  maxConcurrentRuns: number;
}

/**
 * In-process run scheduler backed by the database.
 *
 * The database is the source of truth for the queue: candidates are selected
 * by priority then FIFO, and claimed with a conditional update so a run can
 * never be executed twice. This service only owns slot accounting and drain
 * orchestration, which keeps it restart-safe.
 */
export class SchedulerService {
  readonly #store: RunStore;
  readonly #logger: LoggerLike;
  readonly #execute: (runId: string) => Promise<void>;
  readonly #maxConcurrent: number;
  readonly #active = new Set<string>();
  #draining = false;
  #drainRequested = false;
  #shutdown = false;

  constructor(deps: SchedulerDeps) {
    this.#store = deps.store;
    this.#logger = deps.logger;
    this.#execute = deps.execute;
    this.#maxConcurrent = deps.config.scheduler.maxConcurrentRuns;
  }

  get maxConcurrentRuns(): number {
    return this.#maxConcurrent;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** Requests a drain; safe to call from submissions and completions. */
  drain(): void {
    if (this.#shutdown) {
      return;
    }

    this.#drainRequested = true;

    if (this.#draining) {
      return;
    }

    void this.#runDrain();
  }

  /** Hint that a newly queued run exists. The DB queue remains authoritative. */
  enqueue(_runId: string): void {
    this.drain();
  }

  /**
   * The queue lives in the database, so a queued cancellation is enforced by
   * the conditional claim. This hook exists for lifecycle symmetry and must
   * never release an active slot.
   */
  remove(_runId: string): boolean {
    return true;
  }

  async getState(): Promise<SchedulerState> {
    return {
      activeRuns: this.#active.size,
      queuedRuns: await this.#store.countRunsByStatus("queued"),
      maxConcurrentRuns: this.#maxConcurrent,
    };
  }

  /** 1-based position in the current priority/FIFO queue, or null. */
  async queuePosition(runId: string): Promise<number | null> {
    const queued = await this.#store.listQueuedRuns();
    const index = queued.findIndex((run) => run.id === runId);

    return index === -1 ? null : index + 1;
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    this.#drainRequested = false;
  }

  async #runDrain(): Promise<void> {
    this.#draining = true;

    try {
      while (this.#drainRequested && !this.#shutdown) {
        this.#drainRequested = false;
        await this.#fillSlots();
      }
    } catch (error: unknown) {
      this.#logger.error({ err: error }, "Scheduler drain failed");
    } finally {
      this.#draining = false;

      // A completion may have arrived while the final fill was running.
      if (this.#drainRequested && !this.#shutdown) {
        this.drain();
      }
    }
  }

  async #fillSlots(): Promise<void> {
    while (!this.#shutdown && this.#active.size < this.#maxConcurrent) {
      const run = await this.#store.claimNextQueuedRun();

      if (!run) {
        return;
      }

      this.#start(run.id);
    }
  }

  #start(runId: string): void {
    this.#active.add(runId);

    void this.#execute(runId)
      .catch(async (error: unknown) => {
        this.#logger.error({ err: error, runId }, "Scheduled run failed");

        try {
          const run = await this.#store.getRun(runId);

          if (run?.status === "running") {
            await this.#store.markRunFailed(
              runId,
              "SCHEDULER_ERROR",
              error instanceof Error ? error.message : "Scheduler execution failed."
            );
          }
        } catch (markError: unknown) {
          this.#logger.error(
            { err: markError, runId },
            "Failed to persist scheduler error"
          );
        }
      })
      .finally(() => {
        this.#active.delete(runId);
        this.drain();
      });
  }
}
