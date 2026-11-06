import { IDataStore } from "../../domain/interfaces/IDataStore";
import { IDependencyResolver, VersionNotFoundError } from "../../domain/interfaces/IDependencyResolver";
import { IGitClient } from "../../domain/interfaces/IGitClient";
import { IPackageParser } from "../../domain/interfaces/IPackageParser";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { Dependency } from "../../domain/models/Dependency";
import { DependencyNode } from "../../domain/models/DependencyNode";
import { DependencyTree } from "../../domain/models/DependencyTree";
import { Project } from "../../domain/models/Project";
import { ProjectDependency } from "../../domain/models/ProjectDependency";
import { Logger, logger } from "../../utils/logger";
import { getProjectClonePath, readProjectTags } from "./projectTags";

type ProjectRevision = {
  repoPath: string;
  version: string;
};

type ResolutionContext = {
  ancestry: Set<string>;
  versionCatalogs: Map<string, Promise<readonly string[]>>;
  cachedResolutions: Map<string, DependencyNode>;
};

export class DependencyResolverService implements IDependencyResolver {
  private readonly cloneQueues = new Map<string, Promise<unknown>>();
  private readonly dependencyRevisionRequests = new Map<string, Promise<ProjectRevision>>();
  private readonly dependencyTagRequests = new Map<string, Promise<readonly string[]>>();

  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly gitClient: IGitClient,
    private readonly packageParsers: IPackageParser[],
    private readonly cloneRoot: string,
    private readonly dataStore?: IDataStore,
    private readonly dependencyResolutionRetries = 2,
    private readonly log: Pick<Logger, "warn"> = logger
  ) {
    if (!Number.isSafeInteger(dependencyResolutionRetries) || dependencyResolutionRetries < 0) {
      throw new Error("Dependency resolution retries must be a nonnegative integer.");
    }
  }

  async resolve(projectId: string, version: string): Promise<DependencyTree> {
    const tag = await this.dataStore?.getProjectTag(projectId, version);
    const cachedTree = await this.dataStore?.getDependencyTree(
      projectId, version, tag?.commitHash, tag?.removed ?? false
    );
    if (cachedTree && (tag?.removed || this.hasResolvedVersions(cachedTree.root))) {
      return cachedTree;
    }

    if (tag?.removed) {
      throw new Error(`Tag "${version}" was removed and has no saved dependency tree.`);
    }

    const project = this.projectRegistry.getProject(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" is not registered.`);
    }

    const context: ResolutionContext = {
      ancestry: new Set(),
      versionCatalogs: new Map(),
      cachedResolutions: new Map(),
    };
    if (cachedTree) {
      this.collectCachedResolutions(cachedTree.root, context.cachedResolutions);
    }
    const tree = new DependencyTree(await this.buildProjectNode(
      project, version, context, tag?.commitHash ?? version
    ));

    if (this.dataStore) {
      await this.dataStore.saveDependencyTree(projectId, version, tree, tag?.commitHash ?? null, project);
    }

    return tree;
  }

  private hasResolvedVersions(node: DependencyNode): boolean {
    if (node.resolutionCheckedAt && node.resolvedVersion === null) {
      return true;
    }
    return node.dependenciesResolved && node.version !== "unknown" &&
      node.dependencies.every(child => this.hasResolvedVersions(child));
  }

  private collectCachedResolutions(node: DependencyNode, resolutions: Map<string, DependencyNode>): void {
    if (node.resolutionCheckedAt) {
      resolutions.set(JSON.stringify([node.projectId, node.declaredVersion]), node);
    }
    node.dependencies.forEach(child => this.collectCachedResolutions(child, resolutions));
  }

  /**
   * Makes sure a persistent clone of the project exists and knows the given tag,
   * fetching only when the clone is missing or the tag is not known yet.
   */
  private async ensureClone(project: Project, ref: string): Promise<ProjectRevision> {
    const clonePath = getProjectClonePath(this.cloneRoot, project.id);

    if (await this.gitClient.hasClone(project.repoUrl, clonePath) &&
      await this.gitClient.hasRef(clonePath, ref)) {
      return { repoPath: clonePath, version: ref };
    }

    // Missing clones or refs still share one serialized preparation path.
    const previous = this.cloneQueues.get(clonePath) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.prepareClone(project, clonePath, ref));
    this.cloneQueues.set(clonePath, next);

    return next.finally(() => {
      if (this.cloneQueues.get(clonePath) === next) {
        this.cloneQueues.delete(clonePath);
      }
    });
  }

  private async prepareClone(
    project: Project,
    clonePath: string,
    ref: string
  ): Promise<ProjectRevision> {
    let refExists = await this.gitClient.hasClone(project.repoUrl, clonePath) &&
      await this.gitClient.hasRef(clonePath, ref);

    if (!refExists) {
      await this.gitClient.syncTags(project.repoUrl, clonePath);
      refExists = await this.gitClient.hasRef(clonePath, ref);
    }

    if (!refExists) {
      throw new VersionNotFoundError(ref, project.repoUrl);
    }

    return { repoPath: clonePath, version: ref };
  }

  private async buildProjectNode(
    project: Project,
    version: string,
    context: ResolutionContext,
    ref = version,
    preparedRevision?: ProjectRevision
  ): Promise<DependencyNode> {
    const revision = preparedRevision ?? await this.ensureClone(project, ref);
    const node = new DependencyNode(project.id, project.name, version);
    const projectKey = `${project.id}@${version}`;

    if (context.ancestry.has(projectKey)) {
      return node;
    }

    const nextAncestry = new Set(context.ancestry);
    nextAncestry.add(projectKey);

    for (const dependency of project.dependencies ?? []) {
      node.addDependency(
        await this.resolveDependencyNode(
          revision.repoPath,
          revision.version,
          dependency,
          { ...context, ancestry: nextAncestry }
        )
      );
    }

    return node;
  }

  private async resolveDependencyNode(
    parentRepoPath: string,
    parentVersion: string,
    dependency: ProjectDependency,
    context: ResolutionContext
  ): Promise<DependencyNode> {
    const declaration = await this.readDependencyVersion(
      parentRepoPath,
      parentVersion,
      dependency
    );

    if (!declaration || declaration.version === "unknown") {
      return this.buildUnresolvedNode(dependency.project, "unknown");
    }

    const { version, parser } = declaration;
    const cachedResolution = parser.resolveVersion
      ? context.cachedResolutions.get(JSON.stringify([dependency.project.id, version]))
      : undefined;
    const resolution = cachedResolution
      ? { resolvedVersion: cachedResolution.resolvedVersion }
      : await parser.resolveVersion?.(
        version, () => this.getDependencyVersions(dependency.project, context)
      ) ?? null;
    const resolutionCheckedAt = resolution
      ? cachedResolution?.resolutionCheckedAt ?? new Date()
      : null;
    const withResolution = (node: DependencyNode): DependencyNode => {
      node.declaredVersion = version;
      node.resolvedVersion = resolution?.resolvedVersion ?? null;
      node.resolutionCheckedAt = resolutionCheckedAt;
      return node;
    };
    if (resolution && resolution.resolvedVersion === null) {
      this.log.warn({
        projectId: dependency.project.id,
        projectName: dependency.project.name,
        declaredVersion: version,
      }, "No available dependency tag satisfies the declared version range; marking descendants unknown.");
      return withResolution(this.buildUnresolvedNode(dependency.project, version));
    }
    const selectedVersion = resolution?.resolvedVersion ?? version;
    let revision: ProjectRevision;
    try {
      revision = await this.getDependencyRevision(dependency.project, selectedVersion);
    } catch (error: unknown) {
      if (!(error instanceof VersionNotFoundError)) {
        throw error;
      }
      this.log.warn({
        projectId: dependency.project.id,
        projectName: dependency.project.name,
        requestedVersion: selectedVersion,
        declaredVersion: version,
        attempts: this.dependencyResolutionRetries + 1,
        err: error,
      }, "Dependency ref unavailable after retries; preserving the declared version and marking descendants unknown.");
      return withResolution(this.buildUnresolvedNode(dependency.project, selectedVersion));
    }

    return withResolution(await this.buildProjectNode(
      dependency.project, selectedVersion, context, selectedVersion, revision
    ));
  }

  private getDependencyVersions(
    project: Project,
    context: ResolutionContext
  ): Promise<readonly string[]> {
    const key = JSON.stringify([project.id, project.repoUrl, project.tagPattern]);
    let request = context.versionCatalogs.get(key) ?? this.dependencyTagRequests.get(key);
    if (!request) {
      request = readProjectTags(this.gitClient, project, this.cloneRoot).then(async tags => {
        await this.dataStore?.syncProjectTags(project.id, tags, project.tagPattern);
        return tags.filter(tag => !tag.removed).map(tag => tag.version);
      }).finally(() => {
        this.dependencyTagRequests.delete(key);
      });
      this.dependencyTagRequests.set(key, request);
    }
    context.versionCatalogs.set(key, request);
    return request;
  }

  private buildUnresolvedNode(
    project: Project,
    version: string,
    ancestry: Set<string> = new Set()
  ): DependencyNode {
    const node = new DependencyNode(project.id, project.name, version, [], false);
    if (ancestry.has(project.id)) {
      return node;
    }
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(project.id);
    for (const dependency of project.dependencies ?? []) {
      node.addDependency(this.buildUnresolvedNode(dependency.project, "unknown", nextAncestry));
    }
    return node;
  }

  private getDependencyRevision(project: Project, version: string): Promise<ProjectRevision> {
    const key = JSON.stringify([project.id, project.repoUrl, version]);
    const pending = this.dependencyRevisionRequests.get(key);
    if (pending) {
      return pending;
    }
    const request = this.retryDependencyRevision(project, version).finally(() => {
      if (this.dependencyRevisionRequests.get(key) === request) {
        this.dependencyRevisionRequests.delete(key);
      }
    });
    this.dependencyRevisionRequests.set(key, request);
    return request;
  }

  private async retryDependencyRevision(project: Project, version: string): Promise<ProjectRevision> {
    let retries = 0;
    while (true) {
      try {
        return await this.ensureClone(project, version);
      } catch (error: unknown) {
        if (!(error instanceof VersionNotFoundError) || retries >= this.dependencyResolutionRetries) {
          throw error;
        }
        retries += 1;
      }
    }
  }

  private async readDependencyVersion(
    repoPath: string,
    ref: string,
    dependency: ProjectDependency
  ): Promise<{ version: string; parser: IPackageParser } | null> {
    const versionReference = dependency.versionReference;

    if (!dependency.manifestPath || !versionReference) {
      return null;
    }

    if (!(await this.gitClient.fileExists(repoPath, dependency.manifestPath, ref))) {
      return null;
    }

    const parser = this.getParser(dependency.manifestPath);
    const content = await this.gitClient.getFileContent(
      repoPath,
      dependency.manifestPath,
      ref
    );
    const parsedDependencies = parser.parseDependencies(content).dependencies;
    const matchedDependency = parsedDependencies.find(candidate =>
      this.matchesVersionReference(candidate, versionReference)
    );

    return matchedDependency ? { version: matchedDependency.version, parser } : null;
  }

  private getParser(manifestPath: string): IPackageParser {
    const fileName = manifestPath.split(/[\\/]/).pop() ?? manifestPath;
    const parser = this.packageParsers.find(candidate => candidate.supports(fileName));

    if (!parser) {
      throw new Error(`No parser available for "${manifestPath}".`);
    }

    return parser;
  }

  private matchesVersionReference(
    dependency: Dependency,
    versionReference: string | RegExp
  ): boolean {
    if (typeof versionReference === "string") {
      return dependency.name === versionReference;
    }

    versionReference.lastIndex = 0;
    return versionReference.test(dependency.name);
  }
}
