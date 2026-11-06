import { DEFAULT_NPM_RANGE_RESOLUTION_TTL_MS } from "../../config/app.config";
import { IDependencyResolver } from "../../domain/interfaces/IDependencyResolver";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { IVersionLocator } from "../../domain/interfaces/IVersionLocator";
import { findProject, Project } from "../../domain/models/Project";
import { getVersionResolutionExpiry } from "../../domain/models/DependencyNode";
import { Version } from "../../domain/models/Version";
import { ProjectDefinitionDTO } from "../dto/ProjectDefinitionDTO";

export type DependencyScanFailure = {
  projectId: string;
  version?: string;
  error: unknown;
};

export type DependencyScanResult = {
  projectCount: number;
  tagCount: number;
  resolvedTreeCount: number;
  failures: DependencyScanFailure[];
};

export type DependencyTreeJobEvent = {
  event: "started" | "completed" | "failed";
  projectId: string;
  version: string;
  creationDate: string | null;
  commitHash: string | null;
  activeTreeCount: number;
  pendingTreeCount: number;
  attempt: number;
  maximumAttempts: number;
  retryExhausted: boolean;
  error?: unknown;
};

type DependencyTreeJob = {
  projectId: string;
  version: Version;
  projectConfiguration: string;
};

type DependencyTreeJobState = {
  projectId: string;
  attempts: number;
  completed: boolean;
  expiresAt?: number | null;
};

