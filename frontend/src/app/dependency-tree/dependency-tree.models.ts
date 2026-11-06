import { RiskLevel } from '../dependency-dashboard.models';

/**
 * Frontend view model mirroring the backend DependencyNodeDTO,
 * augmented with UI metadata (ecosystem, riskLevel) that would
 * come from a separate metadata endpoint in production.
 */
export interface DepTreeNode {
  projectId: string;
  name: string;
  version: string;
  creationDate?: string | null;
  ecosystem: string;
  riskLevel: RiskLevel;
  children: DepTreeNode[];
  comparisonVersion?: string | null;
  comparisonCreationDate?: string | null;
  change?: 'unchanged' | 'changed' | 'added' | 'removed';
}

export interface ProjectTree {
  projectId: string;
  projectName: string;
  release: string;
  ecosystem: string;
  directCount: number;
  transitiveCount: number;
  root: DepTreeNode;
}

export interface CommitComparisonTarget {
  projectId: string;
  name: string;
  fromVersion: string;
  toVersion: string;
}

/** Flat representation of a tree node used for list-based rendering. */
export interface FlatDepNode {
  id: string;
  projectId: string;
  name: string;
  version: string;
  creationDate?: string | null;
  ecosystem: string;
  riskLevel: RiskLevel;
  depth: number;
  hasChildren: boolean;
  isLastChild: boolean;
  /**
   * For each ancestor at depth 1..depth-1: true = ancestor was last child (no │ guide),
   * false = ancestor had siblings after it (draw │ guide).
   */
  ancestorIsLast: boolean[];
  expanded: boolean;
  matchesFilter: boolean;
  comparisonVersion?: string | null;
  comparisonCreationDate?: string | null;
  change?: DepTreeNode['change'];
}

export function compareTrees(baseline: DepTreeNode, comparison: DepTreeNode): DepTreeNode {
  function merge(left: DepTreeNode | null, right: DepTreeNode | null): DepTreeNode {
    const source = left ?? right!;
    const remaining = [...(right?.children ?? [])];
    const children = (left?.children ?? []).map((child) => {
      const index = remaining.findIndex((candidate) => candidate.projectId === child.projectId);
      return merge(child, index >= 0 ? remaining.splice(index, 1)[0] : null);
    });
    children.push(...remaining.map((child) => merge(null, child)));
    return {
      ...source,
      version: left?.version ?? '',
      creationDate: left?.creationDate ?? null,
      comparisonVersion: right?.version ?? null,
      comparisonCreationDate: right?.creationDate ?? null,
      change: !left ? 'added' : !right ? 'removed'
        : left.version === right.version ? 'unchanged' : 'changed',
      children,
    };
  }
  return merge(baseline, comparison);
}

export function flattenTree(
  root: DepTreeNode,
  expandedIds: ReadonlySet<string>,
  filterText: string,
): FlatDepNode[] {
  const isFiltering = filterText.trim().length > 0;
  const lowerFilter = filterText.toLowerCase().trim();
  const result: FlatDepNode[] = [];

  function visit(
    node: DepTreeNode,
    depth: number,
    parentPath: string,
    ancestorIsLast: boolean[],
    isLastChild: boolean,
  ): void {
    const id = `${parentPath}/${node.projectId}@${node.version}`;
    const hasChildren = node.children.length > 0;
    const expanded = isFiltering ? hasChildren : expandedIds.has(id);
    const matchesFilter = isFiltering
      ? node.name.toLowerCase().includes(lowerFilter) ||
        node.version.toLowerCase().includes(lowerFilter) ||
        (node.comparisonVersion?.toLowerCase().includes(lowerFilter) ?? false)
      : false;

    result.push({
      id,
      projectId: node.projectId,
      name: node.name,
      version: node.version,
      creationDate: node.creationDate ?? null,
      ecosystem: node.ecosystem,
      riskLevel: node.riskLevel,
      depth,
      hasChildren,
      isLastChild,
      ancestorIsLast,
      expanded,
      matchesFilter,
      comparisonVersion: node.comparisonVersion,
      comparisonCreationDate: node.comparisonCreationDate ?? null,
      change: node.change,
    });

    if (expanded && hasChildren) {
      node.children.forEach((child, i) => {
        const childIsLast = i === node.children.length - 1;
        // Depth-1 nodes have no guides (length 0); deeper nodes accumulate isLastChild state.
        const childAncestorIsLast =
          depth === 0 ? [] : [...ancestorIsLast, isLastChild];
        visit(child, depth + 1, id, childAncestorIsLast, childIsLast);
      });
    }
  }

  visit(root, 0, 'root', [], true);
  return result;
}

export function collectAllNodeIds(
  node: DepTreeNode,
  parentPath = 'root',
): string[] {
  const id = `${parentPath}/${node.projectId}@${node.version}`;
  const ids: string[] = [id];
  for (const child of node.children) {
    ids.push(...collectAllNodeIds(child, id));
  }
  return ids;
}

export function makeRootId(node: DepTreeNode): string {
  return `root/${node.projectId}@${node.version}`;
}
