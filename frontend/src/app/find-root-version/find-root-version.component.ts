import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, OnDestroy, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';
import { Subscription } from 'rxjs';

import { DependencyTreeComponent } from '../dependency-tree/dependency-tree.component';
import {
  DependencyNodeResponse,
  FindRootVersionResponse,
  ProjectDefinitionApiService,
  ProjectDefinitionResponse,
  RootVersionWarning,
} from '../tree-builder/project-definition-api.service';

const LAST_RESULT_KEY = 'dep-root-version:last-result';

@Component({
  selector: 'app-find-root-version',
  standalone: true,
  imports: [DatePipe, DependencyTreeComponent],
  templateUrl: './find-root-version.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './find-root-version.component.css',
})
export class FindRootVersionComponent implements OnInit, OnDestroy {
  private readonly projectApi = inject(ProjectDefinitionApiService);
  private projectsSub?: Subscription;
  private searchSub?: Subscription;

  readonly projects = signal<ProjectDefinitionResponse[]>([]);
  readonly projectsStatus = signal<'loading' | 'ready' | 'error'>('loading');
  readonly projectsError = signal<string | null>(null);
  readonly projectId = signal('');
  readonly dependencyProjectId = signal('');
  readonly minimumVersion = signal('');
  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly searchError = signal<string | null>(null);
  readonly storageError = signal<string | null>(null);
  readonly result = signal<FindRootVersionResponse | null>(null);
  readonly selectedProject = computed(() =>
    this.projects().find(project => project.id === this.projectId()),
  );
  readonly dependencies = computed(() => {
    const root = this.selectedProject();
    const descendants = new Map<string, ProjectDefinitionResponse>();
    const visited = new Set(root ? [root.id] : []);
    const visit = (project: ProjectDefinitionResponse): void => {
      for (const dependency of project.dependencies ?? []) {
        if (visited.has(dependency.project.id)) continue;
        visited.add(dependency.project.id);
        descendants.set(dependency.project.id, dependency.project);
        visit(dependency.project);
      }
    };
    if (root) visit(root);
    return [...descendants.values()].sort((left, right) => left.name.localeCompare(right.name));
  });
  readonly selectedDependency = computed(() =>
    this.dependencies().find(project => project.id === this.dependencyProjectId()),
  );
  readonly repositoryUrls = computed(() => {
    const projects = this.selectedProject() ? [this.selectedProject()!, ...this.dependencies()] : [];
    return new Map(projects.filter(project => project.repoUrl.trim())
      .map(project => [project.id, project.repoUrl]));
  });
  readonly canSearch = computed(() =>
    this.projectsStatus() === 'ready' && !!this.selectedProject() && !!this.selectedDependency()
      && !!this.minimumVersion().trim() && this.status() !== 'loading',
  );

  ngOnInit(): void {
    this.loadProjects();
  }

  ngOnDestroy(): void {
    this.projectsSub?.unsubscribe();
    this.searchSub?.unsubscribe();
  }

  loadProjects(): void {
    this.projectsSub?.unsubscribe();
    this.resetSearch(false);
    this.projectsStatus.set('loading');
    this.projectsError.set(null);
    this.projectsSub = this.projectApi.list().subscribe({
      next: ({ projects }) => {
        this.projects.set([...projects].sort((left, right) => left.name.localeCompare(right.name)));
        if (!projects.some(project => project.id === this.projectId())) {
          this.projectId.set(this.projects()[0]?.id ?? '');
          this.dependencyProjectId.set('');
        }
        this.projectsStatus.set('ready');
        this.restoreLastResult();
      },
      error: () => {
        this.projectsError.set('Unable to retrieve saved projects.');
        this.projectsStatus.set('error');
      },
    });
  }

  selectProject(projectId: string): void {
    this.resetSearch();
    this.projectId.set(projectId);
    this.dependencyProjectId.set('');
  }

  selectDependency(projectId: string): void {
    this.resetSearch();
    this.dependencyProjectId.set(projectId);
  }

  setMinimumVersion(version: string): void {
    this.resetSearch();
    this.minimumVersion.set(version);
  }

  search(): void {
    if (!this.canSearch()) return;
    this.resetSearch();
    this.status.set('loading');
    this.searchSub = this.projectApi.findRootVersion(
      this.projectId(), this.dependencyProjectId(), this.minimumVersion().trim(),
    ).subscribe({
      next: result => {
        this.result.set(result);
        this.status.set('ready');
        this.storeLastResult(result);
      },
      error: (error: unknown) => {
        const body: unknown = error instanceof HttpErrorResponse ? error.error : null;
        this.searchError.set(
          typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error : 'Unable to search project releases.',
        );
        this.status.set('error');
      },
    });
  }

