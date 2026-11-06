const DRAFT_STORAGE_PREFIX = 'dep-tree-builder:draft:';
const ACTIVE_DRAFT_KEY = 'dep-tree-builder:active-draft';
const OUTDATED_DRAFT_STORAGE_KEY = 'dep-tree-builder';
const NEW_PROJECT_DRAFT_ID = '__new__';
const DRAFT_VERSION = 3;

export type VersionReferenceType = 'string' | 'regex';
export type ProjectDraftStatus = 'idle' | 'dirty' | 'saved' | 'error';

export interface BuilderProject {
  id: string;
  name: string;
  repoUrl: string;
  description: string;
  tagPattern: string;
  dependencies: BuilderDependency[];
  collapsed: boolean;
}

export interface BuilderDependency {
  project: BuilderProject;
  manifestPath: string;
  versionReference: string;
  versionReferenceType: VersionReferenceType;
}

export type ProjectField = 'name' | 'repoUrl' | 'description' | 'tagPattern';
export type DependencyField = 'manifestPath' | 'versionReference';

export interface BuilderDraft {
  tree: BuilderProject;
  loadedProjectId: string | null;
  saveStatus: ProjectDraftStatus;
  saveError: string | null;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function createProject(name = 'new-project'): BuilderProject {
  return {
    id: generateId(),
    name,
    repoUrl: '',
    description: '',
    tagPattern: '',
    dependencies: [],
    collapsed: false,
  };
}

export function nextProjectName(existingNames: Iterable<string>): string {
  const names = new Set(existingNames);
  const baseName = 'my-project';
  if (!names.has(baseName)) return baseName;

  let suffix = 1;
  while (names.has(`${baseName}-${suffix}`)) suffix += 1;
  return `${baseName}-${suffix}`;
}

export function createDependency(project = createProject()): BuilderDependency {
  return {
    project,
    manifestPath: '',
    versionReference: '',
    versionReferenceType: 'string',
  };
}

export function findDuplicateDependencyName(root: BuilderProject): string | null {
  const visit = (project: BuilderProject): string | null => {
    const dependencyNames = new Set<string>();

    for (const dependency of project.dependencies) {
      const dependencyName = dependency.project.name.trim();
      const normalizedName = dependencyName.toLocaleLowerCase();
      if (dependencyNames.has(normalizedName)) return dependencyName;

      dependencyNames.add(normalizedName);
    }

    for (const dependency of project.dependencies) {
      const duplicateName = visit(dependency.project);
      if (duplicateName !== null) return duplicateName;
    }

    return null;
  };

  return visit(root);
}

export function addDependency(
  root: BuilderProject,
  parentId: string,
  dependency: BuilderDependency,
): BuilderProject {
  if (root.id === parentId) {
    return {
      ...root,
      collapsed: false,
      dependencies: [...root.dependencies, dependency],
    };
  }
  return mapProjects(root, (project) => addDependency(project, parentId, dependency));
}

export function removeProject(root: BuilderProject, projectId: string): BuilderProject {
  return {
    ...root,
    dependencies: root.dependencies
      .filter((dependency) => dependency.project.id !== projectId)
      .map((dependency) => ({
        ...dependency,
        project: removeProject(dependency.project, projectId),
      })),
  };
}

export function updateProject(
  root: BuilderProject,
  projectId: string,
  field: ProjectField,
  value: string,
): BuilderProject {
  if (root.id === projectId) return { ...root, [field]: value };
  return mapProjects(root, (project) => updateProject(project, projectId, field, value));
}

export function updateDependency(
  root: BuilderProject,
  projectId: string,
  changes: Partial<Pick<BuilderDependency, DependencyField | 'versionReferenceType'>>,
): BuilderProject {
  return {
    ...root,
    dependencies: root.dependencies.map((dependency) =>
      dependency.project.id === projectId
        ? { ...dependency, ...changes }
        : {
            ...dependency,
            project: updateDependency(dependency.project, projectId, changes),
          },
    ),
  };
}

export function toggleCollapse(root: BuilderProject, projectId: string): BuilderProject {
  if (root.id === projectId) return { ...root, collapsed: !root.collapsed };
  return mapProjects(root, (project) => toggleCollapse(project, projectId));
}

export function expandAll(root: BuilderProject): BuilderProject {
  return {
    ...root,
    collapsed: false,
    dependencies: root.dependencies.map((dependency) => ({
      ...dependency,
      project: expandAll(dependency.project),
    })),
  };
}

export function collapseAll(root: BuilderProject): BuilderProject {
  return {
    ...root,
    collapsed: true,
    dependencies: root.dependencies.map((dependency) => ({
      ...dependency,
      project: collapseAll(dependency.project),
    })),
  };
}

export function loadActiveDraft(): BuilderDraft | null {
  removeOutdatedDrafts();
  const draftId = localStorage.getItem(ACTIVE_DRAFT_KEY);
  return draftId ? loadDraftById(draftId) : null;
}

export function loadDraft(projectId: string | null): BuilderDraft | null {
  return loadDraftById(draftIdForProject(projectId));
}

export function saveDraft(draft: BuilderDraft): void {
  const draftId = draftIdForProject(draft.loadedProjectId);
  localStorage.setItem(
    draftStorageKey(draftId),
    JSON.stringify({ version: DRAFT_VERSION, ...draft }),
  );
  activateDraft(draft.loadedProjectId);
}

export function activateDraft(projectId: string | null): void {
  localStorage.setItem(ACTIVE_DRAFT_KEY, draftIdForProject(projectId));
}

export function clearDraft(projectId: string | null): void {
  const draftId = draftIdForProject(projectId);
  localStorage.removeItem(draftStorageKey(draftId));
  if (localStorage.getItem(ACTIVE_DRAFT_KEY) === draftId) {
    localStorage.removeItem(ACTIVE_DRAFT_KEY);
  }
}

export function clearAllDrafts(): void {
  Object.keys(localStorage)
    .filter((key) => key.startsWith(DRAFT_STORAGE_PREFIX))
    .forEach((key) => localStorage.removeItem(key));
  localStorage.removeItem(ACTIVE_DRAFT_KEY);
  localStorage.removeItem(OUTDATED_DRAFT_STORAGE_KEY);
}

function draftIdForProject(projectId: string | null): string {
  return projectId ? encodeURIComponent(projectId) : NEW_PROJECT_DRAFT_ID;
}

function draftStorageKey(draftId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${draftId}`;
}

function loadDraftById(draftId: string): BuilderDraft | null {
  return parseDraft(localStorage.getItem(draftStorageKey(draftId)));
}

function removeOutdatedDrafts(): void {
  localStorage.removeItem(OUTDATED_DRAFT_STORAGE_KEY);
  const activeDraftId = localStorage.getItem(ACTIVE_DRAFT_KEY);

  Object.keys(localStorage)
    .filter((key) => key.startsWith(DRAFT_STORAGE_PREFIX))
    .forEach((key) => {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? '') as unknown;
        if (isRecord(value) && value['version'] === DRAFT_VERSION) return;
      } catch (error) {
        console.error('Unable to inspect the locally saved project draft.', error);
      }

      localStorage.removeItem(key);
      if (key === draftStorageKey(activeDraftId ?? '')) {
        localStorage.removeItem(ACTIVE_DRAFT_KEY);
      }
    });
}

function parseDraft(storedDraft: string | null): BuilderDraft | null {
  if (!storedDraft) return null;

  try {
    const value = JSON.parse(storedDraft) as unknown;
    if (
      !isRecord(value) ||
      value['version'] !== DRAFT_VERSION ||
      !value['tree']
    ) {
      throw new Error('The saved draft has an unsupported format.');
    }

    const saveStatus = parseDraftStatus(value['saveStatus']);
    const saveError = typeof value['saveError'] === 'string' ? value['saveError'] : null;

    return {
      tree: parseStoredProject(value['tree']),
      loadedProjectId:
        typeof value['loadedProjectId'] === 'string' ? value['loadedProjectId'] : null,
      saveStatus: saveStatus === 'error' && !saveError ? 'dirty' : saveStatus,
      saveError: saveStatus === 'error' ? saveError : null,
    };
  } catch (error) {
    console.error('Unable to restore the locally saved project draft.', error);
    return null;
  }
}

function parseDraftStatus(value: unknown): ProjectDraftStatus {
  return value === 'idle' || value === 'dirty' || value === 'saved' || value === 'error'
    ? value
    : 'dirty';
}

interface ExportProject {
  id: string;
  name: string;
  repoUrl: string;
  description: string | null;
  tagPattern: string | null;
  dependencies: ExportDependency[] | null;
}

interface ExportDependency {
  project: ExportProject;
  manifestPath: string | null;
  versionReference: string | null;
}

export function toProjectDefinition(project: BuilderProject): ExportProject {
  return {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    description: project.description || null,
    tagPattern: project.tagPattern.trim() || null,
    dependencies: project.dependencies.length
      ? project.dependencies.map((dependency) => ({
          project: toProjectDefinition(dependency.project),
          manifestPath: dependency.manifestPath || null,
          versionReference: serializeVersionReference(dependency),
        }))
      : null,
  };
}

export function exportToJson(root: BuilderProject): void {
  const json = JSON.stringify(toProjectDefinition(root), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${root.name.replace(/[^a-z0-9-_]/gi, '-')}-project.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function importProjectDefinition(value: unknown): BuilderProject {
  if (
    !isRecord(value) ||
    typeof value['name'] !== 'string' ||
    typeof value['repoUrl'] !== 'string'
  ) {
    throw new Error('The file is not a valid project definition.');
  }

  const dependencies = value['dependencies'];
  return {
    id: generateId(),
    name: value['name'],
    repoUrl: value['repoUrl'],
    description: typeof value['description'] === 'string' ? value['description'] : '',
    tagPattern: typeof value['tagPattern'] === 'string' ? value['tagPattern'] : '',
    dependencies: Array.isArray(dependencies) ? dependencies.map(importDependency) : [],
    collapsed: false,
  };
}

function importDependency(value: unknown): BuilderDependency {
  if (!isRecord(value) || !value['project']) {
    throw new Error('A dependency in the file is invalid.');
  }

  const reference = value['versionReference'];
  let versionReference = '';
  if (typeof reference === 'string') {
    versionReference = reference;
  } else if (
    isRecord(reference) &&
    typeof reference['pattern'] === 'string' &&
    typeof reference['flags'] === 'string'
  ) {
    versionReference = `/${reference['pattern']}/${reference['flags']}`;
  }

  return {
    project: importProjectDefinition(value['project']),
    manifestPath: typeof value['manifestPath'] === 'string' ? value['manifestPath'] : '',
    versionReference,
    versionReferenceType: /^\/.*\/[dgimsuvy]*$/.test(versionReference) ? 'regex' : 'string',
  };
}

function mapProjects(
  root: BuilderProject,
  transform: (project: BuilderProject) => BuilderProject,
): BuilderProject {
  return {
    ...root,
    dependencies: root.dependencies.map((dependency) => ({
      ...dependency,
      project: transform(dependency.project),
    })),
  };
}

function serializeVersionReference(dependency: BuilderDependency): string | null {
  if (!dependency.versionReference) return null;
  if (dependency.versionReferenceType === 'string') return dependency.versionReference;

  const reference = dependency.versionReference;
  return reference.startsWith('/') ? reference : `/${reference}/`;
}

function parseStoredProject(value: unknown): BuilderProject {
  if (!isRecord(value) || typeof value['name'] !== 'string') {
    throw new Error('The locally saved project is invalid.');
  }

  return {
    id: typeof value['id'] === 'string' ? value['id'] : generateId(),
    name: value['name'],
    repoUrl: typeof value['repoUrl'] === 'string' ? value['repoUrl'] : '',
    description: typeof value['description'] === 'string' ? value['description'] : '',
    tagPattern: typeof value['tagPattern'] === 'string' ? value['tagPattern'] : '',
    dependencies: Array.isArray(value['dependencies'])
      ? value['dependencies'].map(parseStoredDependency)
      : [],
    collapsed: value['collapsed'] === true,
  };
}

function parseStoredDependency(value: unknown): BuilderDependency {
  if (!isRecord(value) || !value['project']) {
    throw new Error('A locally saved dependency is invalid.');
  }

  return {
    project: parseStoredProject(value['project']),
    manifestPath: typeof value['manifestPath'] === 'string' ? value['manifestPath'] : '',
    versionReference:
      typeof value['versionReference'] === 'string' ? value['versionReference'] : '',
    versionReferenceType: value['versionReferenceType'] === 'regex' ? 'regex' : 'string',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
