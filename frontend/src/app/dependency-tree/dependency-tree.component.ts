import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  OnInit,
  signal,
  untracked,
  viewChildren,
  ChangeDetectionStrategy
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';

import {
  collectAllNodeIds,
  CommitComparisonTarget,
  compareTrees,
  DepTreeNode,
  flattenTree,
  FlatDepNode,
  ProjectTree,
} from './dependency-tree.models';
import { CommitDiffDialogComponent } from './commit-diff-dialog.component';
import {
  DependencyNodeResponse,
  DependencyTreeResponse,
  ProjectDefinitionApiService,
  ProjectDefinitionResponse,
  ProjectVersion,
} from '../tree-builder/project-definition-api.service';

const MAX_VISIBLE_VERSIONS = 200;
const LAST_SELECTION_KEY = 'dep-tree:last-selection';

type VersionColumn = 'baseline' | 'comparison';

interface LastSelection {
  projectId: string;
  version: string;
  comparisonEnabled: boolean;
  comparisonVersion: string;
}

@Component({
  selector: 'app-dependency-tree',
  standalone: true,
  imports: [DatePipe, NgTemplateOutlet, CommitDiffDialogComponent],
  templateUrl: './dependency-tree.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './dependency-tree.component.css',
  host: {
    '(document:keydown.escape)': 'closeTagDetails()',
    '(document:pointerdown)': 'onTagDetailsPointerDown($event)',
    '(window:resize)': 'positionTagDetails()',
    '(window:scroll)': 'positionTagDetails()',
  },
})
export class DependencyTreeComponent implements OnInit, OnDestroy {
  private static nextTagDetailsId = 0;
  readonly tagDetailsPrefix = `tree-tag-details-${DependencyTreeComponent.nextTagDetailsId++}`;
  readonly providedTree = input<DependencyTreeResponse | null>(null);
  readonly providedRepositoryUrls = input<ReadonlyMap<string, string>>(new Map());
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly projectApi = inject(ProjectDefinitionApiService);
  private routeSub?: Subscription;
  private versionsSub?: Subscription;
  private dependencyTreeSub?: Subscription;
  private comparisonSub?: Subscription;
  private activeTagDetails?: { trigger: HTMLElement; popover: HTMLElement };

  readonly projectTrees = signal<ProjectTree[]>([]);
  readonly projectRepositoryUrls = signal<ReadonlyMap<string, string>>(new Map());
  readonly repositoryUrls = computed(() =>
    this.providedTree() ? this.providedRepositoryUrls() : this.projectRepositoryUrls(),
  );
  readonly projectListStatus = signal<'loading' | 'ready' | 'error'>('loading');
  readonly projectListError = signal<string | null>(null);
  readonly projectId = signal('');
  readonly selectedProjectName = computed(
    () => this.projectTrees().find((tree) => tree.projectId === this.projectId())?.projectName
      ?? this.projectId(),
  );

  readonly versions = signal<ProjectVersion[]>([]);
  readonly versionStatus = signal<'idle' | 'loading' | 'refreshing' | 'ready' | 'error'>('idle');
  readonly versionsBusy = computed(
    () => this.versionStatus() === 'loading' || this.versionStatus() === 'refreshing',
  );
  readonly versionError = signal<string | null>(null);
  readonly selectedVersion = signal('');
  readonly resolvedTree = signal<ProjectTree | null>(null);
  readonly dependencyTreeStatus = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly dependencyTreeError = signal<string | null>(null);
  readonly copiedNodeId = signal<string | null>(null);
  readonly copiedColumn = signal<'baseline' | 'comparison'>('baseline');
  readonly copyFeedback = signal('');
  readonly comparisonEnabled = signal(false);
  readonly comparisonVersion = signal('');
  readonly comparisonTree = signal<ProjectTree | null>(null);
  readonly comparisonStatus = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly comparisonError = signal<string | null>(null);
  readonly changelogTarget = signal<CommitComparisonTarget | null>(null);
  readonly comparisonVersions = computed(() =>
    this.versions().filter((version) => version.version !== this.selectedVersion()),
  );
  readonly comparing = computed(() => this.comparisonEnabled() && !!this.comparisonTree());
  readonly displayRoot = computed(() => {
    const root = this.currentTree()?.root;
    const comparison = this.comparisonTree();
    return root && this.comparing() && comparison ? compareTrees(root, comparison.root) : root;
  });
  readonly versionListOpen = signal(false);
  readonly versionQuery = signal('');
  readonly versionHighlight = signal(0);
  readonly comparisonListOpen = signal(false);
  readonly comparisonQuery = signal('');
  readonly comparisonHighlight = signal(0);
  readonly versionPickers = {
    baseline: { open: this.versionListOpen, query: this.versionQuery, highlight: this.versionHighlight },
    comparison: { open: this.comparisonListOpen, query: this.comparisonQuery, highlight: this.comparisonHighlight },
  };
  private readonly versionInputs = viewChildren<ElementRef<HTMLInputElement>>('versionPickerInput');

