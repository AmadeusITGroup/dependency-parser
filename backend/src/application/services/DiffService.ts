import { IDiffService } from "../../domain/interfaces/IDiffService";
import { IGitClient } from "../../domain/interfaces/IGitClient";
import { IPackageParser } from "../../domain/interfaces/IPackageParser";
import { ISourceControlProvider } from "../../domain/interfaces/ISourceControlProvider";
import { Dependency } from "../../domain/models/Dependency";
import { DependencyChange, DiffResult } from "../../domain/types/DiffResult";

export class DiffService implements IDiffService {
  constructor(
    private readonly gitClient: IGitClient,
    private readonly packageParser: IPackageParser,
    private readonly sourceControlProvider?: ISourceControlProvider,
    private readonly dependencyFile = "package.json"
  ) {
    if (!this.packageParser.supports(this.dependencyFile)) {
      throw new Error(`Parser does not support "${this.dependencyFile}".`);
    }
  }

  async compareVersions(
    repoUrl: string,
    fromRef: string,
    toRef: string
  ): Promise<DiffResult> {
    let repoPath: string | null = null;

    try {
      repoPath = await this.gitClient.clone(repoUrl);

      const fromDependencies = await this.readDependenciesAtRef(repoPath, fromRef);
      const toDependencies = await this.readDependenciesAtRef(repoPath, toRef);

      return this.compareDependencyMaps(fromDependencies, toDependencies);
    } finally {
      if (repoPath) {
        await this.gitClient.remove(repoPath);
      }
    }
  }

  getCompareUrl(repoUrl: string, fromRef: string, toRef: string): string {
    if (this.sourceControlProvider) {
      return this.sourceControlProvider.getCompareUrl(repoUrl, fromRef, toRef);
    }

    const normalizedRepoUrl = repoUrl.replace(/\.git$/i, "");
    return `${normalizedRepoUrl}/compare/${fromRef}...${toRef}`;
  }

  private async readDependenciesAtRef(
    repoPath: string,
    ref: string
  ): Promise<Map<string, string>> {
    await this.gitClient.checkout(repoPath, ref);
    const manifestContent = await this.gitClient.getFileContent(
      repoPath,
      this.dependencyFile
    );
    const parseResult = this.packageParser.parseDependencies(manifestContent);

    return this.toDependencyMap(parseResult.dependencies);
  }

  private compareDependencyMaps(
    fromDependencies: Map<string, string>,
    toDependencies: Map<string, string>
  ): DiffResult {
    const added: DependencyChange[] = [];
    const removed: DependencyChange[] = [];
    const updated: DependencyChange[] = [];

    for (const [name, version] of toDependencies.entries()) {
      const previousVersion = fromDependencies.get(name);
      if (!previousVersion) {
        added.push({ name, fromVersion: null, toVersion: version });
        continue;
      }

      if (previousVersion !== version) {
        updated.push({ name, fromVersion: previousVersion, toVersion: version });
      }
    }

    for (const [name, version] of fromDependencies.entries()) {
      if (!toDependencies.has(name)) {
        removed.push({ name, fromVersion: version, toVersion: null });
      }
    }

    const byName = (left: DependencyChange, right: DependencyChange): number =>
      left.name.localeCompare(right.name);

    added.sort(byName);
    removed.sort(byName);
    updated.sort(byName);

    return { added, removed, updated };
  }

  private toDependencyMap(dependencies: Dependency[]): Map<string, string> {
    const dependencyMap = new Map<string, string>();

    for (const dependency of dependencies) {
      dependencyMap.set(dependency.name, dependency.version);
    }

    return dependencyMap;
  }
}
