export class SourceControlUrlError extends Error {}

export interface ISourceControlProvider {
  /**
   * Returns a URL to view a specific commit.
   */
  getCommitUrl(repoUrl: string, commit: string): string;

  /**
   * Returns a URL to compare two versions (commits, tags, branches).
   */
  getCompareUrl(
    repoUrl: string,
    fromRef: string,
    toRef: string
  ): string;

  /**
   * Returns a URL to browse the repository at a specific version.
   */
  getBrowseUrl(repoUrl: string, ref: string): string;

  /**
   * Returns a URL to a specific file at a given version.
   */
  getFileUrl(
    repoUrl: string,
    filePath: string,
    ref: string
  ): string;
}