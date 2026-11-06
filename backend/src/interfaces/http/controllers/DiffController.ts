import { Request, Response } from "express";

import { DiffResultDTO } from "../../../application/dto/DiffResultDTO";
import { ComparePackageVersions } from "../../../application/use-cases/ComparePackageVersions";

export class DiffController {
  constructor(private readonly comparePackageVersions: ComparePackageVersions) {}

  compareVersions = async (req: Request, res: Response): Promise<void> => {
    const projectId =
      this.readString(req.params.projectId) ?? this.readString(req.query.projectId);
    const fromVersion =
      this.readString(req.params.fromVersion) ??
      this.readString(req.query.fromVersion) ??
      this.readString(req.query.fromRef);
    const toVersion =
      this.readString(req.params.toVersion) ??
      this.readString(req.query.toVersion) ??
      this.readString(req.query.toRef);

    if (!projectId || !fromVersion || !toVersion) {
      res.status(400).json({
        error: '"projectId", "fromVersion", and "toVersion" are required.',
      });
      return;
    }

    try {
      const result = await this.comparePackageVersions.execute(
        projectId,
        fromVersion,
        toVersion
      );

      res.json(
        DiffResultDTO.fromDomain(
          result.projectId,
          result.projectName,
          result.fromVersion,
          result.toVersion,
          result.diffResult,
          result.compareUrl
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      res.status(this.resolveStatusCode(message)).json({ error: message });
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
    if (message.includes("not registered")) {
      return 404;
    }

    if (message.includes("required") || message.includes("not configured")) {
      return 400;
    }

    return 500;
  }
}
