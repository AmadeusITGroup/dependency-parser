import { DependencyTree } from "../models/DependencyTree";

export class VersionNotFoundError extends Error {
  constructor(public readonly version: string, repoUrl: string) {
    super(`Version "${version}" was not found in "${repoUrl}".`);
    this.name = "VersionNotFoundError";
  }
}

export interface IDependencyResolver {
  /**
   * Resolves and returns the full dependency tree
   * for a given project and version.
   */
  resolve(
    projectId: string,
    version: string
  ): Promise<DependencyTree>;
}