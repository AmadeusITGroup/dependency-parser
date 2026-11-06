import { Version } from "./Version";

export class ProjectTag {
  constructor(
    public projectId: string,
    public name: string,
    public commitHash: string | null,
    public creationDate: Date | null,
    public removed = false
  ) {}
}

export function reconcileProjectTags(
  projectId: string,
  storedTags: ProjectTag[],
  discoveredTags: Version[],
  tagPattern: string | null = null
): ProjectTag[] {
  const pattern = tagPattern ? new RegExp(tagPattern) : null;
  const matchingTags = discoveredTags.filter(tag => !pattern || pattern.test(tag.version));
  const currentTags = new Map(matchingTags.map(tag => [tag.version, tag]));
  const result = matchingTags.map(tag => new ProjectTag(
    projectId,
    tag.version,
    tag.commitHash,
    tag.creationDate,
    false
  ));

  for (const tag of storedTags) {
    if ((!pattern || pattern.test(tag.name)) && !currentTags.has(tag.name)) {
      result.push(new ProjectTag(
        projectId,
        tag.name,
        tag.commitHash,
        tag.creationDate,
        true
      ));
    }
  }

  return result;
}