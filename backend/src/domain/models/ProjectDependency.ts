import type { Project } from "./Project";

export class ProjectDependency {
  constructor(
    public project: Project,
    public manifestPath: string | null,
    public versionReference: string | RegExp | null
  ) {}
}