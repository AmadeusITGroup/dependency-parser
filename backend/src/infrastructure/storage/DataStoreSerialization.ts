import { DependencyNode, getVersionResolutionExpiry } from "../../domain/models/DependencyNode";
import { Project } from "../../domain/models/Project";
import { ProjectDependency } from "../../domain/models/ProjectDependency";
import { ProjectTag } from "../../domain/models/ProjectTag";

export type SerializedDependencyNode = {
  projectId: string;
  projectName: string;
  version: string;
  dependencies: SerializedDependencyNode[];
  dependenciesResolved?: boolean;
  declaredVersion?: string;
  resolvedVersion?: string | null;
  resolutionCheckedAt?: string | null;
};

export type SerializedTreeSnapshot = {
  root: SerializedDependencyNode;
  commitHash: string | null;
  projectConfiguration: string;
};

export type SerializedProjectTag = {
  projectId: string;
  name: string;
  commitHash: string | null;
  creationDate: string | null;
  removed: boolean;
};

export type SerializedProject = {
  id: string;
  name: string;
  repoUrl: string;
  description: string | null;
  tagPattern?: string | null;
  dependencies: SerializedProjectDependency[] | null;
};

type SerializedProjectDependency = {
  project: SerializedProject;
  manifestPath: string | null;
  versionReference: SerializedVersionReference;
};

type SerializedVersionReference =
  | string
  | { pattern: string; flags: string }
  | null;

export function serializeProjectTag(tag: ProjectTag): SerializedProjectTag {
  return {
    projectId: tag.projectId,
    name: tag.name,
    commitHash: tag.commitHash,
    creationDate: tag.creationDate?.toISOString() ?? null,
    removed: tag.removed,
  };
}

export function deserializeProjectTag(tag: SerializedProjectTag): ProjectTag {
  return new ProjectTag(
    tag.projectId,
    tag.name,
    tag.commitHash,
    tag.creationDate ? new Date(tag.creationDate) : null,
    tag.removed
  );
}

export function serializeDependencyNode(node: DependencyNode): SerializedDependencyNode {
  return {
    projectId: node.projectId,
    projectName: node.projectName,
    version: node.version,
    declaredVersion: node.declaredVersion,
    resolvedVersion: node.resolvedVersion,
    resolutionCheckedAt: node.resolutionCheckedAt?.toISOString() ?? null,
    dependencies: node.dependencies.map(child => serializeDependencyNode(child)),
    ...(!node.dependenciesResolved ? { dependenciesResolved: false } : {}),
  };
}

export function deserializeDependencyNode(node: SerializedDependencyNode): DependencyNode {
  return new DependencyNode(
    node.projectId,
    node.projectName,
    node.version,
    node.dependencies.map(child => deserializeDependencyNode(child)),
    node.dependenciesResolved ?? true,
    node.declaredVersion ?? node.version,
    node.resolvedVersion ?? null,
    node.resolutionCheckedAt ? new Date(node.resolutionCheckedAt) : null
  );
}

export function hasExpiredVersionResolution(root: SerializedDependencyNode, ttlMs: number): boolean {
  const expiresAt = getVersionResolutionExpiry(root, ttlMs);
  return expiresAt !== null && expiresAt <= Date.now();
}

export function serializeProjectConfiguration(project: SerializedProject | null): string {
  return JSON.stringify({ tagMatching: "exact", npmRanges: "semver-v1", project });
}

export function serializeProject(project: Project): SerializedProject {
  return {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    description: project.description,
    tagPattern: project.tagPattern,
    dependencies: project.dependencies?.map(dependency => ({
      project: serializeProject(dependency.project),
      manifestPath: dependency.manifestPath,
      versionReference: serializeVersionReference(dependency.versionReference),
    })) ?? null,
  };
}

export function deserializeProject(serializedProject: SerializedProject): Project {
  return new Project(
    serializedProject.id,
    serializedProject.name,
    serializedProject.repoUrl,
    serializedProject.description,
    serializedProject.dependencies?.map(
      dependency =>
        new ProjectDependency(
          deserializeProject(dependency.project),
          dependency.manifestPath,
          deserializeVersionReference(dependency.versionReference)
        )
    ) ?? null,
    serializedProject.tagPattern ?? null
  );
}

function serializeVersionReference(
  versionReference: string | RegExp | null
): SerializedVersionReference {
  if (versionReference instanceof RegExp) {
    return {
      pattern: versionReference.source,
      flags: versionReference.flags,
    };
  }

  return versionReference;
}

function deserializeVersionReference(
  versionReference: SerializedVersionReference
): string | RegExp | null {
  if (typeof versionReference === "object" && versionReference !== null) {
    return new RegExp(versionReference.pattern, versionReference.flags);
  }

  return versionReference;
}