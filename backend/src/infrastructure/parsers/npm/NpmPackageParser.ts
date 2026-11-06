import { maxSatisfying, valid, validRange } from "semver";

import {
  DependencyVersionResolution, IPackageParser,
} from "../../../domain/interfaces/IPackageParser";
import { Dependency } from "../../../domain/models/Dependency";
import { ParseResult } from "../../../domain/types/ParseResult";

export class NpmPackageParser implements IPackageParser {
  supports(fileName: string): boolean {
    return fileName === "package.json";
  }

  parseDependencies(content: string): ParseResult {
    const manifest = this.parseManifest(content);
    const dependencies = this.readDependencies(manifest.dependencies);

    return {
      dependencies,
      metadata: {
        packageManager: "npm",
      },
    };
  }

  async resolveVersion(
    declaration: string,
    getAvailableVersions: () => Promise<readonly string[]>
  ): Promise<DependencyVersionResolution | null> {
    if (valid(declaration) !== null || validRange(declaration) === null) {
      return null;
    }

    const versions = (await getAvailableVersions())
      .filter(version => valid(version) !== null)
      .sort();
    return { resolvedVersion: maxSatisfying(versions, declaration) };
  }

  private parseManifest(content: string): Record<string, unknown> {
    try {
      const parsedValue: unknown = JSON.parse(content);
      if (typeof parsedValue !== "object" || parsedValue === null || Array.isArray(parsedValue)) {
        throw new Error("package.json must contain a JSON object.");
      }

      return parsedValue as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid package.json content: ${error.message}`, { cause: error });
      }

      throw error;
    }
  }

  private readDependencies(value: unknown): Dependency[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [];
    }

    return Object.entries(value)
      .filter(([, version]) => typeof version === "string")
      .map(([name, version]) => new Dependency(name, version));
  }
}
