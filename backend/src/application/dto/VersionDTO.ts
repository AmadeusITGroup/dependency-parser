import { Version } from "../../domain/models/Version";

export type VersionDTO = {
  version: string;
  creationDate: string | null;
  commitHash: string | null;
  removed: boolean;
  hasDependencyTree: boolean;
};

export function toVersionDTO(version: Version): VersionDTO {
  return {
    version: version.version,
    creationDate: version.creationDate?.toISOString() ?? null,
    commitHash: version.commitHash,
    removed: version.removed,
    hasDependencyTree: version.hasDependencyTree,
  };
}