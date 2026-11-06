import {
  activateDraft, addDependency, collapseAll, clearAllDrafts, clearDraft,
  createDependency, createProject, expandAll, exportToJson, findDuplicateDependencyName,
  importProjectDefinition, loadActiveDraft, loadDraft, nextProjectName, removeProject,
  saveDraft, toProjectDefinition, toggleCollapse, updateDependency, updateProject,
} from './tree-builder.models';

describe('tree builder models', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearAllDrafts();
  });

  it('assigns UUIDs to new project nodes', () => {
    const firstId = createProject().id;
    const secondId = createProject().id;

    expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(secondId).not.toBe(firstId);
  });

  it('builds project dependencies with relationship metadata', () => {
    const root = { ...createProject('web-app'), repoUrl: 'https://example.com/web.git' };
    const child = { ...createProject('design-system'), repoUrl: 'https://example.com/ui.git' };
    const dependency = {
      ...createDependency(child),
      manifestPath: 'package.json',
      versionReference: '/"design-system":\\s*"([^"]+)"/',
      versionReferenceType: 'regex' as const,
    };

    const result = addDependency(root, root.id, dependency);

    expect(toProjectDefinition(result)).toEqual({
      id: root.id,
      name: 'web-app',
      repoUrl: 'https://example.com/web.git',
      description: null,
      tagPattern: null,
      dependencies: [
        {
          project: {
            id: child.id,
            name: 'design-system',
            repoUrl: 'https://example.com/ui.git',
            description: null,
            tagPattern: null,
            dependencies: null,
          },
          manifestPath: 'package.json',
          versionReference: '/"design-system":\\s*"([^"]+)"/',
        },
      ],
    });
  });

  it('allows a dependency name to be reused at different tree depths', () => {
    const parentDependency = createProject('new-project');
    const nestedDependency = addDependency(parentDependency, parentDependency.id, createDependency(createProject('new-project')));
    const root = createProject('my-project');
    const tree = addDependency(root, root.id, createDependency(nestedDependency));

    expect(findDuplicateDependencyName(tree)).toBeNull();
  });

  it('detects duplicate direct dependency names under the same node', () => {
    const root = createProject('my-project');
    const firstDependency = addDependency(root, root.id, createDependency(createProject('shared-dependency')));
    const tree = addDependency(firstDependency, root.id, createDependency(createProject(' Shared-Dependency ')));

    expect(findDuplicateDependencyName(tree)).toBe('Shared-Dependency');
  });

  it('updates project and incoming dependency fields independently', () => {
    const root = createProject('root');
    const child = createProject('child');
    const tree = addDependency(root, root.id, createDependency(child));

    const withRepo = updateProject(tree, child.id, 'repoUrl', 'https://example.com/child.git');
    const result = updateDependency(withRepo, child.id, {
      manifestPath: 'services/child/package.json',
      versionReference: 'workspace:*',
    });

    expect(result.dependencies[0].project.repoUrl).toBe('https://example.com/child.git');
    expect(result.dependencies[0].manifestPath).toBe('services/child/package.json');
    expect(result.dependencies[0].versionReference).toBe('workspace:*');
  });

  it('generates the first available default project name', () => {
    expect(nextProjectName([])).toBe('my-project');
    expect(nextProjectName(['my-project'])).toBe('my-project-1');
    expect(nextProjectName(['my-project', 'my-project-1', 'my-project-2'])).toBe('my-project-3');
    expect(nextProjectName(['my-project', 'my-project-2'])).toBe('my-project-1');
  });

  it('collapses every project in the tree', () => {
    const root = createProject('root');
    const firstChild = createProject('first-child');
    const secondChild = createProject('second-child');
    const grandchild = createProject('grandchild');
    const nestedFirstChild = addDependency(firstChild, firstChild.id, createDependency(grandchild));
    const withFirstChild = addDependency(root, root.id, createDependency(nestedFirstChild));
    const tree = addDependency(withFirstChild, root.id, createDependency(secondChild));

    const result = collapseAll(tree);

    expect(result.collapsed).toBe(true);
    expect(result.dependencies[0].project.collapsed).toBe(true);
    expect(result.dependencies[0].project.dependencies[0].project.collapsed).toBe(true);
    expect(result.dependencies[1].project.collapsed).toBe(true);
  });

  it('round-trips a project draft with its loaded project identity', () => {
    const child = createProject('child');
    const root = { ...createProject('root'), collapsed: true };
    const draftTree = addDependency(root, root.id, {
      ...createDependency(child),
      manifestPath: 'package.json',
      versionReference: '/"child":\\s*"([^"]+)"/',
      versionReferenceType: 'regex',
    });

    saveDraft({
      tree: draftTree,
      loadedProjectId: root.id,
      saveStatus: 'error',
      saveError: 'Repository URL is required.',
    });

    expect(loadActiveDraft()).toEqual({
      tree: draftTree,
      loadedProjectId: root.id,
      saveStatus: 'error',
      saveError: 'Repository URL is required.',
    });
  });

  it('keeps independent drafts when switching projects', () => {
    const alpha = { ...createProject('alpha'), description: 'Alpha draft' };
    const beta = { ...createProject('beta'), description: 'Beta draft' };

    const alphaDraft = {
      tree: alpha,
      loadedProjectId: alpha.id,
      saveStatus: 'dirty' as const,
      saveError: null,
    };
    const betaDraft = {
      tree: beta,
      loadedProjectId: beta.id,
      saveStatus: 'saved' as const,
      saveError: null,
    };
    saveDraft(alphaDraft);
    saveDraft(betaDraft);

    expect(loadDraft(alpha.id)).toEqual(alphaDraft);
    expect(loadDraft(beta.id)).toEqual(betaDraft);
    expect(loadActiveDraft()).toEqual(betaDraft);

    activateDraft(alpha.id);
    expect(loadActiveDraft()).toEqual(alphaDraft);
  });

  it('logs and removes an unreadable active draft', () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const draftKey = 'dep-tree-builder:draft:broken';
    const activeKey = 'dep-tree-builder:active-draft';
    try {
      localStorage.setItem(draftKey, '{broken');
      localStorage.setItem(activeKey, 'broken');

      expect(loadActiveDraft()).toBeNull();
      expect(localStorage.getItem(draftKey)).toBeNull();
      expect(localStorage.getItem(activeKey)).toBeNull();
      expect(logError).toHaveBeenCalledWith(
        'Unable to inspect the locally saved project draft.',
        expect.any(SyntaxError),
      );
    } finally {
      logError.mockRestore();
    }
  });

  it('clears only the requested project draft', () => {
    const alpha = createProject('alpha');
    const beta = createProject('beta');
    const betaDraft = {
      tree: beta,
      loadedProjectId: beta.id,
      saveStatus: 'saved' as const,
      saveError: null,
    };
    saveDraft({
      tree: alpha,
      loadedProjectId: alpha.id,
      saveStatus: 'dirty',
      saveError: null,
    });
    saveDraft(betaDraft);

    clearDraft(alpha.id);

    expect(loadDraft(alpha.id)).toBeNull();
    expect(loadDraft(beta.id)).toEqual(betaDraft);
    expect(loadActiveDraft()).toEqual(betaDraft);
  });

  it('edits nested trees immutably and expands a collapsed parent when adding a dependency', () => {
    const root = createProject('root');
    const child = createProject('child');
    const grandchild = createProject('grandchild');
    const tree = addDependency(root, root.id, createDependency({ ...child, collapsed: true }));
    const nested = addDependency(tree, child.id, createDependency(grandchild));
    const collapsed = toggleCollapse(nested, child.id);
    const expanded = expandAll({ ...collapsed, collapsed: true });

    expect(root.dependencies).toEqual([]);
    expect(tree.dependencies[0].project.dependencies).toEqual([]);
    expect(nested.dependencies[0].project.collapsed).toBe(false);
    expect(collapsed.dependencies[0].project.collapsed).toBe(true);
    expect(expanded.collapsed).toBe(false);
    expect(expanded.dependencies[0].project.collapsed).toBe(false);
    expect(removeProject(expanded, grandchild.id).dependencies[0].project.dependencies).toEqual([]);
    expect(removeProject(expanded, child.id).dependencies).toEqual([]);
    expect(expanded.dependencies[0].project.dependencies[0].project.id).toBe(grandchild.id);
  });

  it('detects duplicate names below the root', () => {
    const parent = {
      ...createProject('parent'),
      dependencies: [
        createDependency(createProject('shared')),
        createDependency(createProject(' SHARED ')),
      ],
    };
    const nested = { ...createProject('root'), dependencies: [createDependency(parent)] };

    expect(findDuplicateDependencyName(nested)).toBe('SHARED');
  });

  it('serializes bare regex references and trims optional tag patterns', () => {
    const root = {
      ...createProject('root'),
      tagPattern: ' ^v ',
      dependencies: [
        { ...createDependency(createProject('child')), versionReference: '^child$', versionReferenceType: 'regex' as const },
        createDependency(createProject('empty')),
      ],
    };

    const definition = toProjectDefinition(root);

    expect(definition.tagPattern).toBe('^v');
    expect(definition.dependencies?.[0].versionReference).toBe('/^child$/');
    expect(definition.dependencies?.[1].versionReference).toBeNull();
    expect(definition.dependencies?.[1].manifestPath).toBeNull();
  });

  it('imports nested definitions with fresh IDs, regex references, and optional-field defaults', () => {
    const definition = {
      id: 'old-root',
      name: 'Root',
      repoUrl: 'https://example.com/root.git',
      description: 'Imported project',
      tagPattern: '^release/',
      dependencies: [
        {
          project: { id: 'old-child', name: 'Child', repoUrl: 'https://example.com/child.git' },
          manifestPath: 'package.json',
          versionReference: { pattern: '^child$', flags: 'i' },
        },
        {
          project: { name: 'Other', repoUrl: 'https://example.com/other.git' },
          versionReference: 'other-package',
        },
      ],
    };

    const imported = importProjectDefinition(definition);

    expect(imported.id).not.toBe(definition.id);
    expect(imported.description).toBe('Imported project');
    expect(imported.tagPattern).toBe('^release/');
    expect(imported.collapsed).toBe(false);
    expect(imported.dependencies[0].project.id).not.toBe('old-child');
    expect(imported.dependencies[0].versionReference).toBe('/^child$/i');
    expect(imported.dependencies[0].versionReferenceType).toBe('regex');
    expect(imported.dependencies[1]).toMatchObject({
      manifestPath: '', versionReference: 'other-package', versionReferenceType: 'string',
      project: { description: '', tagPattern: '', dependencies: [] },
    });
  });

  it.each([null, [], {}, { name: 'Missing repository' }])('rejects invalid imported projects (%j)', value => {
    expect(() => importProjectDefinition(value)).toThrow('not a valid project definition');
  });

  it.each([null, [], {}, { project: null }])('rejects invalid imported dependencies (%j)', dependency => {
    expect(() => importProjectDefinition({
      name: 'Root', repoUrl: 'https://example.com/root.git', dependencies: [dependency],
    })).toThrow('A dependency in the file is invalid.');
  });

  it.each([
    { status: 'unrecognized', error: null, expected: 'dirty' },
    { status: 'error', error: null, expected: 'dirty' },
    { status: 'saved', error: 'Outdated error', expected: 'saved' },
  ])('normalizes stored draft metadata ($status, $error)', ({ status, error, expected }) => {
    localStorage.setItem('dep-tree-builder:draft:__new__', JSON.stringify({
      version: 3,
      tree: { name: 'Stored', dependencies: [{ project: { name: 'Child' } }] },
      saveStatus: status,
      saveError: error,
    }));

    const draft = loadDraft(null);

    expect(draft).toMatchObject({
      loadedProjectId: null, saveStatus: expected, saveError: null,
      tree: {
        repoUrl: '', description: '', tagPattern: '', collapsed: false,
        dependencies: [{
          manifestPath: '', versionReference: '', versionReferenceType: 'string',
          project: { name: 'Child', dependencies: [] },
        }],
      },
    });
    expect(draft?.tree.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    { version: 2, tree: { name: 'Old' } },
    { version: 3, tree: [] },
    { version: 3, tree: { name: 'Root', dependencies: [{}] } },
  ])('logs unsupported or invalid saved drafts (%j)', draft => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.setItem('dep-tree-builder:draft:__new__', JSON.stringify(draft));

    expect(loadDraft(null)).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      'Unable to restore the locally saved project draft.', expect.any(Error),
    );
  });

  it('clears the active draft for an encoded project ID', () => {
    const projectId = 'team/project name';
    const draft = {
      tree: createProject('Encoded'), loadedProjectId: projectId,
      saveStatus: 'dirty' as const, saveError: null,
    };
    saveDraft(draft);

    expect(loadDraft(projectId)).toEqual(draft);
    clearDraft(projectId);
    expect(loadActiveDraft()).toBeNull();
    expect(loadDraft(projectId)).toBeNull();
  });

  it('exports project JSON with a safe filename and releases the temporary URL', async () => {
    const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:project-export');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('web-app-project.json');
      expect(document.body.contains(this)).toBe(true);
    });
    const root = createProject('web/app');

    exportToJson(root);

    const blob = objectUrl.mock.calls[0][0];
    if (!(blob instanceof Blob)) throw new Error('Expected an exported JSON blob.');
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual(toProjectDefinition(root));
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download="web-app-project.json"]')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:project-export');
  });
});
