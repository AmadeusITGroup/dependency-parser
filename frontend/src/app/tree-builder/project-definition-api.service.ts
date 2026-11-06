import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { BuilderProject, toProjectDefinition } from './tree-builder.models';

export interface ProjectDefinitionResponse {
  id: string;
  name: string;
  repoUrl: string;
  description: string | null;
  tagPattern?: string | null;
  dependencies: ProjectDependencyDefinition[] | null;
}

export interface ProjectDependencyDefinition {
  project: ProjectDefinitionResponse;
  manifestPath: string | null;
  versionReference: string | { pattern: string; flags: string } | null;
}

export interface ProjectListResponse {
  projects: ProjectDefinitionResponse[];
}

export interface ProjectVersion {
  version: string;
  creationDate: string | null;
  commitHash: string | null;
  removed: boolean;
  hasDependencyTree: boolean;
}

export interface ProjectVersionsResponse {
  projectId: string;
  versions: ProjectVersion[];
  latest: ProjectVersion | null;
}

export interface DependencyNodeResponse {
  projectId: string;
  projectName: string;
  version: string;
  creationDate?: string | null;
  dependencies: DependencyNodeResponse[];
  dependenciesResolved?: boolean;
  declaredVersion?: string;
  resolvedVersion?: string | null;
  resolutionCheckedAt?: string;
}

export interface DependencyTreeResponse {
  projectId: string;
  projectName: string;
  version: string;
  tree: DependencyNodeResponse;
}

export interface CommitResponse {
  hash: string;
  subject: string;
  committedAt: string;
  url: string;
}

export interface CommitDiffResponse {
  projectId: string;
  projectName: string;
  fromVersion: string;
  toVersion: string;
  fromCommitHash: string;
  toCommitHash: string;
  fromOnly: CommitResponse[];
  toOnly: CommitResponse[];
}

export interface RootVersionWarning {
  version: string;
  reason: 'tree_unavailable' | 'partial_tree';
  message: string;
  dependencies: (Pick<DependencyNodeResponse, 'projectId' | 'projectName' | 'version'> & {
    reason: 'unknown_version' | 'unretrievable_version';
  })[];
}

export interface FindRootVersionResponse {
  projectId: string;
  dependencyProjectId: string;
  minimumVersion: string;
  checkedVersions: number;
  totalVersions: number;
  warnings: RootVersionWarning[];
  match: {
    version: string;
    dependencyVersion: string;
    path: Pick<DependencyNodeResponse, 'projectId' | 'projectName' | 'version'>[];
    dependencyTree: DependencyTreeResponse;
  } | null;
}

@Injectable({ providedIn: 'root' })
export class ProjectDefinitionApiService {
  private readonly http = inject(HttpClient);
  private readonly projectsUrl = '/api/projects';

  list(): Observable<ProjectListResponse> {
    return this.http.get<ProjectListResponse>(this.projectsUrl);
  }

  get(projectId: string): Observable<ProjectDefinitionResponse> {
    return this.http.get<ProjectDefinitionResponse>(`${this.projectsUrl}/${encodeURIComponent(projectId)}`);
  }

  listVersions(projectId: string, forceRefresh = false): Observable<ProjectVersionsResponse> {
    return this.http.get<ProjectVersionsResponse>(
      `${this.projectsUrl}/${encodeURIComponent(projectId)}/versions`,
      forceRefresh ? { params: { forceRefresh: 'true' } } : {},
    );
  }

  resolveDependencies(projectId: string, version: string): Observable<DependencyTreeResponse> {
    return this.http.get<DependencyTreeResponse>(
      `${this.projectsUrl}/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(version)}/dependencies`,
    );
  }

  findRootVersion(
    projectId: string,
    dependencyProjectId: string,
    minimumVersion: string,
  ): Observable<FindRootVersionResponse> {
    return this.http.get<FindRootVersionResponse>(
      `${this.projectsUrl}/${encodeURIComponent(projectId)}/find-root-version`,
      { params: { dependencyProjectId, minimumVersion } },
    );
  }

  compareCommits(projectId: string, fromVersion: string, toVersion: string): Observable<CommitDiffResponse> {
    return this.http.get<CommitDiffResponse>(
      `${this.projectsUrl}/${encodeURIComponent(projectId)}/commit-diffs`,
      { params: { fromVersion, toVersion } },
    );
  }

  create(project: BuilderProject): Observable<ProjectDefinitionResponse> {
    return this.http.post<ProjectDefinitionResponse>(this.projectsUrl, toProjectDefinition(project));
  }

  update(projectId: string, project: BuilderProject): Observable<ProjectDefinitionResponse> {
    return this.http.put<ProjectDefinitionResponse>(
      `${this.projectsUrl}/${encodeURIComponent(projectId)}`,
      toProjectDefinition(project),
    );
  }

  delete(projectId: string): Observable<void> {
    return this.http.delete<void>(`${this.projectsUrl}/${encodeURIComponent(projectId)}`);
  }
}
