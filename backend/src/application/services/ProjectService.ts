import { randomUUID } from "node:crypto";

import { IDataStore } from "../../domain/interfaces/IDataStore";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { Project } from "../../domain/models/Project";
import { ProjectDependency } from "../../domain/models/ProjectDependency";

export class ProjectNameConflictError extends Error {}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectService {
  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly dataStore: IDataStore | undefined
  ) {}

  getAllProjects(): Project[] {
    return this.projectRegistry.getAllProjects();
  }

  getProject(projectId: string): Project | null {
    return this.projectRegistry.getProject(projectId);
  }

  async createProject(project: Project): Promise<Project> {
    if (!this.dataStore) {
      throw new Error("Project persistence is not configured.");
    }

    this.validateProject(project);
    const usedIds = this.collectProjectIds(this.projectRegistry.getAllProjects());
    const createdProject = this.withUniqueIds(
      project,
      this.createProjectId(usedIds),
      usedIds
    );
    await this.dataStore.saveProject(createdProject);
    this.projectRegistry.registerProject(createdProject);
    return createdProject;
  }

  async updateProject(projectId: string, project: Project): Promise<Project | null> {
    if (!this.dataStore) {
      throw new Error("Project persistence is not configured.");
    }
    if (!this.projectRegistry.hasProject(projectId)) {
      return null;
    }

    this.validateProject(project, projectId);
    const usedIds = this.collectProjectIds(
      this.projectRegistry
        .getAllProjects()
        .filter(existingProject => existingProject.id !== projectId)
    );
    const updatedProject = this.withUniqueIds(project, projectId, usedIds);
    await this.dataStore.saveProject(updatedProject);
    this.projectRegistry.registerProject(updatedProject);
    return updatedProject;
  }

  async deleteProject(projectId: string): Promise<boolean> {
    if (!this.dataStore) {
      throw new Error("Project persistence is not configured.");
    }
    if (!this.projectRegistry.hasProject(projectId)) {
      return false;
    }

    await this.dataStore.deleteProject(projectId);
    this.projectRegistry.removeProject(projectId);
    return true;
  }

  private createProjectId(usedIds: Set<string>): string {
    let projectId = randomUUID();
    while (usedIds.has(projectId)) {
      projectId = randomUUID();
    }
    usedIds.add(projectId);
    return projectId;
  }

  private collectProjectIds(projects: Project[]): Set<string> {
    const projectIds = new Set<string>();

    const collect = (project: Project): void => {
      projectIds.add(project.id);
      for (const dependency of project.dependencies ?? []) {
        collect(dependency.project);
      }
    };

    projects.forEach(collect);
    return projectIds;
  }

  private validateProject(project: Project, updatedProjectId?: string): void {
    const normalizedProjectName = this.normalizeName(project.name);
    const hasConflictingName = this.projectRegistry
      .getAllProjects()
      .some(
        existingProject =>
          existingProject.id !== updatedProjectId &&
          this.normalizeName(existingProject.name) === normalizedProjectName
      );

    if (hasConflictingName) {
      throw new ProjectNameConflictError(
        `A project named "${project.name}" already exists.`
      );
    }

    this.validateDependencyNames(project);
  }

  private validateDependencyNames(project: Project): void {
    const dependencyNames = new Set<string>();

    for (const dependency of project.dependencies ?? []) {
      const normalizedName = this.normalizeName(dependency.project.name);
      if (dependencyNames.has(normalizedName)) {
        throw new Error(
          `Project "${project.name}" contains more than one direct dependency named "${dependency.project.name}".`
        );
      }

      dependencyNames.add(normalizedName);
      this.validateDependencyNames(dependency.project);
    }
  }

  private normalizeName(name: string): string {
    return name.trim().toLocaleLowerCase();
  }

  private withUniqueIds(
    project: Project,
    projectId: string,
    usedIds: Set<string>
  ): Project {
    usedIds.add(projectId);
    return new Project(
      projectId,
      project.name,
      project.repoUrl,
      project.description,
      project.dependencies?.map(dependency => {
        const requestedId = dependency.project.id.trim();
        const dependencyId =
          UUID_PATTERN.test(requestedId) && !usedIds.has(requestedId)
            ? requestedId
            : this.createProjectId(usedIds);

        return new ProjectDependency(
          this.withUniqueIds(dependency.project, dependencyId, usedIds),
          dependency.manifestPath,
          dependency.versionReference
        );
      }) ?? null,
      project.tagPattern
    );
  }
}