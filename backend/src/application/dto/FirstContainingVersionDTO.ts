import { FindRootVersionResult } from "../use-cases/FindFirstContainingVersion";
import { DependencyNodeDTO, DependencyTreeDTO } from "./DependencyTreeDTO";

export type FindRootVersionDTO = {
  projectId: string;
  dependencyProjectId: string;
  minimumVersion: string;
  checkedVersions: number;
  totalVersions: number;
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