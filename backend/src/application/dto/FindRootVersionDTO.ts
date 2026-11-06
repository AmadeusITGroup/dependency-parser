import { FindRootVersionResult } from "../use-cases/FindRootVersion";
import { DependencyNodeDTO, DependencyTreeDTO } from "./DependencyTreeDTO";

export type FindRootVersionWarningDTO = {
  version: string;
  reason: "tree_unavailable" | "partial_tree";
  message: string;
  dependencies: (Pick<DependencyNodeDTO, "projectId" | "projectName" | "version"> & {
    reason: "unknown_version" | "unretrievable_version";
  })[];
};

export type FindRootVersionDTO = {
  projectId: string;
  dependencyProjectId: string;
  minimumVersion: string;
  checkedVersions: number;
  totalVersions: number;
  warnings: FindRootVersionWarningDTO[];
  match: {
    version: string;
    dependencyVersion: string;
    path: Pick<DependencyNodeDTO, "projectId" | "projectName" | "version">[];
    dependencyTree: DependencyTreeDTO;
  } | null;
};

export const FindRootVersionDTO = {
  fromResult(result: FindRootVersionResult): FindRootVersionDTO {
    return {
      projectId: result.projectId,
      dependencyProjectId: result.dependencyProjectId,
      minimumVersion: result.minimumVersion,
      checkedVersions: result.checkedVersions,
      totalVersions: result.totalVersions,
      warnings: result.warnings.map(warning => ({
        version: warning.version,
        reason: warning.reason,
        message: warning.message,
        dependencies: warning.dependencies.map(dependency => ({
          projectId: dependency.projectId,
          projectName: dependency.projectName,
          version: dependency.version,
          reason: dependency.reason,
        })),
      })),
      match: result.match ? {
        version: result.match.version,
        dependencyVersion: result.match.dependencyVersion,
        path: result.match.path.map(node => ({
          projectId: node.projectId,
          projectName: node.projectName,
          version: node.version,
        })),
        dependencyTree: DependencyTreeDTO.fromDomain(
          result.projectId, result.match.version, result.match.tree
        ),
      } : null,
    };
  },
};