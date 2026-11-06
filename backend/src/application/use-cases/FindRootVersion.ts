import { IDependencyResolver, VersionNotFoundError } from "../../domain/interfaces/IDependencyResolver";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { DependencyNode } from "../../domain/models/DependencyNode";
import { DependencyTree } from "../../domain/models/DependencyTree";
import { Project } from "../../domain/models/Project";
import { Version } from "../../domain/models/Version";
import { Logger, logger } from "../../utils/logger";
import { GetDependencyVersion } from "./GetDependencyVersion";

export class VersionSearchInputError extends Error {}

export type FindRootVersionWarning = {
  version: string;
  reason: "tree_unavailable" | "partial_tree";
  message: string;
  dependencies: {
    projectId: string;
    projectName: string;
    version: string;
    reason: "unknown_version" | "unretrievable_version";
  }[];
};

export type FindRootVersionResult = {
  projectId: string;
  dependencyProjectId: string;
  minimumVersion: string;
  checkedVersions: number;
  totalVersions: number;
  warnings: FindRootVersionWarning[];
  match: {
    version: string;
    dependencyVersion: string;
    path: DependencyNode[];
    tree: DependencyTree;
  } | null;
};

export class FindRootVersion {
  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly versionLocator: Pick<GetDependencyVersion, "getAvailableVersions">,
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

    await this.validateDependencyTag(projectId, dependency, minimumVersion);

    const versions = (await this.versionLocator.getAvailableVersions(projectId))
      .map(version => {
        const createdAt = version.creationDate?.getTime() ?? Number.NEGATIVE_INFINITY;
        return {
          version,
          fields: this.readVersion(version.version, project),
          createdAt: Number.isNaN(createdAt) ? Number.NEGATIVE_INFINITY : createdAt,
        };
      })
      .sort((left, right) =>
        (left.createdAt === right.createdAt ? 0 : left.createdAt > right.createdAt ? -1 : 1) ||
        this.compare(right.fields, left.fields) ||
        right.version.version.localeCompare(left.version.version));
    const result: FindRootVersionResult = {
      projectId,
      dependencyProjectId,
      minimumVersion,
      checkedVersions: 0,
      totalVersions: versions.length,
      warnings: [],
      match: null,
    };
    const searchContext = { projectId, projectName: project.name, dependencyProjectId, minimumVersion };
    this.searchLogger.debug({ ...searchContext, totalVersions: versions.length }, "Root version search started.");
    let boundaryVersion: string | null = null;

    for (const { version } of versions) {
      result.checkedVersions += 1;
      const versionContext = { ...searchContext, version: version.version, checkedVersions: result.checkedVersions };
      this.searchLogger.debug({ ...versionContext, decision: "inspect" }, "Root version search decision.");
      try {
        const tree = await this.dependencyResolver.resolve(projectId, version.version);
        const unresolvedDependencies = this.unresolvedDependencies(tree.root);
        if (unresolvedDependencies.length > 0) {
          result.warnings.push({
            version: version.version,
            reason: "partial_tree",
            message: "Some dependency versions could not be fully inspected. Declared versions are preserved; uninspectable descendants are unknown.",
            dependencies: unresolvedDependencies,
          });
        }
        const path = this.findMatchingPath(tree.root, dependency, minimum);
        if (path) {
          result.match = {
            version: version.version,
            dependencyVersion: path[path.length - 1].version,
            path,
            tree,
          };
          this.searchLogger.debug({
            ...versionContext, decision: "match", dependencyVersion: result.match.dependencyVersion,
          }, "Root version search decision.");
        } else {
          const unresolved = tree.flatten().find(node =>
            node.version === "unknown" && relevantProjectIds.has(node.projectId)
          );
          if (unresolved) {
            this.searchLogger.warn({
              ...versionContext,
              decision: "skip_unknown",
              unknownProjectId: unresolved.projectId,
              unknownProjectName: unresolved.projectName,
            }, "Skipping root release because a relevant dependency version is unknown.");
            continue;
          }
          boundaryVersion = version.version;
          this.searchLogger.debug({
            ...versionContext, decision: "boundary", candidateVersion: result.match?.version ?? null,
            dependencyVersion: tree.findByProjectId(dependencyProjectId)?.version ?? null,
          }, "Root version search decision.");
          break;
        }
      } catch (error) {
        if (error instanceof VersionNotFoundError) {
          result.warnings.push({
            version: version.version,
            reason: "tree_unavailable",
            message: `The tree could not be inspected. ${error.message}`,
            dependencies: [],
          });
          this.searchLogger.warn({
            projectId,
            projectName: project.name,
            version: version.version,
            missingVersion: error.version,
          }, "Skipping root release because a referenced version was not found.");
          this.searchLogger.debug({
            ...versionContext, decision: "skip_missing", missingVersion: error.version,
          }, "Root version search decision.");
          continue;
        }
        this.searchLogger.error({ ...versionContext, error: this.errorMessage(error) }, "Root version search failed.");
        throw new Error(
          `Cannot inspect "${project.name}@${version.version}". ${this.errorMessage(error)} ` +
          "The start of the latest containing release run cannot be confirmed.",
          { cause: error }
        );
      }
    }

    this.searchLogger.info({
      ...searchContext,
      matchVersion: result.match?.version ?? null,
      boundaryVersion,
      checkedVersions: result.checkedVersions,
      totalVersions: result.totalVersions,
    }, "Root version search finished.");
    return result;
  }

  private async validateDependencyTag(
    projectId: string,
    dependency: Project,
    minimumVersion: string
  ): Promise<void> {
    const context = { projectId, dependencyProjectId: dependency.id, minimumVersion };
    let tags: Version[];
    try {
      tags = await this.versionLocator.getAvailableVersions(dependency.id, true);
    } catch (error) {
      this.searchLogger.error({
        ...context, error: this.errorMessage(error),
      }, "Dependency tag validation failed.");
      throw new Error(
        `Cannot verify tag "${minimumVersion}" for dependency "${dependency.name}". ${this.errorMessage(error)}`,
        { cause: error }
      );
    }

    if (!tags.some(tag => !tag.removed && tag.version === minimumVersion)) {
      this.searchLogger.warn(context, "Root version search rejected because the dependency tag was not found.");
      throw new VersionSearchInputError(
        `Tag "${minimumVersion}" was not found for dependency "${dependency.name}" among its active tags` +
        `${dependency.tagPattern ? " matching its tag pattern" : ""}.`
      );
    }
  }

  private unresolvedDependencies(root: DependencyNode): FindRootVersionWarning["dependencies"] {
    const dependencies = new Map<string, FindRootVersionWarning["dependencies"][number]>();
    const visit = (node: DependencyNode): void => {
      if (node.version === "unknown" || !node.dependenciesResolved) {
        const reason = node.version === "unknown" ? "unknown_version" : "unretrievable_version";
        dependencies.set(JSON.stringify([node.projectId, node.version, reason]), {
          projectId: node.projectId,
          projectName: node.projectName,
          version: node.version,
          reason,
        });
      }
      node.dependencies.forEach(visit);
    };
    visit(root);
    return [...dependencies.values()];
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