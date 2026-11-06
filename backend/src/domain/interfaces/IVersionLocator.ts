import { Version } from "../models/Version";

export interface IVersionLocator {
  /**
   * Returns all discoverable versions for a given project.
   * These may come from tags, releases, or another backing source.
   */
  getAvailableVersions(projectId: string): Promise<Version[]>;

  /**
   * Returns the versions already known locally without contacting the remote.
   * Empty when nothing has been fetched yet.
   */
  getCachedVersions(projectId: string): Promise<Version[]>;

  /**
   * Resolves a requested version reference to a concrete known version.
   * Returns null when the version cannot be found.
   */
  resolveVersion(
    projectId: string,
    requestedVersion: string
  ): Promise<Version | null>;
}
