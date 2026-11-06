import { IVersionLocator } from "../../domain/interfaces/IVersionLocator";
import { Version } from "../../domain/models/Version";

export type DependencyVersionResult = {
  projectId: string;
  requestedVersion: string;
  resolvedVersion: Version | null;
};

export class GetDependencyVersion {
  constructor(
    private readonly versionLocator: IVersionLocator,
    private readonly dependencyScanEnabled = false
  ) {}

  async execute(
    projectId: string,
    requestedVersion: string
  ): Promise<DependencyVersionResult> {
    const normalizedProjectId = this.requireValue(projectId, "Project ID");
    const normalizedRequestedVersion = this.requireValue(requestedVersion, "Requested version");

    const resolvedVersion = await this.versionLocator.resolveVersion(
      normalizedProjectId,
      normalizedRequestedVersion
    );

    return {
      projectId: normalizedProjectId,
      requestedVersion: normalizedRequestedVersion,
      resolvedVersion,
    };
  }

  async getAvailableVersions(projectId: string, forceRefresh = false): Promise<Version[]> {
    const normalizedProjectId = this.requireValue(projectId, "Project ID");
    if (this.dependencyScanEnabled && !forceRefresh) {
      const cachedVersions = await this.versionLocator.getCachedVersions(normalizedProjectId);
      if (cachedVersions.length > 0) {
        return cachedVersions;
      }
    }
    return this.versionLocator.getAvailableVersions(normalizedProjectId);
  }

  async getCachedVersions(projectId: string): Promise<Version[]> {
    const normalizedProjectId = this.requireValue(projectId, "Project ID");
    return this.versionLocator.getCachedVersions(normalizedProjectId);
  }

  private requireValue(value: string, label: string): string {
    const normalizedValue = value.trim();
    if (normalizedValue === "") {
      throw new Error(`${label} is required.`);
    }

    return normalizedValue;
  }
}
