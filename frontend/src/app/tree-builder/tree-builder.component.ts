import { NgTemplateOutlet } from '@angular/common';
import { Component, inject, OnDestroy, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';

import {
  activateDraft,
  addDependency,
  BuilderDraft,
  BuilderProject,
  clearDraft,
  collapseAll,
  createDependency,
  createProject,
  DependencyField,
  expandAll,
  exportToJson,
  importProjectDefinition,
  findDuplicateDependencyName,
  loadActiveDraft,
  loadDraft,
  nextProjectName,
  ProjectDraftStatus,
  ProjectField,
  removeProject,
  saveDraft,
  toggleCollapse,
  updateDependency,
  updateProject,
} from './tree-builder.models';
import {
  ProjectDefinitionApiService,
  ProjectDefinitionResponse,
} from './project-definition-api.service';

type ProjectListStatus = 'loading' | 'ready' | 'error';
const LAST_SELECTED_PROJECT_KEY = 'dep-tree-builder-last-project';

@Component({
  selector: 'app-tree-builder',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './tree-builder.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './tree-builder.component.css',
})
export class TreeBuilderComponent implements OnInit, OnDestroy {
  readonly tree = signal<BuilderProject | null>(null);
  readonly projectSaveStatus = signal<ProjectDraftStatus>('idle');
  readonly projectSaveError = signal<string | null>(null);
  readonly isSavingProject = signal(false);
  readonly savedProjects = signal<ProjectDefinitionResponse[]>([]);
  readonly projectListStatus = signal<ProjectListStatus>('loading');
  readonly projectListError = signal<string | null>(null);
  readonly deletingProjectId = signal<string | null>(null);
  readonly pendingFocusId = signal<string | null>(null);

  private readonly projectApi = inject(ProjectDefinitionApiService);
  loadedProjectId: string | null = null;
  private focusTimer?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    const draft = loadActiveDraft();
    if (draft && draft.loadedProjectId === null) {
      this.restoreDraft(draft);
    }
    this.loadSavedProjects();
  }

  ngOnDestroy(): void {
    clearTimeout(this.focusTimer);
  }

  createRoot(): void {
    const root = createProject(nextProjectName(this.savedProjects().map(({ name }) => name)));
    this.loadedProjectId = null;
    localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
    this.commitEdit(root);
    this.scheduleFocus(root.id);
  }

  selectProject(selectElement: HTMLSelectElement): void {
    const projectId = selectElement.value;
    if (!projectId) return;
    const projectName = this.savedProjects().find((project) => project.id === projectId)?.name;

    if (this.tree() && !this.loadedProjectId) {
      const confirmed = window.confirm(
        `Discard this new project and open "${projectName ?? 'the selected project'}"? This cannot be undone.`,
      );
      if (!confirmed) {
        selectElement.value = '';
        return;
      }

      this.clearAll();
    }

    const draft = loadDraft(projectId);
    if (draft) {
      this.restoreDraft(draft);
      activateDraft(projectId);
      localStorage.setItem(LAST_SELECTED_PROJECT_KEY, projectId);
      return;
    }

    this.loadProject(projectId);
  }

  deleteSelectedProject(): void {
    if (this.loadedProjectId) this.deleteProject(this.loadedProjectId);
  }

  discardChanges(): void {
    const message = this.loadedProjectId
      ? `Discard unsaved changes to "${this.tree()?.name ?? 'this project'}"? This cannot be undone.`
      : 'Discard this new project? This cannot be undone.';
    if (!window.confirm(message)) return;

    if (this.loadedProjectId) {
      this.loadProject(this.loadedProjectId);
      return;
    }

    this.clearAll();
  }

  addDependencyProject(parentId: string): void {
    const current = this.tree();
    if (!current) return;

    const dependency = createDependency();
    this.commitEdit(addDependency(current, parentId, dependency));
    this.scheduleFocus(dependency.project.id);
  }

  removeProject(projectId: string): void {
    const current = this.tree();
    if (!current) return;
    if (current.id === projectId) {
      this.clearAll();
      return;
    }
    this.commitEdit(removeProject(current, projectId));
  }

  setProjectField(projectId: string, field: ProjectField, value: string): void {
    const current = this.tree();
    if (!current) return;
    this.commitEdit(updateProject(current, projectId, field, value));
  }

  setDependencyField(projectId: string, field: DependencyField, value: string): void {
    const current = this.tree();
    if (!current) return;
    this.commitEdit(updateDependency(current, projectId, { [field]: value }));
  }

  setVersionReferenceType(projectId: string, value: string): void {
    if (value !== 'string' && value !== 'regex') return;
    const current = this.tree();
    if (!current) return;
    this.commitEdit(
      updateDependency(current, projectId, {
        versionReferenceType: value,
      }),
    );
  }

  toggle(projectId: string): void {
    const current = this.tree();
    if (!current) return;
    this.commitViewState(toggleCollapse(current, projectId));
  }

  expandAllProjects(): void {
    const current = this.tree();
    if (!current) return;
    this.commitViewState(expandAll(current));
  }

  collapseAllProjects(): void {
    const current = this.tree();
    if (!current) return;
    this.commitViewState(collapseAll(current));
  }

  clearAll(): void {
    clearDraft(this.loadedProjectId);
    this.tree.set(null);
    this.loadedProjectId = null;
    localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
    this.resetProjectSaveState();
  }

  exportJson(): void {
    const current = this.tree();
    if (!current) return;
    exportToJson(current);
  }

  importJson(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    void file.text().then((text) => {
      try {
        const imported = importProjectDefinition(JSON.parse(text));
        const current = this.tree();
        this.projectListError.set(null);
        this.commitEdit(current ? { ...imported, id: current.id } : imported);
      } catch (error) {
        this.projectListError.set(
          error instanceof SyntaxError
            ? 'The selected file is not valid JSON.'
            : error instanceof Error
              ? error.message
              : 'Unable to import the project.',
        );
      }
    });
  }

  loadProject(projectId: string): void {
    this.projectApi.get(projectId).subscribe({
      next: (project) => {
        this.openProject(this.toBuilderProject(project), project.id);
      },
      error: (error: { error?: { error?: unknown } }) => {
        const message = error.error?.error;
        this.projectListError.set(
          typeof message === 'string' ? message : 'Unable to load the project structure.',
        );
      },
    });
  }

  deleteProject(projectId: string): void {
    const projectName =
      this.savedProjects().find((project) => project.id === projectId)?.name ?? 'this project';
    if (
      this.deletingProjectId() ||
      !window.confirm(`Delete "${projectName}" and its saved dependency history? This cannot be undone.`)
    ) {
      return;
    }

    this.deletingProjectId.set(projectId);
    this.projectListError.set(null);
    this.projectApi.delete(projectId).subscribe({
      next: () => {
        this.savedProjects.set(this.savedProjects().filter((project) => project.id !== projectId));
        if (this.loadedProjectId === projectId) {
          this.clearAll();
        } else {
          clearDraft(projectId);
        }
        this.deletingProjectId.set(null);
      },
      error: (error: { error?: { error?: unknown } }) => {
        const message = error.error?.error;
        this.projectListError.set(
          typeof message === 'string' ? message : 'Unable to delete the saved project.',
        );
        this.deletingProjectId.set(null);
      },
    });
  }

  saveProject(): void {
    const current = this.tree();
    if (!current || this.isSavingProject()) return;

    const validationError = this.validateProject(current);
    if (validationError) {
      this.projectSaveError.set(validationError);
      this.projectSaveStatus.set('error');
      this.persistDraft(current);
      return;
    }

    this.isSavingProject.set(true);
    this.projectSaveError.set(null);
    const request = this.loadedProjectId
      ? this.projectApi.update(this.loadedProjectId, current)
      : this.projectApi.create(current);

    request.subscribe({
      next: (project) => {
        const previousProjectId = this.loadedProjectId;
        const savedTree = this.toBuilderProject(project);
        this.loadedProjectId = project.id;
        if (previousProjectId !== project.id) clearDraft(previousProjectId);
        localStorage.setItem(LAST_SELECTED_PROJECT_KEY, project.id);
        this.upsertSavedProject(project);
        this.tree.set(savedTree);
        this.projectSaveStatus.set('saved');
        this.isSavingProject.set(false);
        this.persistDraft(savedTree);
      },
      error: (error: { error?: { error?: unknown } }) => {
        const message = error.error?.error;
        this.projectSaveError.set(
          typeof message === 'string' ? message : 'Unable to save the project structure.',
        );
        this.projectSaveStatus.set('error');
        this.isSavingProject.set(false);
        this.persistDraft(current);
      },
    });
  }

  childAncestors(ancestorIsLast: boolean[], parentIsLast: boolean, depth: number): boolean[] {
    if (depth === 0) return [];
    return ancestorIsLast.concat(parentIsLast);
  }

  private commitEdit(tree: BuilderProject): void {
    this.projectSaveError.set(null);
    this.projectSaveStatus.set('dirty');
    this.commitViewState(tree);
  }

  private commitViewState(tree: BuilderProject): void {
    this.tree.set(tree);
    this.persistDraft(tree);
  }

  private openProject(tree: BuilderProject, projectId: string): void {
    this.loadedProjectId = projectId;
    this.resetProjectSaveState();
    this.commitViewState(tree);
    localStorage.setItem(LAST_SELECTED_PROJECT_KEY, projectId);
  }

  private restoreDraft(draft: BuilderDraft): void {
    this.tree.set(draft.tree);
    this.loadedProjectId = draft.loadedProjectId;
    this.projectSaveStatus.set(draft.saveStatus);
    this.projectSaveError.set(draft.saveError);
  }

  private persistDraft(tree: BuilderProject): void {
    try {
      saveDraft({
        tree,
        loadedProjectId: this.loadedProjectId,
        saveStatus: this.projectSaveStatus(),
        saveError:
          this.projectSaveStatus() === 'error' ? this.projectSaveError() : null,
      });
    } catch (error) {
      console.error('Unable to save the project draft locally.', error);
    }
  }

  private resetProjectSaveState(): void {
    this.projectSaveStatus.set('idle');
    this.projectSaveError.set(null);
  }

  private scheduleFocus(projectId: string): void {
    this.pendingFocusId.set(projectId);
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      const input = document.getElementById(
        `project-name-${projectId}`,
      ) as HTMLInputElement | null;
      input?.focus();
      input?.select();
      this.pendingFocusId.set(null);
    }, 0);
  }

  private validateProject(project: BuilderProject): string | null {
    const normalizedProjectName = project.name.trim().toLocaleLowerCase();
    const duplicateProject = this.savedProjects().some(
      (savedProject) =>
        savedProject.id !== this.loadedProjectId &&
        savedProject.name.trim().toLocaleLowerCase() === normalizedProjectName,
    );
    if (duplicateProject) {
      return `A project named "${project.name.trim()}" already exists.`;
    }

    const duplicateDependencyName = findDuplicateDependencyName(project);
    if (duplicateDependencyName !== null) {
      return `A project node contains more than one direct dependency named "${duplicateDependencyName}".`;
    }

    return this.validateProjectTree(project);
  }

  private validateProjectTree(project: BuilderProject): string | null {
    if (!project.name.trim() || !project.repoUrl.trim()) {
      return `"${project.name.trim() || 'Unnamed project'}" requires a project name and repository URL.`;
    }

    const tagPattern = project.tagPattern.trim();
    if (tagPattern) {
      try {
        new RegExp(tagPattern);
      } catch {
        return `"${project.name.trim()}" has an invalid version tag regex.`;
      }
    }

    for (const dependency of project.dependencies) {
      const error = this.validateProjectTree(dependency.project);
      if (error) return error;
    }

    return null;
  }

  private toBuilderProject(project: ProjectDefinitionResponse): BuilderProject {
    return {
      id: project.id,
      name: project.name,
      repoUrl: project.repoUrl,
      description: project.description ?? '',
      tagPattern: project.tagPattern ?? '',
      dependencies: (project.dependencies ?? []).map((dependency) => {
        const reference = dependency.versionReference;
        return {
          project: this.toBuilderProject(dependency.project),
          manifestPath: dependency.manifestPath ?? '',
          versionReference:
            typeof reference === 'string'
              ? reference
              : reference
                ? `/${reference.pattern}/${reference.flags}`
                : '',
          versionReferenceType: typeof reference === 'object' && reference ? 'regex' : 'string',
        };
      }),
      collapsed: false,
    };
  }

  private loadSavedProjects(): void {
    this.projectListStatus.set('loading');
    this.projectListError.set(null);
    this.projectApi.list().subscribe({
      next: ({ projects }) => {
        const sortedProjects = [...projects].sort((left, right) => left.name.localeCompare(right.name));
        this.savedProjects.set(sortedProjects);
        this.projectListStatus.set('ready');
        const draft = loadActiveDraft();
        const lastSelectedProject =
          draft?.loadedProjectId ?? localStorage.getItem(LAST_SELECTED_PROJECT_KEY);
        if (
          !this.tree() &&
          lastSelectedProject &&
          sortedProjects.some(({ id }) => id === lastSelectedProject)
        ) {
          if (draft && draft.loadedProjectId === lastSelectedProject) {
            this.restoreDraft(draft);
            localStorage.setItem(LAST_SELECTED_PROJECT_KEY, lastSelectedProject);
          } else {
            this.loadProject(lastSelectedProject);
          }
        } else if (lastSelectedProject) {
          localStorage.removeItem(LAST_SELECTED_PROJECT_KEY);
        }
      },
      error: () => {
        this.projectListError.set('Unable to retrieve saved projects.');
        this.projectListStatus.set('error');
      },
    });
  }

  private upsertSavedProject(project: ProjectDefinitionResponse): void {
    const projects = this.savedProjects().filter((item) => item.id !== project.id);
    projects.push(project);
    this.savedProjects.set(projects.sort((left, right) => left.name.localeCompare(right.name)));
  }
}
