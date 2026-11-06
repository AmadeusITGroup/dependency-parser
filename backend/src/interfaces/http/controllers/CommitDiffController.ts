import { Request, Response } from "express";

import { CommitDiffDTO } from "../../../application/dto/CommitDiffDTO";
import {
  CommitComparisonInputError,
  CommitComparisonProjectNotFoundError,
  CompareVersionCommits,
} from "../../../application/use-cases/CompareVersionCommits";
import { GitRefNotFoundError } from "../../../domain/interfaces/IGitClient";
import { SourceControlUrlError } from "../../../domain/interfaces/ISourceControlProvider";
import { Logger, logger } from "../../../utils/logger";

export class CommitDiffController {
  constructor(
    private readonly compareVersionCommits: CompareVersionCommits,
    private readonly log: Pick<Logger, "error"> = logger
  ) {}

  compareCommits = async (req: Request, res: Response): Promise<void> => {
    const projectId = this.readString(req.params.projectId);
    const fromVersion = this.readString(req.query.fromVersion);
    const toVersion = this.readString(req.query.toVersion);
    if (!projectId || !fromVersion || !toVersion) {
      res.status(400).json({
        error: '"projectId", "fromVersion", and "toVersion" are required.',
      });
      return;
    }

    try {
      const result = await this.compareVersionCommits.execute(projectId, fromVersion, toVersion);
      res.json(CommitDiffDTO.fromResult(result));
    } catch (error) {
      if (error instanceof CommitComparisonInputError) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof CommitComparisonProjectNotFoundError || error instanceof GitRefNotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        this.log.error({ err: error, projectId, fromVersion, toVersion }, "Commit comparison failed.");
        res.status(500).json({
          error: error instanceof SourceControlUrlError
            ? error.message : "Unable to compare commit histories. Check repository access and try again.",
        });
      }
    }
  };

  private readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
}
