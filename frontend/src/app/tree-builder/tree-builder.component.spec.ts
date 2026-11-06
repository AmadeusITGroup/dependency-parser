import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProjectDefinitionResponse } from './project-definition-api.service';
import { TreeBuilderComponent } from './tree-builder.component';
import {
  activateDraft,
  BuilderDraft,
  clearAllDrafts,
  createDependency,
  createProject,
  loadActiveDraft,
  loadDraft,
  saveDraft,
} from './tree-builder.models';

describe('TreeBuilderComponent', () => {
  const projectsUrl = '/api/projects';
  const selectionKey = 'dep-tree-builder-last-project';
  const project: ProjectDefinitionResponse = {
    id: 'builder-project',
    name: 'Project',
    repoUrl: 'https://example.com/project.git',
    description: null,
    dependencies: null,
  };
  const otherProject: ProjectDefinitionResponse = {
    ...project,
    id: 'other-project',
    name: 'Other project',
    repoUrl: 'https://example.com/other.git',
  };
  let fixture: ComponentFixture<TreeBuilderComponent>;
  let http: HttpTestingController;
  let previousStorage: Map<string, string>;

  beforeEach(async () => {
    previousStorage = new Map();
    for (const key of Object.keys(localStorage)) {
      const value = localStorage.getItem(key);
      if (key.startsWith('dep-tree-builder') && value !== null) {
        previousStorage.set(key, value);
      }
    }
    clearAllDrafts();
    localStorage.removeItem(selectionKey);

    await TestBed.configureTestingModule({
      imports: [TreeBuilderComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
    clearAllDrafts();
    localStorage.removeItem(selectionKey);
    previousStorage.forEach((value, key) => localStorage.setItem(key, value));
    http?.verify();
  });

  function rememberProjectDraft(savedProject = project): BuilderDraft {
    const draft: BuilderDraft = {
      tree: {
        ...createProject(`${savedProject.name} draft`),
        id: savedProject.id,
        repoUrl: savedProject.repoUrl,
        description: 'Unsaved local edits',
        collapsed: true,
      },
      loadedProjectId: savedProject.id,
      saveStatus: 'dirty',
      saveError: null,
    };
    saveDraft(draft);
    localStorage.setItem(selectionKey, savedProject.id);
    return draft;
  }

  function createComponent(): TreeBuilderComponent {
    fixture = TestBed.createComponent(TreeBuilderComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function loadProjects(projects = [project]): void {
    http.expectOne(projectsUrl).flush({ projects });
    fixture.detectChanges();
  }

  function startNewProject(): TreeBuilderComponent {
    const component = createComponent();
    loadProjects();
    component.createRoot();
    const rootId = component.tree()!.id;
    component.setProjectField(rootId, 'name', 'Created project');
    component.setProjectField(rootId, 'repoUrl', 'https://example.com/new.git');
    fixture.detectChanges();
    return component;
  }

  function fileInput(contents: string): HTMLInputElement {
    const transfer = new DataTransfer();
    transfer.items.add(new File([contents], 'project.json', { type: 'application/json' }));
    const input = document.createElement('input');
    input.type = 'file';
    input.files = transfer.files;
    return input;
  }

  function projectPicker(): HTMLSelectElement {
    return (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLSelectElement>('#saved-project-select')!;
  }

  function expectEmptyTree(component: TreeBuilderComponent): void {
    expect(component.tree()).toBeNull();
    expect(component.loadedProjectId).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('.builder-canvas')).toBeNull();
    expect(projectPicker().value).toBe('');
  }

  it('does not display a saved-project draft before availability is confirmed', () => {
    rememberProjectDraft();

    const component = createComponent();
    const request = http.expectOne(projectsUrl);

    expectEmptyTree(component);
    expect(component.projectListStatus()).toBe('loading');
    expect(projectPicker().disabled).toBe(true);
    request.flush({ projects: [project] });
  });

  it('restores an available active draft and selects its project without fetching over local edits', () => {
    const draft: BuilderDraft = {
      ...rememberProjectDraft(),
      saveStatus: 'error',
      saveError: 'The previous save failed.',
    };
    saveDraft(draft);
    localStorage.setItem(selectionKey, otherProject.id);
    const component = createComponent();

    loadProjects([otherProject, project]);

    expect(component.tree()).toEqual(draft.tree);
    expect(component.loadedProjectId).toBe(project.id);
    expect(projectPicker().value).toBe(project.id);
    expect(component.projectSaveStatus()).toBe('error');
    expect(component.projectSaveError()).toBe(draft.saveError);
    expect(localStorage.getItem(selectionKey)).toBe(project.id);
    http.expectNone(`${projectsUrl}/${project.id}`);
  });

  it.each([
    { description: 'an empty project list', projects: [] },
    { description: 'a list containing only other projects', projects: [otherProject] },
  ])('does not restore a removed project from $description', ({ projects }) => {
    rememberProjectDraft();
    const component = createComponent();

    loadProjects(projects);

    expectEmptyTree(component);
    expect(component.projectListStatus()).toBe('ready');
    expect(localStorage.getItem(selectionKey)).toBeNull();
    http.expectNone(`${projectsUrl}/${project.id}`);
    http.expectNone(`${projectsUrl}/${otherProject.id}`);
  });

  it.each([0, 503])('hides the saved tree but retains local edits when listing projects fails (%i)', (status) => {
    const draft = rememberProjectDraft();
    const component = createComponent();
    const request = http.expectOne(projectsUrl);
    if (status === 0) {
      request.error(new ProgressEvent('error'));
    } else {
      request.flush({ error: 'Unavailable' }, { status, statusText: 'Service Unavailable' });
    }
    fixture.detectChanges();

    expectEmptyTree(component);
    expect(component.projectListStatus()).toBe('error');
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent)
      .toContain('Unable to retrieve saved projects.');
    expect(loadActiveDraft()).toEqual(draft);
    expect(localStorage.getItem(selectionKey)).toBe(project.id);
    http.expectNone(`${projectsUrl}/${project.id}`);
  });

  it('restores retained edits when the tab is reopened after an outage', () => {
    const draft = rememberProjectDraft();
    const unavailable = createComponent();
    http.expectOne(projectsUrl).error(new ProgressEvent('error'));
    fixture.detectChanges();
    expectEmptyTree(unavailable);
    fixture.destroy();

    const component = createComponent();
    loadProjects();

    expect(component.tree()).toEqual(draft.tree);
    expect(projectPicker().value).toBe(project.id);
    http.expectNone(`${projectsUrl}/${project.id}`);
  });

  it.each(['available', 'unavailable'])('keeps a new unsaved draft when the server is %s', (availability) => {
    const draft: BuilderDraft = {
      tree: createProject('New unsaved project'),
      loadedProjectId: null,
      saveStatus: 'dirty',
      saveError: null,
    };
    saveDraft(draft);
    const component = createComponent();
    expect(component.tree()).toEqual(draft.tree);

    if (availability === 'available') {
      loadProjects();
    } else {
      http.expectOne(projectsUrl).error(new ProgressEvent('error'));
      fixture.detectChanges();
    }

    expect(component.tree()).toEqual(draft.tree);
    expect(component.loadedProjectId).toBeNull();
    expect(projectPicker().value).toBe('');
    expect(loadDraft(null)).toEqual(draft);
    http.expectNone(`${projectsUrl}/${project.id}`);
  });

  it('loads a remembered project without a draft only after confirming it is available', () => {
    localStorage.setItem(selectionKey, project.id);
    const component = createComponent();
    expectEmptyTree(component);
    http.expectNone(`${projectsUrl}/${project.id}`);

    loadProjects();
    expectEmptyTree(component);
    http.expectOne(`${projectsUrl}/${project.id}`).flush(project);
    fixture.detectChanges();

    expect(component.tree()?.id).toBe(project.id);
    expect(component.tree()?.name).toBe(project.name);
    expect(component.loadedProjectId).toBe(project.id);
    expect(projectPicker().value).toBe(project.id);
  });

  it('clears a remembered selection without loading it when the project was removed', () => {
    localStorage.setItem(selectionKey, project.id);
    const component = createComponent();

    loadProjects([otherProject]);

    expectEmptyTree(component);
    expect(localStorage.getItem(selectionKey)).toBeNull();
    http.expectNone(`${projectsUrl}/${project.id}`);
  });

  it('does not replace a new project created while the saved-project list is loading', () => {
    const savedDraft = rememberProjectDraft();
    const component = createComponent();
    component.createRoot();
    const newTree = component.tree();

    loadProjects();

    expect(component.tree()).toEqual(newTree);
    expect(component.loadedProjectId).toBeNull();
    expect(projectPicker().value).toBe('');
    expect(loadDraft(project.id)).toEqual(savedDraft);
    expect(localStorage.getItem(selectionKey)).toBeNull();
    http.expectNone(`${projectsUrl}/${project.id}`);
  });

  it('does not reopen the old draft after a new project is created and discarded while loading', () => {
    rememberProjectDraft();
    const component = createComponent();
    component.createRoot();
    component.clearAll();

    loadProjects();

    expectEmptyTree(component);
    http.expectNone(`${projectsUrl}/${project.id}`);
  });

  it('keeps independent drafts when switching between available projects', () => {
    const firstDraft = rememberProjectDraft();
    const secondDraft = rememberProjectDraft(otherProject);
    activateDraft(project.id);
    localStorage.setItem(selectionKey, project.id);
    const component = createComponent();
    loadProjects([project, otherProject]);

    projectPicker().value = otherProject.id;
    projectPicker().dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(component.tree()).toEqual(secondDraft.tree);
    expect(component.loadedProjectId).toBe(otherProject.id);
    expect(projectPicker().value).toBe(otherProject.id);
    expect(localStorage.getItem(selectionKey)).toBe(otherProject.id);

    projectPicker().value = project.id;
    projectPicker().dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(component.tree()).toEqual(firstDraft.tree);
    expect(projectPicker().value).toBe(project.id);
    expect(loadDraft(otherProject.id)).toEqual(secondDraft);
    http.expectNone(`${projectsUrl}/${project.id}`);
    http.expectNone(`${projectsUrl}/${otherProject.id}`);
  });

  it('creates the first unused default name and focuses its name input', async () => {
    const component = createComponent();
    loadProjects([
      { ...project, name: 'my-project' },
      { ...otherProject, name: 'my-project-2' },
    ]);

    component.createRoot();
    fixture.detectChanges();

    const root = component.tree()!;
    expect(root.name).toBe('my-project-1');
    expect(loadDraft(null)?.tree).toEqual(root);
    await vi.waitFor(() => {
      expect(document.activeElement?.id).toBe(`project-name-${root.id}`);
      expect(component.pendingFocusId()).toBeNull();
    });
  });

  it('edits dependency metadata, persists changes, and removes only the requested subtree', () => {
    const component = startNewProject();
    const rootId = component.tree()!.id;
    component.addDependencyProject(rootId);
    const childId = component.tree()!.dependencies[0].project.id;
    component.setProjectField(childId, 'name', 'Child');
    component.setDependencyField(childId, 'manifestPath', 'package.json');
    component.setDependencyField(childId, 'versionReference', '^child$');
    component.setVersionReferenceType(childId, 'regex');
    component.setVersionReferenceType(childId, 'unsupported');

    expect(component.tree()!.dependencies[0]).toMatchObject({
      manifestPath: 'package.json', versionReference: '^child$', versionReferenceType: 'regex',
      project: { name: 'Child' },
    });
    expect(component.projectSaveStatus()).toBe('dirty');
    expect(loadDraft(null)?.tree).toEqual(component.tree());

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    component.exportJson();
    expect(click).toHaveBeenCalledOnce();

    component.removeProject(childId);
    expect(component.tree()!.dependencies).toEqual([]);
    component.removeProject(rootId);
    fixture.detectChanges();
    expectEmptyTree(component);
    expect(loadDraft(null)).toBeNull();
    expect(component.projectSaveStatus()).toBe('idle');
  });

  it('changes view state without marking a loaded project as edited', () => {
    const component = createComponent();
    loadProjects();
    component.loadProject(project.id);
    http.expectOne(`${projectsUrl}/${project.id}`).flush({
      ...project,
      dependencies: [{ project: otherProject, manifestPath: null, versionReference: null }],
    });

    component.collapseAllProjects();
    expect(component.tree()!.collapsed).toBe(true);
    expect(component.tree()!.dependencies[0].project.collapsed).toBe(true);
    component.toggle(otherProject.id);
    expect(component.tree()!.dependencies[0].project.collapsed).toBe(false);
    component.expandAllProjects();
    expect(component.tree()!.collapsed).toBe(false);
    expect(component.projectSaveStatus()).toBe('idle');
    expect(loadDraft(project.id)?.tree).toEqual(component.tree());
    expect(component.childAncestors([true], false, 0)).toEqual([]);
    expect(component.childAncestors([true], false, 1)).toEqual([true, false]);
  });

  it('does not perform edits, saves, or deletes when there is no active tree or selection', () => {
    const component = createComponent();
    loadProjects();
    component.addDependencyProject('missing');
    component.removeProject('missing');
    component.setProjectField('missing', 'name', 'Ignored');
    component.setDependencyField('missing', 'manifestPath', 'package.json');
    component.setVersionReferenceType('missing', 'regex');
    component.toggle('missing');
    component.expandAllProjects();
    component.collapseAllProjects();
    component.exportJson();
    component.saveProject();
    component.deleteSelectedProject();
    component.selectProject(document.createElement('select'));
    component.importJson(document.createElement('input'));

    expectEmptyTree(component);
    expect(loadActiveDraft()).toBeNull();
    http.expectNone(request => request.method !== 'GET');
  });

  it.each([false, true])('requires confirmation before replacing a new project (confirmed: %s)', confirmed => {
    const component = startNewProject();
    const original = component.tree();
    vi.spyOn(window, 'confirm').mockReturnValue(confirmed);
    projectPicker().value = project.id;

    component.selectProject(projectPicker());

    if (!confirmed) {
      expect(component.tree()).toBe(original);
      expect(projectPicker().value).toBe('');
      http.expectNone(`${projectsUrl}/${project.id}`);
      return;
    }

    expect(loadDraft(null)).toBeNull();
    http.expectOne(`${projectsUrl}/${project.id}`).flush({
      ...project,
      dependencies: [{
        project: otherProject, manifestPath: 'package.json',
        versionReference: { pattern: '^child$', flags: 'i' },
      }],
    });
    expect(component.loadedProjectId).toBe(project.id);
    expect(component.tree()!.dependencies[0]).toMatchObject({
      manifestPath: 'package.json', versionReference: '/^child$/i', versionReferenceType: 'regex',
    });
  });

  it('creates a project once and replaces the new-project draft with its saved identity', () => {
    const component = startNewProject();
    const root = component.tree()!;
    component.saveProject();
    const request = http.expectOne(projectsUrl);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      id: root.id, name: root.name, repoUrl: root.repoUrl,
      description: null, tagPattern: null, dependencies: null,
    });
    expect(component.isSavingProject()).toBe(true);
    component.saveProject();
    http.expectNone(request => request.method === 'POST');
    const saved = { ...project, id: 'created-project', name: root.name, repoUrl: root.repoUrl };

    request.flush(saved);

    expect(component.loadedProjectId).toBe(saved.id);
    expect(component.tree()!.id).toBe(saved.id);
    expect(component.projectSaveStatus()).toBe('saved');
    expect(component.isSavingProject()).toBe(false);
    expect(loadDraft(null)).toBeNull();
    expect(loadDraft(saved.id)?.saveStatus).toBe('saved');
    expect(component.savedProjects().map(({ name }) => name)).toEqual(['Created project', 'Project']);
  });

  it('updates a loaded project without duplicating it in the picker', () => {
    rememberProjectDraft();
    const component = createComponent();
    loadProjects();
    component.setProjectField(project.id, 'name', 'Updated project');

    component.saveProject();
    const request = http.expectOne(`${projectsUrl}/${project.id}`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body.name).toBe('Updated project');
    request.flush({ ...project, name: 'Updated project' });

    expect(component.savedProjects()).toEqual([{ ...project, name: 'Updated project' }]);
    expect(component.projectSaveStatus()).toBe('saved');
    expect(loadDraft(project.id)?.tree.name).toBe('Updated project');
  });

  it.each([
    { field: 'name', value: ' ', message: 'requires a project name and repository URL' },
    { field: 'repoUrl', value: ' ', message: 'requires a project name and repository URL' },
    { field: 'tagPattern', value: '[', message: 'invalid version tag regex' },
    { field: 'name', value: ' PROJECT ', message: 'already exists' },
  ] as const)('rejects invalid $field before saving', ({ field, value, message }) => {
    const component = startNewProject();
    component.setProjectField(component.tree()!.id, field, value);

    component.saveProject();

    expect(component.projectSaveStatus()).toBe('error');
    expect(component.projectSaveError()).toContain(message);
    expect(loadDraft(null)?.saveError).toBe(component.projectSaveError());
    expect(component.isSavingProject()).toBe(false);
    http.expectNone(request => request.method === 'POST');
  });

  it('validates nested repositories and duplicate sibling names before saving', () => {
    const component = startNewProject();
    const child = { ...createProject('Child'), repoUrl: '' };
    component.tree.set({
      ...component.tree()!, dependencies: [createDependency(child)],
    });
    component.saveProject();
    expect(component.projectSaveError()).toContain('"Child" requires');

    component.tree.set({
      ...component.tree()!,
      dependencies: [
        createDependency({ ...child, repoUrl: 'https://example.com/child.git' }),
        createDependency({ ...createProject(' CHILD '), repoUrl: 'https://example.com/other.git' }),
      ],
    });
    component.saveProject();
    expect(component.projectSaveError()).toContain('more than one direct dependency named');
    http.expectNone(request => request.method === 'POST');
  });

  it.each([
    { response: { error: 'Save denied' }, message: 'Save denied' },
    { response: {}, message: 'Unable to save the project structure.' },
  ])('retains the editable draft when saving fails ($message)', ({ response, message }) => {
    const component = startNewProject();
    const original = component.tree();
    component.saveProject();

    http.expectOne(projectsUrl).flush(response, { status: 500, statusText: 'Server Error' });

    expect(component.tree()).toBe(original);
    expect(component.isSavingProject()).toBe(false);
    expect(component.projectSaveStatus()).toBe('error');
    expect(loadDraft(null)?.saveError).toBe(message);
    expect(component.projectSaveError()).toBe(message);
  });

  it.each([true, false])('deletes only the requested project and draft (selected: %s)', selected => {
    const retainedDraft = rememberProjectDraft(otherProject);
    const activeDraft = rememberProjectDraft();
    const component = createComponent();
    loadProjects([project, otherProject]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deletedId = selected ? project.id : otherProject.id;

    if (selected) component.deleteSelectedProject();
    else component.deleteProject(deletedId);
    const request = http.expectOne(`${projectsUrl}/${deletedId}`);
    expect(request.request.method).toBe('DELETE');
    expect(component.deletingProjectId()).toBe(deletedId);
    component.deleteProject(deletedId);
    http.expectNone(request => request.method === 'DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    fixture.detectChanges();

    expect(component.deletingProjectId()).toBeNull();
    expect(component.savedProjects().map(({ id }) => id)).not.toContain(deletedId);
    expect(loadDraft(deletedId)).toBeNull();
    if (selected) {
      expectEmptyTree(component);
      expect(loadDraft(otherProject.id)).toEqual(retainedDraft);
    } else {
      expect(component.tree()).toEqual(activeDraft.tree);
      expect(loadDraft(project.id)).toEqual(activeDraft);
    }
  });

  it('honors deletion cancellation and exposes server failures without discarding the draft', () => {
    const draft = rememberProjectDraft();
    const component = createComponent();
    loadProjects();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    component.deleteSelectedProject();
    http.expectNone(request => request.method === 'DELETE');
    confirm.mockReturnValue(true);
    component.deleteSelectedProject();

    http.expectOne(`${projectsUrl}/${project.id}`).flush(
      { error: 'Delete denied' }, { status: 403, statusText: 'Forbidden' },
    );

    expect(component.projectListError()).toBe('Delete denied');
    expect(component.deletingProjectId()).toBeNull();
    expect(component.tree()).toEqual(draft.tree);
    expect(component.savedProjects()).toEqual([project]);
  });

  it('discards new edits only after confirmation and reloads saved projects when discarding', () => {
    const component = startNewProject();
    const original = component.tree();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    component.discardChanges();
    expect(component.tree()).toBe(original);
    confirm.mockReturnValue(true);
    component.discardChanges();
    fixture.detectChanges();
    expectEmptyTree(component);

    component.loadProject(project.id);
    http.expectOne(`${projectsUrl}/${project.id}`).flush(project);
    component.setProjectField(project.id, 'name', 'Unsaved name');
    component.discardChanges();
    http.expectOne(`${projectsUrl}/${project.id}`).flush(project);

    expect(component.tree()!.name).toBe(project.name);
    expect(component.projectSaveStatus()).toBe('idle');
    expect(loadDraft(project.id)?.tree.name).toBe(project.name);
  });

  it.each([false, true])('imports JSON without changing an existing saved identity (%s)', async existing => {
    if (existing) rememberProjectDraft();
    const component = createComponent();
    loadProjects();
    const input = fileInput(JSON.stringify({
      name: 'Imported', repoUrl: 'https://example.com/imported.git',
    }));

    component.importJson(input);

    expect(input.value).toBe('');
    await vi.waitFor(() => expect(component.tree()?.name).toBe('Imported'));
    expect(component.loadedProjectId).toBe(existing ? project.id : null);
    if (existing) expect(component.tree()!.id).toBe(project.id);
    expect(component.projectSaveStatus()).toBe('dirty');
    expect(loadDraft(existing ? project.id : null)?.tree).toEqual(component.tree());
  });

  it.each([
    { text: '{broken', message: 'The selected file is not valid JSON.' },
    { text: '{}', message: 'The file is not a valid project definition.' },
  ])('reports invalid imported files ($message)', async ({ text, message }) => {
    const component = createComponent();
    loadProjects();

    component.importJson(fileInput(text));

    await vi.waitFor(() => expect(component.projectListError()).toBe(message));
    expect(component.tree()).toBeNull();
    expect(loadDraft(null)).toBeNull();
  });
});
