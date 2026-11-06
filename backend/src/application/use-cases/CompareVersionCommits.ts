import { IDataStore } from "../../domain/interfaces/IDataStore";
import { IGitClient } from "../../domain/interfaces/IGitClient";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { ISourceControlProvider } from "../../domain/interfaces/ISourceControlProvider";
import { findProject } from "../../domain/models/Project";
import { CommitComparisonTagHints, CommitSummary } from "../../domain/types/CommitDiff";

export class CommitComparisonInputError extends Error {}
export class CommitComparisonProjectNotFoundError extends Error {}

type LinkedCommit = CommitSummary & { url: string };

const COMPARISON_CACHE_LIMIT = 1_000;
const COMPARISON_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export type CompareVersionCommitsResult = {
  projectId: string;
  projectName: string;
  fromVersion: string;
  toVersion: string;
  fromCommitHash: string;
  toCommitHash: string;
  fromOnly: LinkedCommit[];
  toOnly: LinkedCommit[];
};

type CommitComparison = Omit<CompareVersionCommitsResult, "projectId" | "projectName">;

export class CompareVersionCommits {
  private readonly comparisonCache = new Map<string, { result: CommitComparison; expiresAt: number }>();
  private readonly inFlightRequests = new Map<string, Promise<CommitComparison>>();

  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly gitClient: IGitClient,
    private readonly sourceControlProvider: ISourceControlProvider,
    private readonly dataStore?: IDataStore
  ) {}

  async execute(
    projectId: string,
    fromVersion: string,
    toVersion: string
  ): Promise<CompareVersionCommitsResult> {
    const id = this.requireValue(projectId, "Project ID");
    const from = this.requireRef(fromVersion, "From version");
    const to = this.requireRef(toVersion, "To version");
    const project = this.projectRegistry.getProject(id)
      ?? findProject(id, this.projectRegistry.getAllProjects());
    if (!project) {
      throw new CommitComparisonProjectNotFoundError(`Project "${id}" is not registered.`);
    }

    const key = JSON.stringify([id, project.repoUrl, ...[from, to].sort()]);
    const comparison = await this.getComparison(key, project.id, project.repoUrl, from, to);
    const reversed = comparison.fromVersion !== from;
    return {
      projectId: id,
      projectName: project.name,
      fromVersion: from,
      toVersion: to,
      fromCommitHash: reversed ? comparison.toCommitHash : comparison.fromCommitHash,
      toCommitHash: reversed ? comparison.fromCommitHash : comparison.toCommitHash,
      fromOnly: (reversed ? comparison.toOnly : comparison.fromOnly).map(commit => ({ ...commit })),
      toOnly: (reversed ? comparison.fromOnly : comparison.toOnly).map(commit => ({ ...commit })),
    };
  }

  private getComparison(
    key: string,
    projectId: string,
    repoUrl: string,
    fromVersion: string,
    toVersion: string
  ): Promise<CommitComparison> {
    const cached = this.comparisonCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.comparisonCache.delete(key);
      this.comparisonCache.set(key, cached);
      return Promise.resolve(cached.result);
    }
    this.comparisonCache.delete(key);
    const pending = this.inFlightRequests.get(key);
    if (pending) {
      return pending;
    }

    const request = this.loadComparison(projectId, repoUrl, fromVersion, toVersion).then(result => {
      const now = Date.now();
      for (const [cachedKey, entry] of this.comparisonCache) {
        if (entry.expiresAt <= now) {
          this.comparisonCache.delete(cachedKey);
        }
      }
      this.comparisonCache.set(key, { result, expiresAt: now + COMPARISON_CACHE_TTL_MS });
      if (this.comparisonCache.size > COMPARISON_CACHE_LIMIT) {
        const oldest = this.comparisonCache.keys().next();
        if (!oldest.done) {
          this.comparisonCache.delete(oldest.value);
        }
      }
      return result;
    }).finally(() => this.inFlightRequests.delete(key));
    this.inFlightRequests.set(key, request);
    return request;
  }

  private async loadComparison(
    projectId: string,
    repoUrl: string,
    fromVersion: string,
    toVersion: string
  ): Promise<CommitComparison> {
    const hints = this.dataStore
      ? await this.getTagHints(projectId, fromVersion, toVersion) : undefined;
    const diff = hints
      ? await this.gitClient.compareCommits(repoUrl, fromVersion, toVersion, hints)
      : await this.gitClient.compareCommits(repoUrl, fromVersion, toVersion);
    const linkCommit = (commit: CommitSummary): LinkedCommit => ({
      ...commit,
      url: this.sourceControlProvider.getCommitUrl(repoUrl, commit.hash),
    });
    return {
      fromVersion,
      toVersion,
      fromCommitHash: diff.fromCommitHash,
      toCommitHash: diff.toCommitHash,
      fromOnly: diff.fromOnly.map(linkCommit),
      toOnly: diff.toOnly.map(linkCommit),
    };
  }

  private async getTagHints(
    projectId: string, fromVersion: string, toVersion: string
  ): Promise<CommitComparisonTagHints | undefined> {
    const store = this.dataStore;
    if (!store) {
      return undefined;
    }
    const fromRequest = store.getProjectTag(projectId, fromVersion);
    const [from, to] = await Promise.all([
      fromRequest,
      fromVersion === toVersion ? fromRequest : store.getProjectTag(projectId, toVersion),
    ]);
    if (!from || !to || from.removed || to.removed ||
      from.commitHash === null || to.commitHash === null) {
      return undefined;
    }
    if (from.projectId !== projectId || to.projectId !== projectId ||
      from.name !== fromVersion || to.name !== toVersion ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(from.commitHash) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(to.commitHash)) {
      throw new Error("Stored commit comparison tag metadata is invalid.");
    }
    return { fromCommitHash: from.commitHash, toCommitHash: to.commitHash };
  }

  private requireValue(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new CommitComparisonInputError(`${label} is required.`);
    }
    return normalized;
  }

  private requireRef(value: string, label: string): string {
    const ref = this.requireValue(value, label);
    if (ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
      throw new CommitComparisonInputError(`${label} is not a valid Git ref.`);
    }
    return ref;
  }
}
