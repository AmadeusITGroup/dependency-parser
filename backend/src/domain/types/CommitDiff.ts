export type CommitSummary = {
  hash: string;
  subject: string;
  committedAt: string;
};

export type CommitDiff = {
  fromCommitHash: string;
  toCommitHash: string;
  fromOnly: CommitSummary[];
  toOnly: CommitSummary[];
};

export type CommitComparisonTagHints = {
  readonly fromCommitHash: string;
  readonly toCommitHash: string;
};
