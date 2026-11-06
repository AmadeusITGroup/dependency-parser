import { DependencyTree } from "../models/DependencyTree";
import { Project } from "../models/Project";
import { ProjectTag } from "../models/ProjectTag";
import { Version } from "../models/Version";

export interface IDataStore {
  /**
   * Persists the dependency tree for a given project version.
   */
  saveDependencyTree(
    projectId: string,
    version: string,
    tree: DependencyTree,
    commitHash?: string | null,
    project?: Project
  ): Promise<void>;

  /**
   * Retrieves a previously stored dependency tree.
   */
  getDependencyTree(
    projectId: string,
    version: string,
    commitHash?: string | null,
    allowHistorical?: boolean
  ): Promise<DependencyTree | null>;

  /**
   * Checks whether a dependency tree already exists.
   * Useful for caching and avoiding recomputation.
   */
  hasDependencyTree(
    projectId: string,
    version: string
  ): Promise<boolean>;

  /**
   * Returns all known versions for a given project.
   */
  getAvailableVersions(projectId: string): Promise<string[]>;

  getProjectTags(projectId: string): Promise<ProjectTag[]>;

  getProjectTag(projectId: string, name: string): Promise<ProjectTag | null>;

  syncProjectTags(
    projectId: string,
    tags: Version[],
    tagPattern?: string | null
  ): Promise<ProjectTag[]>;

  /**
   * Retrieves all known projects.
   */
  getAllProjects(): Promise<Project[]>;

  /**
  * Retrieves a specific project by its ID.
   */
  getProjectById(projectId: string): Promise<Project | null>;

  /**
   * Save a new Project structure
   */
  saveProject(project: Project): Promise<void>;

  /**
   * Optional: Remove stored data (cleanup / refresh use case)
   */
  deleteProject(projectId: string): Promise<void>;

  close?(): Promise<void>;
}