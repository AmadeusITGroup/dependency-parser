import { ISourceControlProvider, SourceControlUrlError } from "../../domain/interfaces/ISourceControlProvider";
import { GitHubProvider } from "./github/GitHubProvider";
import { encodeRepositoryFilePath, parseRepositoryUrl, repositoryWebUrl } from "./RepositoryUrl";

type Repository = {
  platform: "github" | "gitlab" | "bitbucket-cloud" | "bitbucket-server";
  url: string;
};

export class AutoDetectSourceControlProvider implements ISourceControlProvider {
  private readonly github = new GitHubProvider();

  getCommitUrl(repoUrl: string, commit: string): string {
    const { platform, url } = this.resolveRepository(repoUrl);
    if (platform === "github") {
      return this.github.getCommitUrl(url, commit);
    }
    const commitPath = platform === "gitlab" ? "-/commit" : "commits";
    return `${url}/${commitPath}/${encodeURIComponent(commit)}`;
  }

  getCompareUrl(repoUrl: string, fromRef: string, toRef: string): string {
    const { platform, url } = this.resolveRepository(repoUrl);
    const from = encodeURIComponent(fromRef);
    const to = encodeURIComponent(toRef);
    switch (platform) {
      case "github":
        return this.github.getCompareUrl(url, fromRef, toRef);
      case "gitlab":
        return `${url}/-/compare/${from}...${to}`;
      case "bitbucket-cloud":
        // Bitbucket names the incoming ref first, opposite to GitHub and GitLab.
        return `${url}/branches/compare/${to}..${from}`;
      case "bitbucket-server":
        return `${url}/compare/commits?sourceBranch=${to}&targetBranch=${from}`;
    }
  }

  getBrowseUrl(repoUrl: string, ref: string): string {
    const { platform, url } = this.resolveRepository(repoUrl);
    const encodedRef = encodeURIComponent(ref);
    switch (platform) {
      case "github":
        return this.github.getBrowseUrl(url, ref);
      case "gitlab":
        return `${url}/-/tree/${encodedRef}`;
      case "bitbucket-cloud":
        return `${url}/src/${encodedRef}/`;
      case "bitbucket-server":
        return `${url}/browse?at=${encodedRef}`;
    }
  }

  getFileUrl(repoUrl: string, filePath: string, ref: string): string {
    const { platform, url } = this.resolveRepository(repoUrl);
    const file = encodeRepositoryFilePath(filePath);
    const encodedRef = encodeURIComponent(ref);
    switch (platform) {
      case "github":
        return this.github.getFileUrl(url, filePath, ref);
      case "gitlab":
        return `${url}/-/blob/${encodedRef}/${file}`;
      case "bitbucket-cloud":
        return `${url}/src/${encodedRef}/${file}`;
      case "bitbucket-server":
        return `${url}/browse/${file}?at=${encodedRef}`;
    }
  }

  private resolveRepository(repoUrl: string): Repository {
    const repository = parseRepositoryUrl(repoUrl);
    const segments = repository.segments;
    switch (repository.hostname) {
      case "github.com":
        return { platform: "github", url: repositoryWebUrl(repository) };
      case "gitlab.com":
        if (segments.length < 2) {
          throw new SourceControlUrlError("GitLab repository URL must contain a namespace and repository.");
        }
        return { platform: "gitlab", url: repositoryWebUrl(repository) };
      case "bitbucket.org":
        if (segments.length !== 2) {
          throw new SourceControlUrlError("Bitbucket Cloud repository URL must contain a workspace and repository.");
        }
        return { platform: "bitbucket-cloud", url: repositoryWebUrl(repository) };
      default: {
        if (!/^bitbucket\..+$/.test(repository.hostname)) {
          throw new SourceControlUrlError(`Unsupported source-control host "${repository.hostname}".`);
        }
        let webPath: string[];
        if (segments.length === 4 && segments[0] === "projects" && segments[2] === "repos") {
          webPath = ["projects", segments[1].toUpperCase(), "repos", segments[3]];
        } else if ((segments.length === 3 && segments[0] === "scm") ||
          (repository.ssh && segments.length === 2)) {
          const [project, name] = segments.slice(-2);
          webPath = ["projects", project.toUpperCase(), "repos", name];
        } else {
          throw new SourceControlUrlError(
            "Bitbucket Server repository URL must use /projects/KEY/repos/NAME, /scm/KEY/NAME.git, or an SSH KEY/NAME path."
          );
        }
        return { platform: "bitbucket-server", url: repositoryWebUrl(repository, webPath) };
      }
    }
  }
}