export class ScanProjectDependencies {
  private readonly pendingJobs = new Map<string, DependencyTreeJob>();
  private readonly activeJobKeys = new Set<string>();
  private readonly jobStates = new Map<string, DependencyTreeJobState>();
  private readonly waitingWorkers = new Set<() => void>();
  private readonly maximumAttempts = 3;
  private building = false;

  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly versionLocator: IVersionLocator,
    private readonly dependencyResolver: IDependencyResolver,
    readonly maximumConcurrency = 1,
    private readonly rangeResolutionTtlMs = DEFAULT_NPM_RANGE_RESOLUTION_TTL_MS
  ) {
    if (!Number.isSafeInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new Error("Scan concurrency must be a positive integer.");
    }
  }

  get pendingTreeCount(): number {
    return this.pendingJobs.size;
  }

  get activeTreeCount(): number {
    return this.activeJobKeys.size;
  }

  async execute(shouldStop: () => boolean = () => false): Promise<DependencyScanResult> {
    const refreshResult = await this.refreshTags(shouldStop);
    const treeResult = await this.buildDependencyTrees(shouldStop);
    return {
      projectCount: refreshResult.projectCount,
      tagCount: refreshResult.tagCount,
      resolvedTreeCount: treeResult.resolvedTreeCount,
      failures: [...refreshResult.failures, ...treeResult.failures],
    };
  }

  async refreshTags(shouldStop: () => boolean = () => false): Promise<DependencyScanResult> {
    const result = this.emptyResult();
    const projects = [...this.projectRegistry.getAllProjects()];
    const projectIds = new Set(projects.map(project => project.id));
    const catalogIds = new Set(projectIds);
    for (let index = 0; index < projects.length; index += 1) {
      for (const { project } of projects[index].dependencies ?? []) {
        if (!catalogIds.has(project.id)) {
          catalogIds.add(project.id);
          projects.push(project);
        }
      }
    }
    for (const [key, job] of this.pendingJobs) {
      if (!projectIds.has(job.projectId)) {
        this.pendingJobs.delete(key);
      }
    }
    for (const [key, state] of this.jobStates) {
      if (!projectIds.has(state.projectId) && !this.activeJobKeys.has(key)) {
        this.jobStates.delete(key);
      }
    }

    let nextProject = 0;
    const refreshNextProject = async () => {
      while (!shouldStop() && nextProject < projects.length) {
        const project = projects[nextProject++];
        const projectConfiguration = this.projectConfiguration(project);

        result.projectCount += 1;
        let versions: Version[];
        try {
          versions = await this.versionLocator.getAvailableVersions(project.id);
        } catch (error: unknown) {
          result.failures.push({ projectId: project.id, error });
          continue;
        }

        const currentProject = this.projectRegistry.getProject(project.id)
          ?? findProject(project.id, this.projectRegistry.getAllProjects());
        if (!currentProject || this.projectConfiguration(currentProject) !== projectConfiguration) {
          continue;
        }
        const activeVersions = versions.filter(version => !version.removed);
        result.tagCount += activeVersions.length;
        if (!projectIds.has(project.id)) {
          continue;
        }
        const currentKeys = new Set(activeVersions.map(version =>
          this.jobKey({ projectId: project.id, version, projectConfiguration })
        ));
        for (const [key, job] of this.pendingJobs) {
          if (job.projectId === project.id && !currentKeys.has(key)) {
            this.pendingJobs.delete(key);
          }
        }
        for (const version of activeVersions) {
          const job = { projectId: project.id, version, projectConfiguration };
          const key = this.jobKey(job);
          const state = this.currentJobState(key);
          if (version.hasDependencyTree || state?.completed || (state?.attempts ?? 0) >= this.maximumAttempts) {
            this.pendingJobs.delete(key);
            continue;
          }
          if (!this.activeJobKeys.has(key)) {
            this.pendingJobs.set(key, job);
          }
        }
        this.wakeWorkers();
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(this.maximumConcurrency, projects.length) }, refreshNextProject
    ));

    return result;
  }

  async buildDependencyTrees(
    shouldStop: () => boolean = () => false,
    onJobEvent?: (event: DependencyTreeJobEvent) => void
  ): Promise<DependencyScanResult> {
    const result = this.emptyResult();
    if (this.building) {
      return result;
    }
    this.building = true;
    const processedProjects = new Set<string>();
    const processNextJob = async () => {
      while (!shouldStop()) {
        const job = this.takeNextJob();
        if (!job) {
          if (this.activeJobKeys.size === 0) {
            return;
          }
          await new Promise<void>(resolve => { this.waitingWorkers.add(resolve); });
          continue;
        }

        const key = this.jobKey(job);
        this.activeJobKeys.add(key);
        let started = false;
        let attempt = 0;
        let failed = false;
        let failure: unknown;
        const reportJob = (event: DependencyTreeJobEvent["event"]) => onJobEvent?.({
          event,
          projectId: job.projectId,
          version: job.version.version,
          creationDate: job.version.creationDate?.toISOString() ?? null,
          commitHash: job.version.commitHash,
          activeTreeCount: this.activeTreeCount,
          pendingTreeCount: this.pendingTreeCount,
          attempt,
          maximumAttempts: this.maximumAttempts,
          retryExhausted: failed && attempt >= this.maximumAttempts,
          ...(failed ? { error: failure } : {}),
        });
        try {
          const project = this.projectRegistry.getProject(job.projectId);
          if (!project || this.projectConfiguration(project) !== job.projectConfiguration ||
            (project.tagPattern && !new RegExp(project.tagPattern).test(job.version.version))) {
            continue;
          }
          const state = this.currentJobState(key) ?? { projectId: job.projectId, attempts: 0, completed: false };
          if (state.completed || state.attempts >= this.maximumAttempts) {
            continue;
          }
          attempt = ++state.attempts;
          this.jobStates.set(key, state);
          processedProjects.add(job.projectId);
          result.tagCount += 1;
          started = true;
          reportJob("started");
          const tree = await this.dependencyResolver.resolve(job.projectId, job.version.version);
          state.expiresAt = tree ? getVersionResolutionExpiry(tree.root, this.rangeResolutionTtlMs) : null;
          state.completed = true;
          result.resolvedTreeCount += 1;
        } catch (error: unknown) {
          failed = true;
          failure = error;
          result.failures.push({ projectId: job.projectId, version: job.version.version, error });
        } finally {
          this.activeJobKeys.delete(key);
          if (started) {
            reportJob(failed ? "failed" : "completed");
          }
          this.wakeWorkers();
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: this.maximumConcurrency }, processNextJob));
    } finally {
      this.building = false;
    }
    result.projectCount = processedProjects.size;
    return result;
  }

  private wakeWorkers(): void {
    for (const resolve of this.waitingWorkers) {
      resolve();
    }
    this.waitingWorkers.clear();
  }

  private currentJobState(key: string): DependencyTreeJobState | undefined {
    const state = this.jobStates.get(key);
    if (state?.completed && state.expiresAt != null && state.expiresAt <= Date.now()) {
      this.jobStates.delete(key);
      return undefined;
    }
    return state;
  }

  private jobKey(job: DependencyTreeJob): string {
    return JSON.stringify([job.projectId, job.version.version, job.version.commitHash, job.projectConfiguration]);
  }

  private projectConfiguration(project: Project): string {
    return JSON.stringify(ProjectDefinitionDTO.fromDomain(project));
  }

  private takeNextJob(): DependencyTreeJob | undefined {
    let nextJob: DependencyTreeJob | undefined;
    for (const job of this.pendingJobs.values()) {
      if (!nextJob || this.compareJobs(job, nextJob) < 0) {
        nextJob = job;
      }
    }
    if (nextJob) {
      this.pendingJobs.delete(this.jobKey(nextJob));
    }
    return nextJob;
  }

  private compareJobs(left: DependencyTreeJob, right: DependencyTreeJob): number {
    const leftTime = left.version.creationDate?.getTime() ?? Number.NEGATIVE_INFINITY;
    const rightTime = right.version.creationDate?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (leftTime !== rightTime) {
      return leftTime > rightTime ? -1 : 1;
    }
    return right.version.version.localeCompare(left.version.version, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || left.projectId.localeCompare(right.projectId);
  }

  private emptyResult(): DependencyScanResult {
    return { projectCount: 0, tagCount: 0, resolvedTreeCount: 0, failures: [] };
  }
}