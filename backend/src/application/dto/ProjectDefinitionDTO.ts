import { randomUUID } from "node:crypto";

import { Project } from "../../domain/models/Project";
import { ProjectDependency } from "../../domain/models/ProjectDependency";

type ProjectRequest = {
  id?: unknown;
  name?: unknown;
  repoUrl?: unknown;
  description?: unknown;
  dependencies?: unknown;
  tagPattern?: unknown;
};

type DependencyRequest = {
  project?: unknown;
  manifestPath?: unknown;
  versionReference?: unknown;
};

export type ProjectDefinitionDTO = {
  id: string;
  name: string;
  repoUrl: string;
  description: string | null;
  dependencies: DependencyDefinitionDTO[] | null;
  tagPattern: string | null;
};

export type DependencyDefinitionDTO = {
  project: ProjectDefinitionDTO;
  manifestPath: string | null;
  versionReference: string | { pattern: string; flags: string } | null;
};

export const ProjectDefinitionDTO = {
  fromDomain(project: Project): ProjectDefinitionDTO {
    return {
      id: project.id,
      name: project.name,
      repoUrl: project.repoUrl,
      description: project.description,
      tagPattern: project.tagPattern,
      dependencies: project.dependencies?.map(dependency => ({
        project: ProjectDefinitionDTO.fromDomain(dependency.project),
        manifestPath: dependency.manifestPath,
        versionReference:
          dependency.versionReference instanceof RegExp
            ? {
                pattern: dependency.versionReference.source,
                flags: dependency.versionReference.flags,
              }
            : dependency.versionReference,
      })) ?? null,
    };
  },

  toDomain(value: unknown): Project {
    if (!isRecord(value)) {
      throw new Error("Project definition must be an object.");
    }

    const project = value as ProjectRequest;
    const id = readString(project.id) ?? randomUUID();
    const name = readString(project.name);
    const repoUrl = readString(project.repoUrl);

    if (!name || !repoUrl) {
      throw new Error('Project definitions require non-empty "name" and "repoUrl" fields.');
    }
    if (project.description !== undefined && project.description !== null && typeof project.description !== "string") {
      throw new Error('Project "description" must be a string or null.');
    }

    return new Project(
      id,
      name,
      repoUrl,
      project.description ?? null,
      toDependencies(project.dependencies),
      toTagPattern(project.tagPattern)
    );
  },
};

function toTagPattern(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error('Project "tagPattern" must be a string or null.');
  if (value.trim() === "") return null;
  try {
    new RegExp(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid regular expression";
    throw new Error(`Invalid tagPattern regular expression: ${message}`, { cause: error });
  }
  return value;
}

function toDependencies(value: unknown): ProjectDependency[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error('Project "dependencies" must be an array or null.');
  return value.map(toDependency);
}

function toDependency(value: unknown): ProjectDependency {
  if (!isRecord(value)) throw new Error("Each project dependency must be an object.");

  const dependency = value as DependencyRequest;
  if (dependency.project === undefined) throw new Error('Each project dependency requires a "project" field.');

  return new ProjectDependency(
    ProjectDefinitionDTO.toDomain(dependency.project),
    readNullableString(dependency.manifestPath, "manifestPath"),
    toVersionReference(dependency.versionReference)
  );
}

function toVersionReference(value: unknown): string | RegExp | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const serializedRegex = /^\/(.*)\/([dgimsuvy]*)$/.exec(value);
    if (!serializedRegex) return value;
    return createRegExp(serializedRegex[1], serializedRegex[2]);
  }
  if (!isRecord(value) || typeof value.pattern !== "string" || typeof value.flags !== "string") {
    throw new Error('Project "versionReference" must be a string, serialized regular expression, or null.');
  }
  return createRegExp(value.pattern, value.flags);
}

function createRegExp(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid regular expression";
    throw new Error(`Invalid versionReference regular expression: ${message}`, { cause: error });
  }
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Project "${fieldName}" must be a string or null.`);
  return value;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}