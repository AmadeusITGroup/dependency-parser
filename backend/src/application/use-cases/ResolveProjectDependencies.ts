import { IDependencyResolver } from "../../domain/interfaces/IDependencyResolver";
import { DependencyTree } from "../../domain/models/DependencyTree";

export class ResolveProjectDependencies {
  constructor(private readonly dependencyResolver: IDependencyResolver) {}

  async execute(projectId: string, version: string): Promise<DependencyTree> {
    if (projectId.trim() === "") {
      throw new Error("Project ID is required.");
    }

    if (version.trim() === "") {
      throw new Error("Version is required.");
    }

    return this.dependencyResolver.resolve(projectId, version);
  }
}
