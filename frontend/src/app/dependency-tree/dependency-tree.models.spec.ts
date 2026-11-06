import { collectAllNodeIds, compareTrees, DepTreeNode, flattenTree, makeRootId, } from './dependency-tree.models';

describe('dependency tree models', () => {
  it('retains independent creation dates through comparison and flattening without leaking across absent versions', () => {
    const node = (projectId: string, version: string, creationDate: string, children: DepTreeNode[] = []): DepTreeNode => ({
      projectId, name: projectId, version, creationDate, children, ecosystem: 'Project', riskLevel: 'low',
    });
    const baselineDate = '2026-10-24T09:20:30.000Z';
    const comparisonDate = '2026-10-26T11:35:00.000Z';
    const baseline = node('root', 'v1', baselineDate, [
      node('same', 'v1', baselineDate),
      node('removed', 'v1', baselineDate),
    ]);
    const comparison = node('root', 'v2', comparisonDate, [
      node('same', 'v1', comparisonDate),
      node('added', 'v1', comparisonDate),
    ]);
    const merged = compareTrees(baseline, comparison);
    const rows = flattenTree(merged, new Set(collectAllNodeIds(merged)), '');
    expect(rows.map(row => [row.change, row.creationDate, row.comparisonCreationDate])).toEqual([
      ['changed', baselineDate, comparisonDate],
      ['unchanged', baselineDate, comparisonDate],
      ['removed', baselineDate, null],
      ['added', null, comparisonDate],
    ]);
    expect(baseline.comparisonCreationDate).toBeUndefined();
    expect(comparison.creationDate).toBe(comparisonDate);
  });

  it('matches versions within their parent branch and retains added and removed subtrees', () => {
    const node = (projectId: string, version: string, children: DepTreeNode[] = []): DepTreeNode => ({
      projectId, name: projectId, version, children, ecosystem: 'Project', riskLevel: 'low',
    });
    const baseline = node('root', 'v1', [
      node('branch', 'v1', [node('shared', 'v1')]),
      node('shared', 'v2'),
      node('removed', 'v1', [node('removed-child', 'v1')]),
    ]);
    const comparison = node('root', 'v2', [
      node('shared', 'v2'),
      node('branch', 'v2', [node('shared', 'v3')]),
      node('added', 'v1', [node('added-child', 'v1')]),
    ]);
    const merged = compareTrees(baseline, comparison);
    const rows = flattenTree(merged, new Set(collectAllNodeIds(merged)), 'v3');

    expect(rows.map((row) => row.change)).toEqual([
      'changed', 'changed', 'changed', 'unchanged', 'removed', 'removed', 'added', 'added',
    ]);
    expect(rows[2].comparisonVersion).toBe('v3');
    expect(rows[2].matchesFilter).toBe(true);
    expect(rows[4].comparisonVersion).toBeNull();
    expect(rows[6].version).toBe('');
    expect(baseline.children.length).toBe(3);
    expect(comparison.children.length).toBe(3);
    expect(baseline.children[0].comparisonVersion).toBeUndefined();
  });

  it('uses project IDs instead of display names for node identity', () => {
    const root: DepTreeNode = {
      projectId: '11111111-1111-4111-8111-111111111111',
      name: 'renamed-root',
      version: '1.0.0',
      ecosystem: 'Project',
      riskLevel: 'low',
      children: [
        {
          projectId: '22222222-2222-4222-8222-222222222222',
          name: 'renamed-dependency',
          version: '2.0.0',
          ecosystem: 'Project',
          riskLevel: 'low',
          children: [],
        },
      ],
    };

    const rootId = 'root/11111111-1111-4111-8111-111111111111@1.0.0';
    const childId = `${rootId}/22222222-2222-4222-8222-222222222222@2.0.0`;

    expect(makeRootId(root)).toBe(rootId);
    expect(collectAllNodeIds(root)).toEqual([rootId, childId]);
    expect(flattenTree(root, new Set([rootId]), '').map((node) => node.id)).toEqual([
      rootId,
      childId,
    ]);
  });
});
