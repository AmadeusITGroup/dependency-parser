import { DependencyNode } from "./DependencyNode";

export class DependencyTree {
  constructor(public root: DependencyNode) {}

  /**
   * Finds a dependency anywhere in the tree by project ID.
   */
  findByProjectId(projectId: string): DependencyNode | null {
    return this._dfs(this.root, node => node.projectId === projectId);
  }

  /**
   * Finds a dependency by project ID and version.
   */
  find(projectId: string, version: string): DependencyNode | null {
    return this._dfs(
      this.root,
      node => node.projectId === projectId && node.version === version
    );
  }

  /**
   * Returns all dependencies in a flat list (no duplicates guaranteed).
   */
  flatten(): DependencyNode[] {
    const result: DependencyNode[] = [];
    const visited = new Set<string>();

    this._traverse(this.root, node => {
      if (!visited.has(node.id)) {
        visited.add(node.id);
        result.push(node);
      }
    });

    return result;
  }

  /**
   * Checks if a dependency exists in the tree.
   */
  contains(projectId: string): boolean {
    return this.findByProjectId(projectId) !== null;
  }

  /**
   * Generic traversal (DFS)
   */
  private _traverse(
    node: DependencyNode,
    visit: (node: DependencyNode) => void
  ): void {
    visit(node);

    for (const dep of node.dependencies) {
      this._traverse(dep, visit);
    }
  }

  /**
   * Generic DFS search helper
   */
  private _dfs(
    node: DependencyNode,
    predicate: (node: DependencyNode) => boolean
  ): DependencyNode | null {
    if (predicate(node)) {
      return node;
    }

    for (const dep of node.dependencies) {
      const found = this._dfs(dep, predicate);
      if (found) return found;
    }

    return null;
  }
}