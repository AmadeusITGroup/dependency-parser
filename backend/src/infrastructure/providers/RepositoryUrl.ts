import { SourceControlUrlError } from "../../domain/interfaces/ISourceControlProvider";

export type RepositoryUrl = {
  hostname: string;
  origin: string;
  segments: string[];
  ssh: boolean;
};

export function parseRepositoryUrl(repoUrl: string): RepositoryUrl {
  const value = repoUrl.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters in repository URLs.
  if (!value || /[\0-\x1f\x7f\\]/.test(value)) {
    throw new SourceControlUrlError("Invalid repository URL.");
  }

  let url: URL;
  try {
    const scp = !value.includes("://")
      ? /^(?:[^@\s/:]+@)?([^:\s/]+):(.+)$/.exec(value)
      : null;
    url = new URL(scp ? `ssh://${scp[1]}/${scp[2].replace(/^\/+/, "")}` : value);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    throw new SourceControlUrlError("Repository URL must be an HTTP(S) or SSH repository address.");
  }
  if (!["http:", "https:", "ssh:"].includes(url.protocol)) {
    throw new SourceControlUrlError("Repository URL must use HTTP(S) or SSH.");
  }

  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  let segments: string[];
  try {
    segments = path.split("/").map(segment => decodeURIComponent(segment));
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error;
    }
    throw new SourceControlUrlError("Repository URL contains invalid path encoding.");
  }
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  if (segments.some(segment =>
    // eslint-disable-next-line no-control-regex -- Reject control characters in repository paths.
    !segment || segment === "." || segment === ".." || /[/\\\0-\x1f\x7f]/.test(segment)
  )) {
    throw new SourceControlUrlError("Repository URL must identify a valid repository path.");
  }

  const ssh = url.protocol === "ssh:";
  return {
    hostname: url.hostname.toLowerCase(),
    origin: ssh ? `https://${url.hostname.toLowerCase()}` : url.origin,
    segments,
    ssh,
  };
}

export function repositoryWebUrl(repository: RepositoryUrl, segments = repository.segments): string {
  return `${repository.origin}/${segments.map(segment => encodeURIComponent(segment)).join("/")}`;
}

export function encodeRepositoryFilePath(filePath: string): string {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some(segment => segment === "." || segment === "..")) {
    throw new SourceControlUrlError("Repository file path must not be empty or contain traversal segments.");
  }
  return segments.map(segment => encodeURIComponent(segment)).join("/");
}
