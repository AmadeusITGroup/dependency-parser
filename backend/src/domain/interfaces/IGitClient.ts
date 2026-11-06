import { Version } from "../models/Version";
import { CommitComparisonTagHints, CommitDiff } from "../types/CommitDiff";

export class GitRefNotFoundError extends Error {
  constructor(public readonly ref: string) {
    super(`Git ref "${ref}" was not found.`);
    this.name = "GitRefNotFoundError";
  }
}

export interface IGitClient {
  /**
   * Clones a repository locally.
   * Returns the local path where it was cloned.
   */
  clone(repoUrl: string, targetPath?: string): Promise<string>;

  /**
   * Keeps a lightweight clone (no checkout, no file contents) at targetPath for tag discovery.
   * A pattern can select a shallow catalog before transfer on supported Git versions.
   * Existing full clones remain compatible. Refreshes update moved tags and prune deleted tags.
   * Returns targetPath.
   */
  syncTags(repoUrl: string, targetPath?: string, tagPattern?: string | null): Promise<string>;

  /**
   * Checks whether targetPath already holds a clone of repoUrl.
   */
  hasClone(repoUrl: string, targetPath: string): Promise<boolean>;

  /**
   * Clones a repository with a sparse checkout containing only the requested files.
   * Throws when any requested file does not exist in the default checkout.
   */
  cloneFiles(repoUrl: string, filePaths: string[], targetPath?: string): Promise<string>;

  /**
   * Checks out a specific commit, tag, or branch.
   */
  checkout(repoPath: string, ref: string): Promise<void>;

  /**
   * Checks whether a commit, tag, or branch resolves to a commit in the repository.
   */
  hasRef(repoPath: string, ref: string): Promise<boolean>;

  /**
   * Reads the content of a file at the given ref (read from git, no checkout needed),
   * or at the current checkout when no ref is given.
   */
  getFileContent(repoPath: string, filePath: string, ref?: string): Promise<string>;

  /**
   * Checks if a file exists at the given ref (read from git, no checkout needed),
   * or at the current checkout when no ref is given.
   */
  fileExists(repoPath: string, filePath: string, ref?: string): Promise<boolean>;

  /**
   * Lists tags with their tagger date (annotated tags) or commit date (lightweight tags).
   */
  getTags(repoPath: string): Promise<Version[]>;

  /**
   * Compares exact exclusive histories in isolated, no-checkout repositories.
   * Tag histories deepen as needed without changing shared tag catalogs.
   * Optional exact-tag catalog hints avoid discovery, but Git refs are always refreshed.
   * Returns commits reachable from only one ref, newest first on each side.
   */
  compareCommits(
    repoUrl: string, fromRef: string, toRef: string, tagHints?: CommitComparisonTagHints
  ): Promise<CommitDiff>;

  /**
   * Cleans up a local repository (optional but important for disk management).
   */
  remove(repoPath: string): Promise<void>;
}