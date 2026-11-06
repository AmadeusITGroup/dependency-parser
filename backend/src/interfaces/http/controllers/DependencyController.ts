import { Request, Response } from "express";

import { DependencyTreeDTO } from "../../../application/dto/DependencyTreeDTO";
import { DependencyTreeMetadataService } from "../../../application/services/DependencyTreeMetadataService";
import { ResolveProjectDependencies } from "../../../application/use-cases/ResolveProjectDependencies";

export class DependencyController {
  constructor(
    private readonly resolveProjectDependencies: ResolveProjectDependencies,
    private readonly treeMetadata: DependencyTreeMetadataService
  ) {}

  resolveDependencies = async (req: Request, res: Response): Promise<void> => {
    const projectId =
      this.readString(req.params.projectId) ?? this.readString(req.query.projectId);
    const version =
      this.readString(req.params.version) ?? this.readString(req.query.version);

    if (!projectId || !version) {
      res.status(400).json({
        error: 'Both "projectId" and "version" are required.',
      });
      return;
    }

    try {
      const dependencyTree = await this.resolveProjectDependencies.execute(
        projectId,
        version
      );

      res.json(await this.treeMetadata.addCreationDates(
        DependencyTreeDTO.fromDomain(projectId, version, dependencyTree)
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      const statusCode = this.resolveStatusCode(message);

      res.status(statusCode).json({ error: message });
    }
  };

  private readString(value: unknown): string | null {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }

    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim() !== "") {
      return value[0].trim();
    }

    return null;
  }

  private resolveStatusCode(message: string): number {
    if (
      message.includes("not registered") ||
      message.includes("was not found") ||
      message.includes("No parser available") ||
      message.includes("did not match any file") ||
      message.includes("has no saved dependency tree")
    ) {
      return 404;
    }

    if (message.includes("required")) {
      return 400;
    }

    return 500;
  }
}
