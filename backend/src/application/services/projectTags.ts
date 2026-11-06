import path from "node:path";

import { IGitClient } from "../../domain/interfaces/IGitClient";
import { Project } from "../../domain/models/Project";
import { Version } from "../../domain/models/Version";

export function getProjectClonePath(cloneRoot: string, projectId: string): string {
  return path.join(cloneRoot, projectId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

export function filterVersionsByTagPattern(
  versions: Version[],
  tagPattern: string | null
): Version[] {
  if (!tagPattern) {
    return versions;
  }
  const pattern = new RegExp(tagPattern);
  return versions.filter(version => pattern.test(version.version));
}

export async function readProjectTags(
  gitClient: IGitClient,
  project: Project,
  cloneRoot?: string
): Promise<Version[]> {
  const targetPath = cloneRoot ? getProjectClonePath(cloneRoot, project.id) : undefined;
  const repoPath = await gitClient.syncTags(project.repoUrl, targetPath, project.tagPattern);
  try {
    return filterVersionsByTagPattern(await gitClient.getTags(repoPath), project.tagPattern);
  } finally {
    if (targetPath === undefined) {
      await gitClient.remove(repoPath);
    }
  }
}
