import { AnyBulkWriteOperation, Collection, Db, MongoClient } from "mongodb";

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
  SerializedDependencyNode,
  SerializedProject,
  SerializedProjectTag,
} from "./DataStoreSerialization";

type ProjectDocument = SerializedProject & { _id: string };

type DependencyTreeDocument = {
  projectId: string;
  version: string;
  root: SerializedDependencyNode;
  commitHash: string | null;
  projectConfiguration: string;
  savedAt: Date;
};

export class MongoDataStore implements IDataStore {
  private readonly projects: Collection<ProjectDocument>;
  private readonly dependencyTrees: Collection<DependencyTreeDocument>;
  private readonly tags: Collection<SerializedProjectTag>;

  constructor(
    database: Db,
    private readonly client?: MongoClient,
    private readonly rangeResolutionTtlMs = DEFAULT_NPM_RANGE_RESOLUTION_TTL_MS
  ) {
    this.projects = database.collection<ProjectDocument>("projects");
    this.dependencyTrees = database.collection<DependencyTreeDocument>("dependencyTrees");
    this.tags = database.collection<SerializedProjectTag>("tags");
  }

  static async connect(
    uri: string,
    databaseName: string,
    rangeResolutionTtlMs = DEFAULT_NPM_RANGE_RESOLUTION_TTL_MS
  ): Promise<MongoDataStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

    try {
      await client.connect();
      const store = new MongoDataStore(client.db(databaseName), client, rangeResolutionTtlMs);
      await store.dependencyTrees.createIndex(
        { projectId: 1, version: 1, commitHash: 1 },
        { unique: true }
      );
      await store.tags.createIndex(
        { projectId: 1, name: 1 },
        { unique: true }
      );
      return store;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async getAllProjects(): Promise<Project[]> {
    const documents = await this.projects.find({}).toArray();
    return documents.map(document => deserializeProject(document));
  }

  async getProjectById(projectId: string): Promise<Project | null> {
    const document = await this.projects.findOne({ _id: projectId });
    return document ? deserializeProject(document) : null;
  }

  async saveProject(project: Project): Promise<void> {
    const document = serializeProject(project);
    const existing = await this.getProjectById(project.id);

    if (existing && existing.repoUrl !== project.repoUrl) {
      await this.dependencyTrees.deleteMany({ projectId: project.id });
      await this.tags.deleteMany({ projectId: project.id });
    }

    await this.projects.replaceOne(
      { _id: project.id },
      document,
      { upsert: true }
    );
  }

  async saveDependencyTree(
    projectId: string,
    version: string,
    tree: DependencyTree,
    commitHash: string | null = null,
    project?: Project
  ): Promise<void> {
    await this.dependencyTrees.replaceOne(
      { projectId, version, commitHash },
      {
        projectId,
        version,
        commitHash,
        root: serializeDependencyNode(tree.root),
        projectConfiguration: project
          ? serializeProjectConfiguration(serializeProject(project))
          : await this.getProjectConfiguration(projectId),
        savedAt: new Date(),
      },
      { upsert: true }
    );
  }

  async getDependencyTree(
    projectId: string,
    version: string,
    commitHash?: string | null,
    allowHistorical = false
  ): Promise<DependencyTree | null> {
    const projectConfiguration = await this.getProjectConfiguration(projectId);
    const documents = await this.dependencyTrees.find({ projectId, version }).toArray();
    const document = documents
      .filter(snapshot =>
        (commitHash === undefined || snapshot.commitHash === commitHash) &&
        (allowHistorical || (snapshot.projectConfiguration === projectConfiguration &&
          !hasExpiredVersionResolution(snapshot.root, this.rangeResolutionTtlMs)))
      )
      .sort((left, right) => right.savedAt.getTime() - left.savedAt.getTime())[0];
    return document ? new DependencyTree(deserializeDependencyNode(document.root)) : null;
  }

  async hasDependencyTree(projectId: string, version: string): Promise<boolean> {
    return (await this.getDependencyTree(projectId, version)) !== null;
  }

  async getProjectTags(projectId: string): Promise<ProjectTag[]> {
    return (await this.tags.find({ projectId }).toArray()).map(deserializeProjectTag);
  }

  async getProjectTag(projectId: string, name: string): Promise<ProjectTag | null> {
    const document = await this.tags.findOne({ projectId, name });
    return document ? deserializeProjectTag(document) : null;
  }

  async syncProjectTags(
    projectId: string,
    tags: Version[],
    tagPattern: string | null = null
  ): Promise<ProjectTag[]> {
    const storedTags = await this.getProjectTags(projectId);
    const updatedTags = reconcileProjectTags(
      projectId, storedTags, tags, tagPattern
    );
    const operations: AnyBulkWriteOperation<SerializedProjectTag>[] = updatedTags.map(tag => ({
      replaceOne: {
        filter: { projectId, name: tag.name },
        replacement: serializeProjectTag(tag),
        upsert: true,
      },
    }));
    const retainedNames = new Set(updatedTags.map(tag => tag.name));
    for (const tag of storedTags) {
      if (!retainedNames.has(tag.name)) {
        operations.push({ deleteOne: { filter: { projectId, name: tag.name } } });
      }
    }
    if (operations.length > 0) {
      await this.tags.bulkWrite(operations, { ordered: false });
    }
    return updatedTags;
  }

  private async getProjectConfiguration(projectId: string): Promise<string> {
    const project = await this.getProjectById(projectId);
    return serializeProjectConfiguration(project ? serializeProject(project) : null);
  }

  async getAvailableVersions(projectId: string): Promise<string[]> {
    const [documents, storedTags, projectConfiguration] = await Promise.all([
      this.dependencyTrees.find({ projectId }).toArray(),
      this.getProjectTags(projectId),
      this.getProjectConfiguration(projectId),
    ]);
    const tags = new Map(storedTags.map(tag => [tag.name, tag]));
    const versions = [...new Set(documents.filter(snapshot => {
      const tag = tags.get(snapshot.version);
      return (!tag || snapshot.commitHash === tag.commitHash) &&
        (tag?.removed || (snapshot.projectConfiguration === projectConfiguration &&
          !hasExpiredVersionResolution(snapshot.root, this.rangeResolutionTtlMs)));
    }).map(snapshot => snapshot.version))];
    return versions.sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" })
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    await Promise.all([
      this.projects.deleteOne({ _id: projectId }),
      this.dependencyTrees.deleteMany({ projectId }),
      this.tags.deleteMany({ projectId }),
    ]);
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}