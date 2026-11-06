export class DependencyNode {
  constructor(
    public projectId: string,
    public projectName: string,
    public version: string,
    public dependencies: DependencyNode[] = [],
    public dependenciesResolved = true,
    public declaredVersion = version,
    public resolvedVersion: string | null = null,
    public resolutionCheckedAt: Date | null = null
  ) {}

  /**
   * Unique identifier for this node.
   */
  get id(): string {
    return `${this.projectId}@${this.version}`;
  }

  /**
   * Adds a dependency node.
   */
  addDependency(node: DependencyNode): void {
    this.dependencies.push(node);
  }

  /**
   * Checks if this node directly depends on a given package.
   */
  hasDependency(projectId: string): boolean {
    return this.dependencies.some(dependency => dependency.projectId === projectId);
  }
}

type VersionResolutionNode = {
  resolutionCheckedAt?: Date | string | null;
  dependencies: readonly VersionResolutionNode[];
};

export function getVersionResolutionExpiry(
  node: VersionResolutionNode,
  ttlMs: number
): number | null {
  let expiresAt: number | null = null;
  if (node.resolutionCheckedAt != null) {
    const checkedAt = typeof node.resolutionCheckedAt === "string"
      ? Date.parse(node.resolutionCheckedAt)
      : node.resolutionCheckedAt.getTime();
    if (!Number.isFinite(checkedAt)) {
      throw new Error("Invalid dependency version resolution timestamp.");
    }
    expiresAt = checkedAt + ttlMs;
  }
  for (const child of node.dependencies) {
    const childExpiry = getVersionResolutionExpiry(child, ttlMs);
    if (childExpiry !== null) {
      expiresAt = expiresAt === null ? childExpiry : Math.min(expiresAt, childExpiry);
    }
  }
  return expiresAt;
}