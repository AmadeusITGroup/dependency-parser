import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_NPM_RANGE_RESOLUTION_TTL_MS } from "../../config/app.config";
import { IDataStore } from "../../domain/interfaces/IDataStore";
import { DependencyTree } from "../../domain/models/DependencyTree";
import { Project } from "../../domain/models/Project";
import { ProjectTag, reconcileProjectTags } from "../../domain/models/ProjectTag";
import { Version } from "../../domain/models/Version";
import {
  deserializeDependencyNode,
  deserializeProject,
  deserializeProjectTag,
  hasExpiredVersionResolution,
  serializeDependencyNode,
  serializeProject,
  serializeProjectConfiguration,
  serializeProjectTag,
  SerializedProject,
  SerializedProjectTag,
  SerializedTreeSnapshot,
} from "./DataStoreSerialization";

type DependencyTreeStoreDocument = {
  projects: Record<
    string,
    {
      versions: Record<string, SerializedTreeSnapshot[]>;
    }
  >;
};

type TagStoreDocument = {
  projects: Record<string, SerializedProjectTag[]>;
};

type ProjectStoreDocument = {
  projects: Record<string, SerializedProject>;
};
export class JsonFileDataStore implements IDataStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencyTreeFilePath: string,
    private readonly projectFilePath: string,
    private readonly tagFilePath = path.join(path.dirname(dependencyTreeFilePath), "tags.json"),
    private readonly rangeResolutionTtlMs = DEFAULT_NPM_RANGE_RESOLUTION_TTL_MS
  ) {}
  async getAllProjects(): Promise<Project[]> {
    return this.enqueueOperation(async () => {
      const document = await this.readProjectDocument();
      return Object.values(document.projects).map(project => deserializeProject(project));
    });
  }
  async getProjectById(projectId: string): Promise<Project | null> {
    return this.enqueueOperation(async () => {
      const document = await this.readProjectDocument();
      const serializedProject = document.projects[projectId] ?? null;

      if (!serializedProject) {
        return null;
      }

      return deserializeProject(serializedProject);
    });
  }

  async saveProject(project: Project): Promise<void> {
    return this.enqueueOperation(async () => {
      const document = await this.readProjectDocument();
      const serializedProject = serializeProject(project);
      if (document.projects[project.id]?.repoUrl !== undefined &&
        document.projects[project.id].repoUrl !== project.repoUrl) {
        const dependencyDocument = await this.readDependencyDocument();
        const tagDocument = await this.readTagDocument();
        delete dependencyDocument.projects[project.id];
        delete tagDocument.projects[project.id];
        await this.writeDependencyDocument(dependencyDocument);
        await this.writeTagDocument(tagDocument);
      }
      document.projects[project.id] = serializedProject;
      await this.writeProjectDocument(document);
    });
  }

  async saveDependencyTree(
    projectId: string,
    version: string,
    tree: DependencyTree,
    commitHash: string | null = null,
    project?: Project
  ): Promise<void> {
    return this.enqueueOperation(async () => {
      const document = await this.readDependencyDocument();
      const projectDocument = await this.readProjectDocument();

      if (!document.projects[projectId]) {
        document.projects[projectId] = { versions: {} };
      }

      const snapshots = document.projects[projectId].versions[version] ?? [];
      document.projects[projectId].versions[version] = [
        ...snapshots.filter(snapshot => snapshot.commitHash !== commitHash),
        {
          root: serializeDependencyNode(tree.root),
          commitHash,
          projectConfiguration: serializeProjectConfiguration(
            project ? serializeProject(project) : projectDocument.projects[projectId] ?? null
          ),
        },
      ];
      await this.writeDependencyDocument(document);
    });
  }

  async getDependencyTree(
    projectId: string,
    version: string,
    commitHash?: string | null,
    allowHistorical = false
  ): Promise<DependencyTree | null> {
    return this.enqueueOperation(async () => {
      const snapshot = await this.readTreeSnapshot(projectId, version, commitHash, allowHistorical);
      return snapshot ? new DependencyTree(deserializeDependencyNode(snapshot.root)) : null;
    });
  }

  async hasDependencyTree(projectId: string, version: string): Promise<boolean> {
    return this.enqueueOperation(async () => {
      return (await this.readTreeSnapshot(projectId, version)) !== null;
    });
  }

  async getAvailableVersions(projectId: string): Promise<string[]> {
    return this.enqueueOperation(async () => {
      const [document, projectDocument, tagDocument] = await Promise.all([
        this.readDependencyDocument(), this.readProjectDocument(), this.readTagDocument(),
      ]);
      const projectConfiguration = serializeProjectConfiguration(projectDocument.projects[projectId] ?? null);
      const tags = new Map((tagDocument.projects[projectId] ?? []).map(tag => [tag.name, tag]));
      return Object.entries(document.projects[projectId]?.versions ?? {})
        .filter(([version, snapshots]) => {
          const tag = tags.get(version);
          return snapshots.some(snapshot =>
            (!tag || snapshot.commitHash === tag.commitHash) &&
            (tag?.removed || (snapshot.projectConfiguration === projectConfiguration &&
              !hasExpiredVersionResolution(snapshot.root, this.rangeResolutionTtlMs)))
          );
        })
        .map(([version]) => version)
        .sort((left, right) =>
          right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" })
        );
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    return this.enqueueOperation(async () => {
      const [dependencyDocument, projectDocument, tagDocument] = await Promise.all([
        this.readDependencyDocument(),
        this.readProjectDocument(),
        this.readTagDocument(),
      ]);
      delete dependencyDocument.projects[projectId];
      delete projectDocument.projects[projectId];
      delete tagDocument.projects[projectId];
      await Promise.all([
        this.writeDependencyDocument(dependencyDocument),
        this.writeProjectDocument(projectDocument),
        this.writeTagDocument(tagDocument),
      ]);
    });
  }

  async getProjectTags(projectId: string): Promise<ProjectTag[]> {
    return this.enqueueOperation(async () => {
      const document = await this.readTagDocument();
      return (document.projects[projectId] ?? []).map(deserializeProjectTag);
    });
  }

  async getProjectTag(projectId: string, name: string): Promise<ProjectTag | null> {
    return (await this.getProjectTags(projectId)).find(tag => tag.name === name) ?? null;
  }

  async syncProjectTags(
    projectId: string,
    tags: Version[],
    tagPattern: string | null = null
  ): Promise<ProjectTag[]> {
    return this.enqueueOperation(async () => {
      const document = await this.readTagDocument();
      const updatedTags = reconcileProjectTags(
        projectId,
        (document.projects[projectId] ?? []).map(deserializeProjectTag),
        tags,
        tagPattern
      );
      document.projects[projectId] = updatedTags.map(serializeProjectTag);
      await this.writeTagDocument(document);
      return updatedTags;
    });
  }

  private async readTreeSnapshot(
    projectId: string,
    version: string,
    commitHash?: string | null,
    allowHistorical = false
  ): Promise<SerializedTreeSnapshot | null> {
    const document = await this.readDependencyDocument();
    const projectDocument = await this.readProjectDocument();
    const projectConfiguration = serializeProjectConfiguration(projectDocument.projects[projectId] ?? null);
    return [...(document.projects[projectId]?.versions[version] ?? [])].reverse().find(snapshot =>
      (commitHash === undefined || snapshot.commitHash === commitHash) &&
      (allowHistorical || (snapshot.projectConfiguration === projectConfiguration &&
        !hasExpiredVersionResolution(snapshot.root, this.rangeResolutionTtlMs)))
    ) ?? null;
  }

  private async readTagDocument(): Promise<TagStoreDocument> {
    try {
      const content = await readFile(this.tagFilePath, "utf8");
      const document: unknown = JSON.parse(content);
      if (typeof document !== "object" || document === null || !("projects" in document)) {
        throw new Error(`Invalid tag datastore format in "${this.tagFilePath}".`);
      }
      return document as TagStoreDocument;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { projects: {} };
      }
      throw error;
    }
  }

  private async writeTagDocument(document: TagStoreDocument): Promise<void> {
    await mkdir(path.dirname(this.tagFilePath), { recursive: true });
    await writeFile(this.tagFilePath, JSON.stringify(document, null, 2), "utf8");
  }

  private enqueueOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const next = this.operationQueue.then(operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async readDependencyDocument(): Promise<DependencyTreeStoreDocument> {
    try {
      const content = await readFile(this.dependencyTreeFilePath, "utf8");
      const parsedValue: unknown = JSON.parse(content);

      if (!this.isDependencyStoreDocument(parsedValue)) {
        throw new Error(`Invalid datastore format in "${this.dependencyTreeFilePath}".`);
      }

      return parsedValue;
    } catch (error) {
      const readError = error as NodeJS.ErrnoException;
      if (readError.code === "ENOENT") {
        return { projects: {} };
      }

      throw error;
    }
  }

  private async readProjectDocument(): Promise<ProjectStoreDocument> {
    try {
      const content = await readFile(this.projectFilePath, "utf8");
      const parsedValue: unknown = JSON.parse(content);

      if (!this.isProjectStoreDocument(parsedValue)) {
        throw new Error(`Invalid project datastore format in "${this.projectFilePath}".`);
      }
      return parsedValue;
    } catch (error) {
      const readError = error as NodeJS.ErrnoException;
      if (readError.code === "ENOENT") {
        return { projects: {} };
      }
      throw error;
    }
  }

  private async writeDependencyDocument(document: DependencyTreeStoreDocument): Promise<void> {
    await mkdir(path.dirname(this.dependencyTreeFilePath), { recursive: true });
    await writeFile(this.dependencyTreeFilePath, JSON.stringify(document, null, 2), "utf8");
  }

  private isDependencyStoreDocument(value: unknown): value is DependencyTreeStoreDocument {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }

    return "projects" in value;
  }

  private async writeProjectDocument(document: ProjectStoreDocument): Promise<void> {
    await mkdir(path.dirname(this.projectFilePath), { recursive: true });
    await writeFile(this.projectFilePath, JSON.stringify(document, null, 2), "utf8");
  }

  private isProjectStoreDocument(value: unknown): value is ProjectStoreDocument {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }

    return "projects" in value;
  }
}
