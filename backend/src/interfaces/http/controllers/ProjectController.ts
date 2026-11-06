import { Request, Response } from "express";

import { ProjectDefinitionDTO } from "../../../application/dto/ProjectDefinitionDTO";
import {
  ProjectNameConflictError,
  ProjectService,
} from "../../../application/services/ProjectService";

export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  getAllProjects = (_req: Request, res: Response): void => {
    res.json({
      projects: this.projectService.getAllProjects().map(ProjectDefinitionDTO.fromDomain),
    });
  };

  getProject = (req: Request, res: Response): void => {
    const projectId = this.readString(req.params.projectId);
    const project = projectId ? this.projectService.getProject(projectId) : null;

    if (!project) {
      res.status(404).json({ error: `Project "${projectId ?? ""}" was not found.` });
      return;
    }

    res.json(ProjectDefinitionDTO.fromDomain(project));
  };

  createProject = async (req: Request, res: Response): Promise<void> => {
    try {
      const project = await this.projectService.createProject(
        ProjectDefinitionDTO.toDomain(req.body)
      );
      res.status(201).json(ProjectDefinitionDTO.fromDomain(project));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      res.status(this.statusCodeFor(error)).json({ error: message });
    }
  };

  updateProject = async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = this.readString(req.params.projectId);
      const project = projectId
        ? await this.projectService.updateProject(
            projectId,
            ProjectDefinitionDTO.toDomain(req.body)
          )
        : null;

      if (!project) {
        res.status(404).json({ error: `Project "${projectId ?? ""}" was not found.` });
        return;
      }

      res.json(ProjectDefinitionDTO.fromDomain(project));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      res.status(this.statusCodeFor(error)).json({ error: message });
    }
  };

  deleteProject = async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = this.readString(req.params.projectId);
      const deleted = projectId ? await this.projectService.deleteProject(projectId) : false;

      if (!deleted) {
        res.status(404).json({ error: `Project "${projectId ?? ""}" was not found.` });
        return;
      }

      res.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      res.status(this.statusCodeFor(error)).json({ error: message });
    }
  };

  private readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }

  private statusCodeFor(error: unknown): number {
    if (error instanceof ProjectNameConflictError) return 409;
    if (error instanceof Error && error.message === "Project persistence is not configured.") {
      return 503;
    }
    return 400;
  }
}