  private restoreLastResult(): void {
    let stored: string | null;
    try {
      stored = localStorage.getItem(LAST_RESULT_KEY);
    } catch (error) {
      this.reportStorageError('Unable to read the saved search result from browser storage.', error);
      return;
    }
    if (stored === null) return;

    let savedResult: FindRootVersionResponse;
    try {
      const value: unknown = JSON.parse(stored);
      if (!isRootVersionResult(value)) {
        throw new Error('The saved root-version result has an unsupported format.');
      }
      savedResult = value;
    } catch (error) {
      this.reportStorageError('The saved search result could not be restored. Please run a new search.', error);
      this.clearStoredResult();
      return;
    }

    const currentProjectId = this.projectId();
    this.projectId.set(savedResult.projectId);
    if (!this.selectedProject() || !this.dependencies().some(project => project.id === savedResult.dependencyProjectId)) {
      this.projectId.set(currentProjectId);
      const message = 'The saved search result cannot be restored because its project or dependency is no longer configured.';
      console.warn(message);
      this.storageError.set(message);
      this.clearStoredResult();
      return;
    }

    this.dependencyProjectId.set(savedResult.dependencyProjectId);
    this.minimumVersion.set(savedResult.minimumVersion);
    this.result.set(savedResult);
    this.status.set('ready');
    this.storageError.set(null);
  }

  private storeLastResult(result: FindRootVersionResponse): void {
    try {
      localStorage.setItem(LAST_RESULT_KEY, JSON.stringify(result));
      this.storageError.set(null);
    } catch (error) {
      this.reportStorageError(
        'Unable to save this result in browser storage. It may be lost when leaving this tab.',
        error,
      );
    }
  }

  private clearStoredResult(): void {
    try {
      localStorage.removeItem(LAST_RESULT_KEY);
    } catch (error) {
      this.reportStorageError(
        'Unable to clear the saved search result in browser storage. The previous result may return when reopening this tab.',
        error,
      );
    }
  }

  private reportStorageError(message: string, error: unknown): void {
    console.error(message, error);
    this.storageError.set(message);
  }

  private resetSearch(clearSavedResult = true): void {
    this.searchSub?.unsubscribe();
    this.result.set(null);
    this.searchError.set(null);
    this.storageError.set(null);
    this.status.set('idle');
    if (clearSavedResult) this.clearStoredResult();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isVersionedProject(
  value: unknown,
): value is Pick<DependencyNodeResponse, 'projectId' | 'projectName' | 'version'> {
  return isRecord(value)
    && isNonEmptyString(value['projectId'])
    && isNonEmptyString(value['projectName'])
    && isNonEmptyString(value['version']);
}

function isDependencyNode(value: unknown): value is DependencyNodeResponse {
  if (!isRecord(value)) return false;
  const dependencies = value['dependencies'];
  const resolved = value['dependenciesResolved'];
  const creationDate = value['creationDate'];
  return isVersionedProject(value)
    && Array.isArray(dependencies)
    && dependencies.every(isDependencyNode)
    && (resolved === undefined || typeof resolved === 'boolean')
    && (creationDate === undefined || creationDate === null
      || (typeof creationDate === 'string' && Number.isFinite(Date.parse(creationDate))));
}

function isRootVersionWarning(value: unknown): value is RootVersionWarning {
  return isRecord(value)
    && isNonEmptyString(value['version'])
    && (value['reason'] === 'tree_unavailable' || value['reason'] === 'partial_tree')
    && typeof value['message'] === 'string'
    && Array.isArray(value['dependencies'])
    && value['dependencies'].every(dependency => isVersionedProject(dependency)
      && 'reason' in dependency
      && (dependency.reason === 'unknown_version' || dependency.reason === 'unretrievable_version'));
}

function isVersionCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRootVersionResult(value: unknown): value is FindRootVersionResponse {
  if (!isRecord(value)
    || !isNonEmptyString(value['projectId'])
    || !isNonEmptyString(value['dependencyProjectId'])
    || !isNonEmptyString(value['minimumVersion'])
    || !isVersionCount(value['checkedVersions'])
    || !isVersionCount(value['totalVersions'])
    || value['checkedVersions'] > value['totalVersions']
    || !Array.isArray(value['warnings'])
    || !value['warnings'].every(isRootVersionWarning)) {
    return false;
  }

  const match = value['match'];
  if (match === null) return true;
  if (!isRecord(match)
    || !isNonEmptyString(match['version'])
    || !isNonEmptyString(match['dependencyVersion'])
    || !Array.isArray(match['path'])
    || !match['path'].every(isVersionedProject)
    || !match['path'].length) {
    return false;
  }

  const tree = match['dependencyTree'];
  const first = match['path'][0];
  const last = match['path'][match['path'].length - 1];
  return isVersionedProject(tree)
    && tree.projectId === value['projectId']
    && tree.version === match['version']
    && 'tree' in tree
    && isDependencyNode(tree.tree)
    && tree.tree.projectId === tree.projectId
    && tree.tree.version === tree.version
    && first.projectId === value['projectId']
    && first.version === match['version']
    && last.projectId === value['dependencyProjectId']
    && last.version === match['dependencyVersion'];
}