  readonly filteredVersions = computed(() =>
    this.filterVersionOptions(this.versions(), this.versionQuery(), this.selectedVersion()),
  );
  readonly filteredComparisonVersions = computed(() =>
    this.filterVersionOptions(this.comparisonVersions(), this.comparisonQuery(), this.comparisonVersion()),
  );

  readonly versionPlaceholder = computed(() => {
    if (this.versionStatus() === 'loading') return 'Loading versions...';
    if (!this.versions().length) return 'No versions available.';
    return this.versionListOpen() ? this.selectedVersion() || 'Search versions...' : 'Select a version';
  });
  readonly comparisonPlaceholder = computed(() => {
    if (this.versionStatus() === 'loading') return 'Loading versions...';
    if (!this.comparisonVersions().length) return 'No other versions available.';
    return this.comparisonListOpen() ? this.comparisonVersion() || 'Search versions...' : 'Select a version';
  });
  readonly currentTree = computed(() => {
    const provided = this.providedTree();
    if (provided) {
      return this.createProjectTree(this.toResolvedDepTreeNode(provided.tree), provided.version);
    }
    if (this.selectedVersion()) {
      const tree = this.resolvedTree();
      return tree?.projectId === this.projectId() && tree.release === this.selectedVersion()
        ? tree
        : undefined;
    }
    return this.projectTrees().find((tree) => tree.projectId === this.projectId());
  });

  readonly expandedIds = signal<ReadonlySet<string>>(new Set());

  readonly filter = signal('');

  readonly flatNodes = computed<FlatDepNode[]>(() => {
    const root = this.displayRoot();
    if (!root) return [];
    return flattenTree(root, this.expandedIds(), this.filter());
  });

  readonly visibleNodes = computed<FlatDepNode[]>(() => {
    const f = this.filter().toLowerCase().trim();
    if (!f) return this.flatNodes();
    // When filtering: show all nodes but mark matches; dim non-matches
    return this.flatNodes();
  });

  readonly matchCount = computed(() => {
    if (!this.filter().trim()) return null;
    return this.flatNodes().filter((n) => n.matchesFilter).length;
  });

  constructor() {
    effect(() => {
      this.visibleNodes();
      untracked(() => this.closeTagDetails());
    });

    effect(() => {
      const root = this.displayRoot();
      untracked(() => {
        this.changelogTarget.set(null);
        if (root) {
          this.expandedIds.set(new Set(collectAllNodeIds(root)));
          this.filter.set('');
          this.copiedNodeId.set(null);
          this.copyFeedback.set('');
        }
      });
    });

    effect(() => {
      if (this.providedTree()) return;
      const projectId = this.projectId();
      untracked(() => this.loadVersions(projectId));
    });

    effect(() => {
      if (this.providedTree()) return;
      const projectId = this.projectId();
      const version = this.selectedVersion();
      untracked(() => this.loadDependencyTree(projectId, version));
    });

    effect(() => {
      if (this.providedTree()) return;
      const projectId = this.projectId();
      const version = this.comparisonEnabled() ? this.comparisonVersion() : '';
      untracked(() => this.loadComparison(projectId, version));
    });
  }

  ngOnInit(): void {
    if (this.providedTree()) {
      this.projectListStatus.set('ready');
      return;
    }
    this.routeSub = this.route.paramMap.subscribe((params) => {
      this.projectId.set(params.get('projectId') ?? '');
    });
    this.loadProjectTrees();
  }

  ngOnDestroy(): void {
    this.closeTagDetails();
    this.routeSub?.unsubscribe();
    this.versionsSub?.unsubscribe();
    this.dependencyTreeSub?.unsubscribe();
    this.comparisonSub?.unsubscribe();
  }

