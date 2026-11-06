import { IDiffService } from "../../domain/interfaces/IDiffService";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { DiffResult } from "../../domain/types/DiffResult";

export type ComparePackageVersionsResult = {
  projectId: string;
  projectName: string;
  repoUrl: string;
  fromVersion: string;
  toVersion: string;
  compareUrl: string | null;
  diffResult: DiffResult;
};

export class ComparePackageVersions {
  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly diffService: IDiffService
  ) {}

  async execute(
    projectId: string,
    fromVersion: string,
    toVersion: string
  ): Promise<ComparePackageVersionsResult> {
    const normalizedProjectId = this.requireValue(projectId, "Project ID");
    const normalizedFromVersion = this.requireValue(fromVersion, "From version");
    const normalizedToVersion = this.requireValue(toVersion, "To version");

    const project = this.projectRegistry.getProject(normalizedProjectId);
    if (!project) {
      throw new Error(`Project "${normalizedProjectId}" is not registered.`);
    }

    const diffResult = await this.diffService.compareVersions(
      project.repoUrl,
      normalizedFromVersion,
      normalizedToVersion
    );

    return {
      projectId: normalizedProjectId,
      projectName: project.name,
      repoUrl: project.repoUrl,
      fromVersion: normalizedFromVersion,
      toVersion: normalizedToVersion,
      compareUrl: this.diffService.getCompareUrl
        ? this.diffService.getCompareUrl(
            project.repoUrl,
            normalizedFromVersion,
            normalizedToVersion
          )
        : null,
      diffResult,
    };
  }

  private requireValue(value: string, label: string): string {
    const normalizedValue = value.trim();
    if (normalizedValue === "") {
      throw new Error(`${label} is required.`);
    }

    return normalizedValue;
  }
}
