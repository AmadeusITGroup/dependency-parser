import { performance } from "node:perf_hooks";

import { ScanProjectDependencies } from "../application/use-cases/ScanProjectDependencies";
import { Logger, logger } from "../utils/logger";

export class ScanScheduler {
  private timer?: NodeJS.Timeout;
  private activeTagRefresh?: Promise<void>;
  private activeTreeBuild?: Promise<void>;
  private stopped = true;

  constructor(
    private readonly scanProjectDependencies: ScanProjectDependencies,
    private readonly intervalMs: number,
    private readonly log: Logger = logger
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => this.scheduleScan(), this.intervalMs);
    this.timer.unref();
    this.scheduleScan();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await Promise.all([this.activeTagRefresh, this.activeTreeBuild]);
  }

  private scheduleScan(): void {
    if (this.stopped) {
      return;
    }

    if (this.activeTagRefresh) {
      this.log.debug("Tag refresh skipped: previous tag refresh is still running.");
      return;
    }

    this.activeTagRefresh = this.runPhase("tags").then(() => undefined).finally(() => {
      this.activeTagRefresh = undefined;
    });
  }

  private async runPhase(phase: "tags" | "trees"): Promise<boolean> {
    const startedAt = performance.now();
    const jobStarts = new Map<string, number>();
    const reportedFailures = new Set<string>();
    const activity = phase === "tags" ? "Dependency tag refresh" : "Dependency tree processing";
    try {
      this.log.debug(`${activity} started.`);
      const result = phase === "tags"
        ? await this.scanProjectDependencies.refreshTags(() => this.stopped)
        : await this.scanProjectDependencies.buildDependencyTrees(() => this.stopped, event => {
          const key = JSON.stringify([event.projectId, event.version, event.commitHash]);
          if (event.event === "started") {
            jobStarts.set(key, performance.now());
          }
          const jobStartedAt = jobStarts.get(key);
          this.log.debug({
            phase: "trees",
            ...event,
            durationMs: event.event === "started" || jobStartedAt === undefined
              ? undefined
              : Math.round(performance.now() - jobStartedAt),
          }, `Dependency tree job ${event.event}.`);
          if (event.event === "failed") {
            reportedFailures.add(JSON.stringify([event.projectId, event.version]));
            this.log.error({
              phase: "trees",
              projectId: event.projectId,
              version: event.version,
              creationDate: event.creationDate,
              commitHash: event.commitHash,
              err: event.error,
              activeTreeCount: event.activeTreeCount,
              pendingTreeCount: event.pendingTreeCount,
              attempt: event.attempt,
              maximumAttempts: event.maximumAttempts,
              retryExhausted: event.retryExhausted,
              durationMs: jobStartedAt === undefined ? undefined : Math.round(performance.now() - jobStartedAt),
            }, "Dependency tree job failed.");
          }
          if (event.event !== "started") {
            jobStarts.delete(key);
          }
        });
      for (const failure of result.failures) {
        if (phase === "trees" && reportedFailures.has(JSON.stringify([failure.projectId, failure.version]))) {
          continue;
        }
        this.log.error({
          phase,
          projectId: failure.projectId,
          version: failure.version,
          err: failure.error,
        }, `${activity} failed for project.`);
      }

      this.log.info({
        phase,
        status: this.stopped ? "stopped" : "completed",
        durationMs: Math.round(performance.now() - startedAt),
        projectCount: result.projectCount,
        tagCount: result.tagCount,
        resolvedTreeCount: result.resolvedTreeCount,
        failureCount: result.failures.length,
        pendingTreeCount: this.scanProjectDependencies.pendingTreeCount,
        activeTreeCount: this.scanProjectDependencies.activeTreeCount,
        maximumConcurrency: this.scanProjectDependencies.maximumConcurrency,
      }, `${activity} finished.`);

      if (phase === "tags") {
        this.startTreeBuild();
      }
      return true;
    } catch (error: unknown) {
      this.log.error({
        phase,
        err: error,
        durationMs: Math.round(performance.now() - startedAt),
      }, `${activity} failed.`);
      return false;
    }
  }

  private startTreeBuild(): void {
    if (this.stopped || this.activeTreeBuild || this.scanProjectDependencies.pendingTreeCount === 0) {
      return;
    }
    let completed = false;
    this.activeTreeBuild = this.runPhase("trees").then(success => {
      completed = success;
    }).finally(() => {
      this.activeTreeBuild = undefined;
      if (completed) {
        this.startTreeBuild();
      }
    });
  }
}