import { IDataStore } from "../../domain/interfaces/IDataStore";
import { IGitClient } from "../../domain/interfaces/IGitClient";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { IVersionLocator } from "../../domain/interfaces/IVersionLocator";
import { findProject, Project } from "../../domain/models/Project";
import { ProjectTag } from "../../domain/models/ProjectTag";
import { Version } from "../../domain/models/Version";
import { filterVersionsByTagPattern, getProjectClonePath, readProjectTags } from "./projectTags";

export class VersionLocatorService implements IVersionLocator {
  private readonly inFlightRequests = new Map<string, Promise<Version[]>>();

  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly gitClient: IGitClient,
    private readonly dataStore?: IDataStore,
    private readonly cloneRoot?: string
  ) {}

  getAvailableVersions(projectId: string): Promise<Version[]> {
    // Concurrent calls share one clone because each project uses a single folder.
    const pending = this.inFlightRequests.get(projectId);
    if (pending) {
      return pending;
    }

    const request = this.loadVersions(projectId).finally(() =>
      this.inFlightRequests.delete(projectId)
    );
    this.inFlightRequests.set(projectId, request);
    return request;
  }

  private async loadVersions(projectId: string): Promise<Version[]> {
    const project = this.requireProject(projectId);
    const tags = await readProjectTags(this.gitClient, project, this.cloneRoot);
    if (this.dataStore) {
      const storedTags = await this.dataStore.syncProjectTags(projectId, tags, project.tagPattern);
      return this.buildVersions(project, storedTags);
    }
    return this.sortVersions(tags);
  }

  async getCachedVersions(projectId: string): Promise<Version[]> {
    const project = this.requireProject(projectId);
    if (this.dataStore) {
      return this.buildVersions(project, await this.dataStore.getProjectTags(projectId));
    }
    if (!this.cloneRoot) {
      return [];
    }

    const targetPath = this.getClonePath(projectId);
    if (!(await this.gitClient.hasClone(project.repoUrl, targetPath))) {
      return [];
    }

    return this.sortVersions(filterVersionsByTagPattern(
      await this.gitClient.getTags(targetPath), project.tagPattern
    ));
  }

  private requireProject(projectId: string): Project {
    const project = this.projectRegistry.getProject(projectId)
      ?? findProject(projectId, this.projectRegistry.getAllProjects());
    if (!project) {
      throw new Error(`Project "${projectId}" is not registered.`);
    }

    return project;
  }

  private async buildVersions(project: Project, tags: ProjectTag[]): Promise<Version[]> {
    const versions: Version[] = [];
    const availableTrees = new Set(await this.dataStore?.getAvailableVersions(project.id) ?? []);
    const pattern = project.tagPattern ? new RegExp(project.tagPattern) : null;
    for (const tag of tags) {
      if (pattern && !pattern.test(tag.name)) {
        continue;
      }
      versions.push(new Version(
        tag.name,
        tag.creationDate,
        tag.commitHash,
        tag.removed,
        availableTrees.has(tag.name)
      ));
    }
    return this.sortVersions(versions);
  }

  private getClonePath(projectId: string): string {
    return getProjectClonePath(this.cloneRoot ?? "", projectId);
  }

  async resolveVersion(
    projectId: string,
    requestedVersion: string
  ): Promise<Version | null> {
    if (requestedVersion !== "latest") {
      const cachedVersions = await this.getCachedVersions(projectId);
      const cachedVersion = cachedVersions.find(version =>
        version.version === requestedVersion
      );
      if (cachedVersion) {
        return cachedVersion;
      }
    }
    const availableVersions = await this.getAvailableVersions(projectId);
    if (availableVersions.length === 0) {
      return null;
    }

    if (requestedVersion === "latest") {
      return availableVersions.find(version => !version.removed) ?? null;
    }

    return availableVersions.find(
      version => version.version === requestedVersion
    ) ?? null;
  }

  private sortVersions(versions: Version[]): Version[] {
    return versions.sort((left, right) => {
      const leftTime = left.creationDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      const rightTime = right.creationDate?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (leftTime !== rightTime) {
        return rightTime > leftTime ? 1 : -1;
      }

      return right.version.localeCompare(left.version, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
  }
}
