import { DependencyNode } from "../../domain/models/DependencyNode";
import { DependencyTree } from "../../domain/models/DependencyTree";

export type DependencyNodeDTO = {
  projectId: string;
  projectName: string;
  version: string;
  creationDate: string | null;
  dependencies: DependencyNodeDTO[];
  dependenciesResolved?: boolean;
  declaredVersion?: string;
  resolvedVersion?: string | null;
  resolutionCheckedAt?: string;
};

export class DependencyTreeDTO {
  constructor(
    public readonly projectId: string,
    public readonly projectName: string,
    public readonly version: string,
    public readonly tree: DependencyNodeDTO
  ) {}

  static fromDomain(
    projectId: string,
    version: string,
    dependencyTree: DependencyTree
  ): DependencyTreeDTO {
    return new DependencyTreeDTO(
      projectId,
      dependencyTree.root.projectName,
      version,
      DependencyTreeDTO.mapNode(dependencyTree.root)
    );
  }

  private static mapNode(node: DependencyNode): DependencyNodeDTO {
    return {
      projectId: node.projectId,
      projectName: node.projectName,
      version: node.version,
      creationDate: null,
      ...(node.resolutionCheckedAt ? {
        declaredVersion: node.declaredVersion,
        resolvedVersion: node.resolvedVersion,
        resolutionCheckedAt: node.resolutionCheckedAt.toISOString(),
      } : {}),
      dependencies: node.dependencies.map(child => DependencyTreeDTO.mapNode(child)),
      ...(!node.dependenciesResolved ? { dependenciesResolved: false } : {}),
    };
  }
}
