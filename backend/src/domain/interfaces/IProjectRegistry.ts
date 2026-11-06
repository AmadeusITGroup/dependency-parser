import { Project } from "../models/Project";

export interface IProjectRegistry {
  /**
   * Returns the configuration for a given project.
   */
  getProject(projectId: string): Project | null;

  /**
   * Returns all registered projects.
   */
  getAllProjects(): Project[];

  /**
   * Checks whether a project is registered.
   */
  hasProject(projectId: string): boolean;

  /**
   * Adds or replaces a project configuration.
   */
  registerProject(project: Project): void;

  /**
   * Removes a project configuration from the registry.
   */
  removeProject(projectId: string): void;
}