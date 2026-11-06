import { IDependencyResolver, VersionNotFoundError } from "../../domain/interfaces/IDependencyResolver";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { IVersionLocator } from "../../domain/interfaces/IVersionLocator";
import { DependencyNode } from "../../domain/models/DependencyNode";
import { DependencyTree } from "../../domain/models/DependencyTree";
import { Project } from "../../domain/models/Project";
import { Logger, logger } from "../../utils/logger";
import { VersionSearchInputError } from "./FindRootVersion";

export { VersionSearchInputError };

export type FindRootVersionResult = {
  projectId: string;
  dependencyProjectId: string;
  minimumVersion: string;
  checkedVersions: number;
  totalVersions: number;
  match: {
    version: string;
    dependencyVersion: string;
    path: DependencyNode[];
    tree: DependencyTree;
  } | null;
};

export class FindFirstContainingVersion {
  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly versionLocator: IVersionLocator,
    private readonly dependencyResolver: IDependencyResolver,
    private readonly searchLogger: Logger = logger
  ) {}

  async execute(
    projectId: string,
    dependencyProjectId: string,
    minimumVersion: string
  ): Promise<FindRootVersionResult> {
    projectId = this.requireValue(projectId, "Project ID");
    dependencyProjectId = this.requireValue(dependencyProjectId, "Dependency project ID");
    minimumVersion = this.requireValue(minimumVersion, "Minimum dependency version");

    const project = this.projectRegistry.getProject(projectId);
    if (!project) {
      throw new VersionSearchInputError(`Project "${projectId}" is not registered.`);
    }
    const relevantProjectIds = new Set([dependencyProjectId]);
    const dependency = this.findDependency(
      project, dependencyProjectId, new Set([projectId]), relevantProjectIds
    );
    if (!dependency) {
      throw new VersionSearchInputError(
        `Project "${dependencyProjectId}" is not a configured dependency of "${projectId}".`
      );
    }

    let minimum: bigint[];
    try {
      minimum = this.readVersion(minimumVersion, dependency);
    } catch (error) {
      throw new VersionSearchInputError(this.errorMessage(error));
    }

    const versions = (await this.versionLocator.getAvailableVersions(projectId))
      .map(version => ({ version, fields: this.readVersion(version.version, project) }))
      .sort((left, right) => this.compare(right.fields, left.fields) ||
        right.version.version.localeCompare(left.version.version));
    const result: FindRootVersionResult = {
      projectId,
      dependencyProjectId,
      minimumVersion,
      checkedVersions: 0,
      totalVersions: versions.length,
      match: null,
    };

    for (const { version } of versions) {
      result.checkedVersions += 1;
      try {
        const tree = await this.dependencyResolver.resolve(projectId, version.version);
        const path = this.findMatchingPath(tree.root, dependency, minimum);
        if (path) {
          result.match = {
            version: version.version,
            dependencyVersion: path[path.length - 1].version,
            path,
            tree,
          };
        } else {
          const unresolved = tree.flatten().find(node =>
            node.version === "unknown" && relevantProjectIds.has(node.projectId)
          );
          if (unresolved) {
            throw new Error(`Dependency "${unresolved.projectName}" has an unknown version.`);
          }
          break;
        }
      } catch (error) {
        if (error instanceof VersionNotFoundError) {
          this.searchLogger.warn({
            projectId,
            projectName: project.name,
            version: version.version,
            missingVersion: error.version,
          }, "Skipping root release because a referenced version was not found.");
          continue;
        }
        throw new Error(
          `Cannot inspect "${project.name}@${version.version}". ${this.errorMessage(error)} ` +
          "The start of the latest containing release run cannot be confirmed.",
          { cause: error }
        );
      }
    }

    return result;
  }

  private findDependency(
    project: Project,
    projectId: string,
    visited: Set<string>,
    relevantProjectIds: Set<string>
  ): Project | null {
    let result: Project | null = null;
    for (const dependency of project.dependencies ?? []) {
      if (visited.has(dependency.project.id)) {
        continue;
      }
      const found = dependency.project.id === projectId ? dependency.project : this.findDependency(
        dependency.project, projectId, new Set([...visited, dependency.project.id]), relevantProjectIds
      );
      if (found) {
        relevantProjectIds.add(project.id);
        result ??= found;
      }
    }
    return result;
  }

  private findMatchingPath(
    node: DependencyNode,
    dependency: Project,
    minimum: bigint[],
    ancestors: DependencyNode[] = []
  ): DependencyNode[] | null {
    const path = [...ancestors, node];
    if (node.projectId === dependency.id && node.version !== "unknown" &&
      this.compare(this.readVersion(node.version, dependency), minimum) >= 0) {
      return path;
    }
    for (const child of node.dependencies) {
      const found = this.findMatchingPath(child, dependency, minimum, path);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private readVersion(version: string, project: Project): bigint[] {
    const match = project.tagPattern ? new RegExp(project.tagPattern).exec(version) : null;
    const fields = match?.[0].match(/\d+/g) ??
      (/^v?\d+(?:[.-](?:[a-z]+[.-])?\d+)*$/i.test(version) ? version.match(/\d+/g) : null);
    if (!fields) {
      throw new Error(
        `Cannot compare version "${version}" for "${project.name}". ` +
        "Use numbered versions or a tag pattern matching numeric version fields."
      );
    }
    return fields.map(field => BigInt(field));
  }

  private compare(left: bigint[], right: bigint[]): number {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const leftField = left[index] ?? 0n;
      const rightField = right[index] ?? 0n;
      if (leftField !== rightField) {
        return leftField < rightField ? -1 : 1;
      }
    }
    return 0;
  }

  private requireValue(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new VersionSearchInputError(`${label} is required.`);
    }
    return normalized;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}