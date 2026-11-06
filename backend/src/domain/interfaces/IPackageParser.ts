import { ParseResult } from "../types/ParseResult";

export type DependencyVersionResolution = {
  resolvedVersion: string | null;
};

export interface IPackageParser {
  /**
   * Determines whether this parser can handle the given file.
   * Example: "package.json", "pom.xml"
   */
  supports(fileName: string): boolean;

  /**
   * Parses the dependency file content and extracts dependencies.
   */
  parseDependencies(content: string): ParseResult;

  /**
   * Returns null for declarations that do not require ecosystem-specific selection.
   */
  resolveVersion?(
    declaration: string,
    getAvailableVersions: () => Promise<readonly string[]>
  ): Promise<DependencyVersionResolution | null>;
}