  showTagDetails(trigger: HTMLElement, popover: HTMLElement): void {
    if (this.activeTagDetails?.popover !== popover) {
      this.closeTagDetails();
    }
    this.activeTagDetails = { trigger, popover };
    if (!popover.matches(':popover-open')) {
      popover.showPopover();
    }
    this.positionTagDetails();
  }

  closeTagDetails(): void {
    const popover = this.activeTagDetails?.popover;
    if (popover?.matches(':popover-open')) {
      popover.hidePopover();
    }
    this.activeTagDetails = undefined;
  }

  positionTagDetails(): void {
    const details = this.activeTagDetails;
    if (!details) return;
    const anchor = details.trigger.getBoundingClientRect();
    const scrollArea = details.trigger.closest('.tree-scroll')?.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    if (!details.trigger.isConnected || anchor.bottom <= 0 || anchor.top >= viewportHeight
      || (scrollArea && (anchor.right <= scrollArea.left || anchor.left >= scrollArea.right))) {
      this.closeTagDetails();
      return;
    }
    const bounds = details.popover.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const left = Math.max(margin, Math.min(anchor.right - bounds.width, viewportWidth - bounds.width - margin));
    const above = anchor.top - bounds.height - gap;
    const top = above >= margin ? above
      : Math.max(margin, Math.min(anchor.bottom + gap, viewportHeight - bounds.height - margin));
    details.popover.style.left = `${left}px`;
    details.popover.style.top = `${top}px`;
  }

  onTagDetailsPointerDown(event: PointerEvent): void {
    const details = this.activeTagDetails;
    if (details && event.target instanceof Node
      && !details.trigger.contains(event.target) && !details.popover.contains(event.target)) {
      this.closeTagDetails();
    }
  }

  toggleNode(node: FlatDepNode): void {
    if (!node.hasChildren) return;
    const ids = new Set(this.expandedIds());
    if (ids.has(node.id)) {
      // Collapse this node and all its descendants
      for (const id of [...ids]) {
        if (id === node.id || id.startsWith(node.id + '/')) {
          ids.delete(id);
        }
      }
    } else {
      ids.add(node.id);
    }
    this.expandedIds.set(ids);
  }

  expandAll(): void {
    const root = this.displayRoot();
    if (!root) return;
    this.expandedIds.set(new Set(collectAllNodeIds(root)));
  }

  collapseAll(): void {
    const root = this.displayRoot();
    if (!root) return;
    this.filter.set('');
    this.expandedIds.set(new Set<string>());
  }

  setFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  selectProject(select: HTMLSelectElement): void {
    if (select.value) {
      void this.router.navigate(['/tree', select.value]);
    }
  }

  openVersionList(column: VersionColumn = 'baseline'): void {
    const picker = this.versionPickers[column];
    if (picker.open()) return;
    this.closeVersionList(column === 'baseline' ? 'comparison' : 'baseline');
    picker.query.set('');
    picker.open.set(true);
    const selected = column === 'comparison' ? this.comparisonVersion() : this.selectedVersion();
    const options = column === 'comparison' ? this.filteredComparisonVersions() : this.filteredVersions();
    this.moveVersionHighlight(options.items.findIndex(item => item.version.version === selected), column);
  }

  closeVersionList(column: VersionColumn = 'baseline'): void {
    const picker = this.versionPickers[column];
    picker.open.set(false);
    picker.query.set('');
  }

