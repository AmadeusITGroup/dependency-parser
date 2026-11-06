import path from "node:path";

import { IDataStore } from "../../domain/interfaces/IDataStore";
import { IGitClient } from "../../domain/interfaces/IGitClient";
import { IProjectRegistry } from "../../domain/interfaces/IProjectRegistry";
import { findProject } from "../../domain/models/Project";
import { DependencyNodeDTO, DependencyTreeDTO } from "../dto/DependencyTreeDTO";

export class DependencyTreeMetadataService {
  constructor(
    private readonly projectRegistry: IProjectRegistry,
    private readonly gitClient: IGitClient,
    private readonly cloneRoot: string,
    private readonly dataStore?: IDataStore
  ) {}

  async addCreationDates(tree: DependencyTreeDTO): Promise<DependencyTreeDTO> {
    const nodesByProject = new Map<string, DependencyNodeDTO[]>();
    const collect = (node: DependencyNodeDTO): void => {
      if (node.version && node.version !== "unknown") {
        const nodes = nodesByProject.get(node.projectId) ?? [];
        nodes.push(node);
        nodesByProject.set(node.projectId, nodes);
      }
      node.dependencies.forEach(collect);
    };
    collect(tree.tree);

    await Promise.all([...nodesByProject].map(async ([projectId, nodes]) => {
      const storedTags = await this.dataStore?.getProjectTags(projectId) ?? [];
      const dates = new Map(storedTags.map(tag => [tag.name, tag.creationDate]));
      if (nodes.some(node => !dates.has(node.version))) {
        const project = this.projectRegistry.getProject(projectId)
          ?? findProject(projectId, this.projectRegistry.getAllProjects());
        if (project) {
          const clonePath = path.join(this.cloneRoot, projectId.replace(/[^A-Za-z0-9_-]/g, "_"));
          if (await this.gitClient.hasClone(project.repoUrl, clonePath)) {
            const localTags = await this.gitClient.getTags(clonePath);
            for (const tag of localTags) {
              if (!dates.has(tag.version)) {
                dates.set(tag.version, tag.creationDate);
              }
            }
          }
        }
      }
      for (const node of nodes) {
        node.creationDate = dates.get(node.version)?.toISOString() ?? null;
      }
    }));
    return tree;
  }
}
