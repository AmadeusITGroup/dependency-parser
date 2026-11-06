import { ISourceControlProvider, SourceControlUrlError } from "../../../domain/interfaces/ISourceControlProvider";
import { encodeRepositoryFilePath, parseRepositoryUrl, repositoryWebUrl } from "../RepositoryUrl";

export class GitHubProvider implements ISourceControlProvider {
  getCommitUrl(repoUrl: string, commit: string): string {
    return `${this.normalizeRepoUrl(repoUrl)}/commit/${encodeURIComponent(commit)}`;
  }

  getCompareUrl(repoUrl: string, fromRef: string, toRef: string): string {
    return `${this.normalizeRepoUrl(repoUrl)}/compare/${encodeURIComponent(
      fromRef
    )}...${encodeURIComponent(toRef)}`;
  }

  getBrowseUrl(repoUrl: string, ref: string): string {
    return `${this.normalizeRepoUrl(repoUrl)}/tree/${encodeURIComponent(ref)}`;
  }

  getFileUrl(repoUrl: string, filePath: string, ref: string): string {
    const normalizedFilePath = encodeRepositoryFilePath(filePath);

    return `${this.normalizeRepoUrl(repoUrl)}/blob/${encodeURIComponent(
      ref
    )}/${normalizedFilePath}`;
  }

  private normalizeRepoUrl(repoUrl: string): string {
    const repository = parseRepositoryUrl(repoUrl);
    if (repository.hostname !== "github.com") {
      throw new SourceControlUrlError("Expected a github.com repository URL.");
    }
    if (repository.segments.length !== 2) {
      throw new SourceControlUrlError("GitHub repository URL must contain an owner and repository.");
    }
    return repositoryWebUrl(repository);
  }
}
