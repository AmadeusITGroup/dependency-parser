import { Request, Response } from "express";

import { FindRootVersionDTO } from "../../../application/dto/FindRootVersionDTO";
import { DependencyTreeMetadataService } from "../../../application/services/DependencyTreeMetadataService";
import {
  FindRootVersion,
  VersionSearchInputError,
} from "../../../application/use-cases/FindRootVersion";

export class VersionSearchController {
  constructor(
    private readonly findRootVersion: FindRootVersion,
    private readonly treeMetadata: DependencyTreeMetadataService
  ) {}

  findVersion = async (req: Request, res: Response): Promise<void> => {
    const projectId = this.readString(req.params.projectId);
    const dependencyProjectId = this.readString(req.query.dependencyProjectId);
    const minimumVersion = this.readString(req.query.minimumVersion);
    if (!projectId || !dependencyProjectId || !minimumVersion) {
      res.status(400).json({
        error: '"projectId", "dependencyProjectId", and "minimumVersion" are required.',
      });
      return;
    }

    try {
      const result = await this.findRootVersion.execute(
        projectId, dependencyProjectId, minimumVersion
      );
      const response = FindRootVersionDTO.fromResult(result);
      if (response.match) {
        await this.treeMetadata.addCreationDates(response.match.dependencyTree);
      }
      res.json(response);
    } catch (error) {
      res.status(error instanceof VersionSearchInputError ? 400 : 500).json({
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    }
  };

  private readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
}