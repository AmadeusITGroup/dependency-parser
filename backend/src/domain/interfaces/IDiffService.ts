// src/domain/interfaces/IDiffService.ts

import { DiffResult } from "../types/DiffResult";

export interface IDiffService {
  /**
   * Compares two versions of a repository (tags, commits, branches)
   * and returns a structured diff result.
   */
  compareVersions(
    repoUrl: string,
    fromRef: string,
    toRef: string
  ): Promise<DiffResult>;

  /**
   * Optional helper: returns a URL for viewing the comparison
   * in the source control provider (GitHub, Bitbucket, etc.).
   */
  getCompareUrl?(
    repoUrl: string,
    fromRef: string,
    toRef: string
  ): string;
}