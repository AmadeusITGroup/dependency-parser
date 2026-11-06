import { XMLParser } from "fast-xml-parser";

import { IPackageParser } from "../../../domain/interfaces/IPackageParser";
import { Dependency } from "../../../domain/models/Dependency";
import { ParseResult } from "../../../domain/types/ParseResult";

export class MavenPackageParser implements IPackageParser {
  supports(fileName: string): boolean {
    return fileName === "pom.xml";
  }

  parseDependencies(content: string): ParseResult {
    const project = this.parseManifest(content);
    const declaredProperties = this.readProperties(project.properties);
    const properties = new Map(declaredProperties);
    const parent = this.asRecord(project.parent);

    for (const field of ["groupId", "artifactId", "version"]) {
      const value = this.readString(project[field]) ??
        (field === "artifactId" ? null : this.readString(parent?.[field]));
      if (value) {
        properties.set(`project.${field}`, value);
        properties.set(`pom.${field}`, value);
      }
    }

    const dependencies: Dependency[] = [];
    for (const [name, value] of declaredProperties) {
      const version = this.resolveValue(value, properties, new Set([name]));
      if (version !== null) {
        dependencies.push(new Dependency(name, version));
      }
    }
    dependencies.push(...this.readDependencies(project.dependencies, properties));

    return {
      dependencies,
      metadata: { packageManager: "maven" },
    };
  }

  private parseManifest(content: string): Record<string, unknown> {
    const parser = new XMLParser({
      ignoreAttributes: true,
      removeNSPrefix: true,
      parseTagValue: false,
      trimValues: true,
      processEntities: false,
    });

    let parsedValue: unknown;
    try {
      parsedValue = parser.parse(content, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid XML.";
      throw new Error(`Invalid pom.xml content: ${message}`, { cause: error });
    }

    const document = this.asRecord(parsedValue);
    const project = this.asRecord(document?.project);
    if (!project) {
      throw new Error("pom.xml must contain a <project> element.");
    }
    return project;
  }

  private readProperties(value: unknown): Map<string, string> {
    const properties = new Map<string, string>();
    for (const [name, candidate] of Object.entries(this.asRecord(value) ?? {})) {
      const version = this.readString(candidate);
      if (version !== null) {
        properties.set(name, version);
      }
    }
    return properties;
  }

  private readDependencies(
    value: unknown,
    properties: ReadonlyMap<string, string>
  ): Dependency[] {
    const section = this.asRecord(value);
    const entries: unknown[] = Array.isArray(section?.dependency)
      ? section.dependency
      : [section?.dependency];
    const dependencies: Dependency[] = [];

    for (const candidate of entries) {
      const dependency = this.asRecord(candidate);
      if (!dependency) {
        continue;
      }

      const groupIdValue = this.readString(dependency.groupId);
      const artifactIdValue = this.readString(dependency.artifactId);
      const versionValue = this.readString(dependency.version);
      if (!groupIdValue || !artifactIdValue || !versionValue) {
        continue;
      }

      const groupId = this.resolveValue(groupIdValue, properties);
      const artifactId = this.resolveValue(artifactIdValue, properties);
      const version = this.resolveValue(versionValue, properties);
      if (groupId && artifactId && version) {
        dependencies.push(new Dependency(`${groupId}:${artifactId}`, version));
      }
    }

    return dependencies;
  }

  private resolveValue(
    value: string,
    properties: ReadonlyMap<string, string>,
    ancestry: ReadonlySet<string> = new Set()
  ): string | null {
    let complete = true;
    const resolvedValue = value.replace(/\$\{([^}]+)\}/g, (placeholder: string, name: string) => {
      const property = properties.get(name);
      if (property === undefined || ancestry.has(name)) {
        complete = false;
        return placeholder;
      }

      const nextAncestry = new Set(ancestry);
      nextAncestry.add(name);
      const resolvedProperty = this.resolveValue(property, properties, nextAncestry);
      if (resolvedProperty === null) {
        complete = false;
        return placeholder;
      }
      return resolvedProperty;
    });

    return complete && resolvedValue.trim() !== "" ? resolvedValue.trim() : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }
}