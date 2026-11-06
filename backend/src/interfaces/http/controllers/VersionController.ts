import { Request, Response } from "express";

import { toVersionDTO } from "../../../application/dto/VersionDTO";
import { GetDependencyVersion } from "../../../application/use-cases/GetDependencyVersion";

export class VersionController {
  constructor(private readonly getDependencyVersion: GetDependencyVersion) {}

  getAvailableVersions = async (req: Request, res: Response): Promise<void> => {
    const projectId =
      this.readString(req.params.projectId) ?? this.readString(req.query.projectId);

    if (!projectId) {
      res.status(400).json({ error: '"projectId" is required.' });
      return;
    }

    try {
      const versions = await this.getDependencyVersion.getAvailableVersions(
        projectId,
        this.readString(req.query.forceRefresh) === "true"
      );

      const latest = versions.find(version => !version.removed);
      res.json({
        projectId,
        versions: versions.map(toVersionDTO),
        latest: latest ? toVersionDTO(latest) : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      res.status(this.resolveStatusCode(message)).json({ error: message });
    }
  };

  getVersion = async (req: Request, res: Response): Promise<void> => {
    const projectId =
      this.readString(req.params.projectId) ?? this.readString(req.query.projectId);
    const requestedVersion =
      this.readString(req.params.requestedVersion) ??
      this.readString(req.query.requestedVersion) ??
      this.readString(req.query.version);

    if (!projectId || !requestedVersion) {
      res.status(400).json({
        error: '"projectId" and "requestedVersion" are required.',
      });
      return;
    }

    try {
      const result = await this.getDependencyVersion.execute(projectId, requestedVersion);

      if (!result.resolvedVersion) {
        res.status(404).json({
          error: `Version "${result.requestedVersion}" was not found for project "${result.projectId}".`,
        });
        return;
      }

      res.json({ ...result, resolvedVersion: toVersionDTO(result.resolvedVersion) });
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

    if (message.includes("required")) {
      return 400;
    }

    return 500;
  }
}