  onVersionPickerFocusOut(event: FocusEvent, column: VersionColumn): void {
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
      this.closeVersionList(column);
    }
  }

  refreshVersions(column: VersionColumn = 'baseline'): void {
    if (!this.projectId() || this.versionsBusy()) return;
    const inputId = column === 'comparison' ? 'dependency-tree-compare-input' : 'dependency-tree-version-input';
    this.versionInputs().find(input => input.nativeElement.id === inputId)?.nativeElement.focus();
    this.versionError.set(null);
    this.versionStatus.set('refreshing');
    this.requestVersions(this.projectId(), true);
  }

  setVersionQuery(value: string, column: VersionColumn = 'baseline'): void {
    const picker = this.versionPickers[column];
    picker.query.set(value);
    picker.highlight.set(0);
    picker.open.set(true);
  }

  chooseVersion(version: string): void {
    const selectedTag = this.versions().find(candidate => candidate.version === version);
    if (selectedTag && !this.canSelectVersion(selectedTag)) return;
    if (version === this.comparisonVersion()) this.chooseComparisonVersion('');
    this.selectedVersion.set(version);
    this.writeLastSelection(this.projectId(), version);
    this.closeVersionList();
    this.blurVersionInput('baseline');
  }

  retryResolution(): void {
    this.loadDependencyTree(this.projectId(), this.selectedVersion());
  }

  addComparison(): void {
    this.comparisonEnabled.set(true);
    this.writeLastSelection(this.projectId(), this.selectedVersion());
  }

  chooseComparisonVersion(version: string): void {
    const selectedTag = this.versions().find(candidate => candidate.version === version);
    if (selectedTag && !this.canSelectVersion(selectedTag)) return;
    this.comparisonSub?.unsubscribe();
    this.comparisonTree.set(null);
    this.comparisonError.set(null);
    this.comparisonStatus.set('idle');
    this.comparisonVersion.set(version);
    this.closeVersionList('comparison');
    this.blurVersionInput('comparison');
    this.writeLastSelection(this.projectId(), this.selectedVersion());
  }

  removeComparison(): void {
    this.comparisonEnabled.set(false);
    this.chooseComparisonVersion('');
  }

  retryComparison(): void {
    this.loadComparison(this.projectId(), this.comparisonVersion());
  }

  showChanges(node: FlatDepNode): void {
    if (node.change !== 'changed' || !node.version || !node.comparisonVersion) {
      this.copyFeedback.set('Commit changes are only available for dependencies with two different versions.');
      return;
    }
    this.changelogTarget.set({
      projectId: node.projectId,
      name: node.name,
      fromVersion: node.version,
      toVersion: node.comparisonVersion,
    });
  }

  private loadComparison(projectId: string, version: string): void {
    this.comparisonSub?.unsubscribe();
    this.comparisonTree.set(null);
    this.comparisonError.set(null);
    if (!projectId || !version) {
      this.comparisonStatus.set('idle');
      return;
    }
    this.comparisonStatus.set('loading');
    this.comparisonSub = this.projectApi.resolveDependencies(projectId, version).subscribe({
      next: (response) => {
        if (!this.comparisonEnabled() || this.projectId() !== projectId
          || this.comparisonVersion() !== version) return;
        this.comparisonTree.set(
          this.createProjectTree(this.toResolvedDepTreeNode(response.tree), response.version),
        );
        this.comparisonStatus.set('ready');
      },
      error: (error: unknown) => {
        const body: unknown = error instanceof HttpErrorResponse ? error.error : null;
        this.comparisonError.set(
          typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error : 'Unable to resolve the comparison version.',
        );
        this.comparisonStatus.set('error');
      },
    });
  }

  async copyVersion(node: FlatDepNode, column: 'baseline' | 'comparison' = 'baseline'): Promise<void> {
    const version = column === 'comparison' ? node.comparisonVersion : node.version;
    if (!version) return;
    this.copiedNodeId.set(null);
    this.copyFeedback.set('');
    try {
      await navigator.clipboard.writeText(version);
      this.copiedNodeId.set(node.id);
      this.copiedColumn.set(column);
      this.copyFeedback.set(`Copied ${version} for ${node.name}.`);
    } catch {
      this.copyFeedback.set('Unable to copy the version. Check clipboard permissions and try again.');
    }
  }

  onVersionKeydown(event: KeyboardEvent, column: VersionColumn = 'baseline'): void {
    const picker = this.versionPickers[column];
    const items = (column === 'comparison' ? this.filteredComparisonVersions() : this.filteredVersions()).items;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.openVersionList(column);
        this.moveVersionHighlight(Math.min(picker.highlight() + 1, items.length - 1), column);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveVersionHighlight(Math.max(picker.highlight() - 1, 0), column);
        break;
      case 'Enter': {
        const item = items[picker.highlight()];
        if (picker.open() && item) {
          event.preventDefault();
          if (column === 'comparison') {
            this.chooseComparisonVersion(item.version.version);
          } else {
            this.chooseVersion(item.version.version);
          }
        }
        break;
      }
      case 'Escape':
        this.closeVersionList(column);
        this.blurVersionInput(column);
        break;
    }
  }

  formatVersionDate(value: string | null): string {
    const date = value ? new Date(value) : null;
    return date && !isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
  }

  canSelectVersion(version: ProjectVersion): boolean {
    return !version.removed || version.hasDependencyTree;
  }

  private filterVersionOptions(versions: ProjectVersion[], queryText: string, selected: string) {
    const query = queryText.trim().toLowerCase();
    const latest = this.versions().find(version => !version.removed)?.version;
    const matches = query ? versions.filter((version) => version.version.toLowerCase().includes(query)) : versions;
    const selectedIndex = query ? -1 : matches.findIndex(version => version.version === selected);
    const start = Math.max(0, Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_VERSIONS / 2),
      matches.length - MAX_VISIBLE_VERSIONS,
    ));
    return {
      total: matches.length,
      items: matches.slice(start, start + MAX_VISIBLE_VERSIONS)
        .map((version) => ({ version, isLatest: version.version === latest })),
    };
  }

  private blurVersionInput(column: VersionColumn): void {
    const inputId = column === 'comparison' ? 'dependency-tree-compare-input' : 'dependency-tree-version-input';
    this.versionInputs().find((input) => input.nativeElement.id === inputId)?.nativeElement.blur();
  }

  private moveVersionHighlight(index: number, column: VersionColumn): void {
    this.versionPickers[column].highlight.set(Math.max(index, 0));
    const listId = column === 'comparison' ? 'dependency-tree-compare-list' : 'dependency-tree-version-list';
    setTimeout(() =>
      document.querySelector(`#${listId} .version-option--active`)?.scrollIntoView({ block: 'nearest' }),
    );
  }

  private loadVersions(projectId: string): void {
    this.versionsSub?.unsubscribe();
    const lastSelection = this.readLastSelection();
    this.removeComparison();
    this.closeVersionList();
    this.versions.set([]);
    this.versionError.set(null);

    if (!projectId) {
      this.selectedVersion.set('');
      this.versionStatus.set('idle');
      return;
    }

    this.versionStatus.set('loading');
    const rememberedSelection = lastSelection?.projectId === projectId ? lastSelection : null;
    const rememberedVersion = rememberedSelection?.version ?? '';
    this.selectedVersion.set(rememberedVersion);
    if (rememberedSelection?.comparisonEnabled && rememberedVersion) {
      this.comparisonEnabled.set(true);
      if (rememberedSelection.comparisonVersion !== rememberedVersion) {
        this.comparisonVersion.set(rememberedSelection.comparisonVersion);
      }
    }
    this.writeLastSelection(projectId, rememberedVersion);
    this.requestVersions(projectId);
  }

  private requestVersions(projectId: string, forceRefresh = false): void {
    this.versionsSub?.unsubscribe();
    this.versionsSub = this.projectApi.listVersions(projectId, forceRefresh).subscribe({
      next: ({ versions }) => {
        this.versions.set(versions);
        this.versionHighlight.set(0);
        this.comparisonHighlight.set(0);
        if (!versions.some(version => version.version === this.selectedVersion()
          && this.canSelectVersion(version))) {
          this.selectedVersion.set('');
          this.removeComparison();
        } else if (this.comparisonVersion()
          && !versions.some(version => version.version === this.comparisonVersion()
            && this.canSelectVersion(version))) {
          this.chooseComparisonVersion('');
        }
        this.writeLastSelection(projectId, this.selectedVersion());
        this.versionStatus.set('ready');
      },
      error: () => {
        if (forceRefresh) {
          this.versionError.set('Unable to refresh versions; keeping the previous list.');
          this.versionStatus.set('ready');
        } else {
          this.versionError.set('Unable to retrieve available versions.');
          this.versionStatus.set('error');
        }
      },
    });
  }

  private loadDependencyTree(projectId: string, version: string): void {
    this.dependencyTreeSub?.unsubscribe();
    this.resolvedTree.set(null);
    this.dependencyTreeError.set(null);

    if (!projectId || !version) {
      this.dependencyTreeStatus.set('idle');
      return;
    }

    this.dependencyTreeStatus.set('loading');
    this.dependencyTreeSub = this.projectApi.resolveDependencies(projectId, version).subscribe({
      next: (response) => {
        if (this.projectId() !== projectId || this.selectedVersion() !== version) return;
        this.resolvedTree.set(
          this.createProjectTree(this.toResolvedDepTreeNode(response.tree), response.version),
        );
        this.dependencyTreeStatus.set('ready');
      },
      error: (error: unknown) => {
        if (this.projectId() !== projectId || this.selectedVersion() !== version) return;
        const body: unknown = error instanceof HttpErrorResponse ? error.error : null;
        const message =
          typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error
            : 'Unable to resolve dependencies for the selected tag.';
        this.dependencyTreeError.set(message);
        this.dependencyTreeStatus.set('error');
      },
    });
  }

  private readLastSelection(): LastSelection | null {
    try {
      const value = JSON.parse(localStorage.getItem(LAST_SELECTION_KEY) ?? 'null') as unknown;
      if (typeof value === 'object' && value !== null) {
        const { projectId, version, comparisonEnabled, comparisonVersion } = value as Record<string, unknown>;
        if (typeof projectId === 'string') {
          return {
            projectId,
            version: typeof version === 'string' ? version : '',
            comparisonEnabled: comparisonEnabled === true,
            comparisonVersion: typeof comparisonVersion === 'string' ? comparisonVersion : '',
          };
        }
      }
    } catch (error) {
      console.error('Unable to restore the last dependency tree selection.', error);
    }
    return null;
  }

  private writeLastSelection(projectId: string, version: string): void {
    if (!projectId) return;
    localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify({
      projectId,
      version,
      comparisonEnabled: this.comparisonEnabled(),
      comparisonVersion: this.comparisonVersion(),
    }));
  }

  private loadProjectTrees(): void {
    this.projectListStatus.set('loading');
    this.projectListError.set(null);
    this.projectApi.list().subscribe({
      next: ({ projects }) => {
        const repositoryUrls = new Map<string, string>();
        const collectRepositoryUrls = (project: ProjectDefinitionResponse): void => {
          if (project.repoUrl.trim()) repositoryUrls.set(project.id, project.repoUrl);
          for (const dependency of project.dependencies ?? []) {
            collectRepositoryUrls(dependency.project);
          }
        };
        projects.forEach(collectRepositoryUrls);
        this.projectRepositoryUrls.set(repositoryUrls);
        const trees = projects
          .map((project) => this.toProjectTree(project))
          .sort((left, right) => left.projectName.localeCompare(right.projectName));
        this.projectTrees.set(trees);
        if (!trees.some((tree) => tree.projectId === this.projectId())) {
          const remembered = this.readLastSelection()?.projectId;
          const fallback = trees.find((tree) => tree.projectId === remembered) ?? trees[0];
          this.projectId.set(fallback?.projectId ?? '');
        }
        this.projectListStatus.set('ready');
      },
      error: () => {
        this.projectListError.set('Unable to retrieve saved project structures.');
        this.projectListStatus.set('error');
      },
    });
  }

  private toProjectTree(project: ProjectDefinitionResponse): ProjectTree {
    return this.createProjectTree(this.toDepTreeNode(project, 'Saved project'), 'Saved definition');
  }

  private createProjectTree(root: DepTreeNode, release: string): ProjectTree {
    const totalDependencies = this.countDescendants(root);
    return {
      projectId: root.projectId,
      projectName: root.name,
      release,
      ecosystem: 'Project structure',
      directCount: root.children.length,
      transitiveCount: totalDependencies - root.children.length,
      root,
    };
  }

  private toResolvedDepTreeNode(node: DependencyNodeResponse): DepTreeNode {
    return {
      projectId: node.projectId,
      name: node.projectName,
      version: node.version,
      creationDate: node.creationDate ?? null,
      ecosystem: 'Project',
      riskLevel: 'low',
      children: node.dependencies.map((child) => this.toResolvedDepTreeNode(child)),
    };
  }

  private toDepTreeNode(
    project: ProjectDefinitionResponse,
    versionReference: string,
  ): DepTreeNode {
    return {
      projectId: project.id,
      name: project.name,
      version: versionReference,
      ecosystem: 'Project',
      riskLevel: 'low',
      children: (project.dependencies ?? []).map((dependency) =>
        this.toDepTreeNode(
          dependency.project,
          typeof dependency.versionReference === 'string'
            ? dependency.versionReference
            : dependency.versionReference
              ? `/${dependency.versionReference.pattern}/${dependency.versionReference.flags}`
              : 'No version reference',
        ),
      ),
    };
  }

  private countDescendants(node: DepTreeNode): number {
    return node.children.reduce(
      (count, child) => count + 1 + this.countDescendants(child),
      0,
    );
  }
}
