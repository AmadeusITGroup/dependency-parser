import { CompareVersionCommitsResult } from "../use-cases/CompareVersionCommits";

export type CommitDTO = {
  hash: string;
  subject: string;
  committedAt: string;
  url: string;
};

export class CommitDiffDTO {
  constructor(
    public readonly projectId: string,
    public readonly projectName: string,
    public readonly fromVersion: string,
    public readonly toVersion: string,
    public readonly fromCommitHash: string,
    public readonly toCommitHash: string,
    public readonly fromOnly: CommitDTO[],
    public readonly toOnly: CommitDTO[]
  ) {}

  static fromResult(result: CompareVersionCommitsResult): CommitDiffDTO {
    const mapCommit = ({ hash, subject, committedAt, url }: CommitDTO): CommitDTO => ({
      hash, subject, committedAt, url,
    });
    return new CommitDiffDTO(
      result.projectId, result.projectName, result.fromVersion, result.toVersion,
      result.fromCommitHash, result.toCommitHash,
      result.fromOnly.map(mapCommit), result.toOnly.map(mapCommit)
    );
  }
}
