import { existsSync, readFileSync } from "node:fs";

import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { Project } from "../../domain/models/Project";
import { ProjectDependency } from "../../domain/models/ProjectDependency";

export class ProjectRegistry implements IProjectRegistry {
  private readonly projects = new Map<string, Project>();

  constructor(projects: Project[] = [], registryFilePath?: string) {
    for (const project of [...projects, ...this.readProjectsFromFile(registryFilePath)]) {
      this.projects.set(project.id, project);
    }
  }

  getProject(projectId: string): Project | null {
    return this.projects.get(projectId) ?? null;
  }

  getAllProjects(): Project[] {
    return Array.from(this.projects.values());
  }

  hasProject(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  registerProject(project: Project): void {
    this.projects.set(project.id, project);
  }

  removeProject(projectId: string): void {
    this.projects.delete(projectId);
  }

  private readProjectsFromFile(registryFilePath?: string): Project[] {
    if (!registryFilePath || !existsSync(registryFilePath)) {
      return [];
    }

    const content = readFileSync(registryFilePath, "utf8");
    const parsedValue: unknown = JSON.parse(content);

    if (!Array.isArray(parsedValue)) {
      throw new Error(`Project registry file "${registryFilePath}" must contain an array.`);
    }

    return parsedValue.map(project => this.toProject(project));
  }

  private toProject(value: unknown): Project {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Each project definition must be an object.");
    }

    const project = value as {
      id?: unknown;
      name?: unknown;
      repoUrl?: unknown;
      description?: unknown;
      dependencies?: unknown;
      tagPattern?: unknown;
    };

    if (
      typeof project.id !== "string" ||
      project.id.trim() === "" ||
      typeof project.name !== "string" ||
      typeof project.repoUrl !== "string"
    ) {
      throw new Error("Each project definition must include string id, name, and repoUrl fields.");
    }

    return new Project(
      project.id,
      project.name,
      project.repoUrl,
      typeof project.description === "string" ? project.description : null,
      this.readDependencies(project.dependencies),
      typeof project.tagPattern === "string" && project.tagPattern !== "" ? project.tagPattern : null
    );
  }

  private readDependencies(value: unknown): ProjectDependency[] | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (!Array.isArray(value)) {
      throw new Error("Project dependencies must be an array or null.");
    }

    return value.map(dependency => {
      if (typeof dependency !== "object" || dependency === null || Array.isArray(dependency)) {
        throw new Error("Each project dependency must be an object.");
      }

      const edge = dependency as {
        project?: unknown;
        manifestPath?: unknown;
        versionReference?: unknown;
      };
      if (edge.project === undefined) {
        throw new Error("Each project dependency must include a project.");
      }

      return new ProjectDependency(
        this.toProject(edge.project),
        this.readOptionalString(edge.manifestPath, "manifestPath"),
        this.readVersionReference(edge.versionReference)
      );
    });
  }

  private readOptionalString(value: unknown, fieldName: string): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== "string") {
      throw new Error(`Project ${fieldName} must be a string or null.`);
    }

    return value;
  }

  private readVersionReference(value: unknown): string | RegExp | null {
    if (value === undefined || value === null || typeof value === "string") {
      return value ?? null;
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Project versionReference must be a string, regular expression, or null.");
    }

    const expression = value as { pattern?: unknown; flags?: unknown };
    if (typeof expression.pattern !== "string" || typeof expression.flags !== "string") {
      throw new Error("A regular-expression versionReference must include string pattern and flags.");
    }

    try {
      return new RegExp(expression.pattern, expression.flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid regular expression";
      throw new Error(`Invalid versionReference regular expression: ${message}`, { cause: error });
    }
  }
}
