import { ProjectDependency } from "./ProjectDependency";

export class Project {
  constructor(
    public id: string,
    public name: string,
    public repoUrl: string,
    public description: string | null = null,
    public dependencies: ProjectDependency[] | null = null,
    public tagPattern: string | null = null
  ) {}
}

export function findProject(projectId: string, projects: readonly Project[]): Project | null {
  const pending = [...projects];
  const visited = new Set<Project>();
  while (pending.length > 0) {
    const project = pending.pop()!;
    if (visited.has(project)) {
      continue;
    }
    visited.add(project);
    if (project.id === projectId) {
      return project;
    }
    pending.push(...(project.dependencies ?? []).map(dependency => dependency.project));
  }
  return null;
}
