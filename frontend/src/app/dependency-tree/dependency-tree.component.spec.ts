import { formatDate } from '@angular/common';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { userEvent } from 'vitest/browser';

import { DependencyTreeResponse, ProjectDefinitionResponse, ProjectVersion, } from '../tree-builder/project-definition-api.service';
import { DependencyTreeComponent } from './dependency-tree.component';

describe('DependencyTreeComponent resolution', () => {
  const projectsUrl = '/api/projects';
  const projectId = 'root-project';
  const firstTag = 'release/v1.0.0';
  const secondTag = 'release/v2.0.0';
  const selectionKey = 'dep-tree:last-selection';
  const project: ProjectDefinitionResponse = {
    id: projectId,
    name: 'Root Project',
    repoUrl: 'https://example.com/root.git',
    description: null,
    dependencies: null,
  };

  let fixture: ComponentFixture<DependencyTreeComponent>;
  let http: HttpTestingController;
  let previousSelection: string | null;

  beforeEach(async () => {
    previousSelection = localStorage.getItem(selectionKey);
    localStorage.removeItem(selectionKey);
    await TestBed.configureTestingModule({
      imports: [DependencyTreeComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ projectId })) },
        },
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture?.destroy();
    http.verify();
    if (previousSelection === null) {
      localStorage.removeItem(selectionKey);
    }
    else {
      localStorage.setItem(selectionKey, previousSelection);
    }
  });

  function createComponent(projects: ProjectDefinitionResponse[] = [project], projectVersions?: ProjectVersion[]): DependencyTreeComponent {
    fixture = TestBed.createComponent(DependencyTreeComponent);
    fixture.detectChanges();
    http.expectOne(projectsUrl).flush({ projects });
    fixture.detectChanges();
    const versions = projectVersions ?? [firstTag, secondTag].map((version) => ({
      version,
      creationDate: null,
      commitHash: null,
      removed: false,
      hasDependencyTree: false,
    }));
    const versionResponse = { projectId, versions, latest: versions.find(version => !version.removed) ?? null };
    const versionsUrl = `${projectsUrl}/${projectId}/versions`;
    http.expectOne((request) => request.url === versionsUrl && request.params.keys().length === 0)
      .flush(versionResponse);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function dependenciesUrl(version: string): string {
    return `${projectsUrl}/${projectId}/versions/${encodeURIComponent(version)}/dependencies`;
  }

  function resolvedTree(version: string): DependencyTreeResponse {
    return {
      projectId,
      projectName: project.name,
      version,
      tree: {
        projectId,
        projectName: project.name,
        version,
        dependencies: [{
          projectId: 'child-project',
          projectName: 'Child Project',
          version: 'v2.4.0',
          dependencies: [{
            projectId: 'grandchild-project',
            projectName: 'Grandchild Project',
            version: 'v3.7.0',
            dependencies: [],
          }],
        }],
      },
    };
  }

  function createComparedComponent(
    comparison = resolvedTree(secondTag),
    baseline = resolvedTree(firstTag),
  ): DependencyTreeComponent {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(baseline);
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(secondTag)).flush(comparison);
    fixture.detectChanges();
    return component;
  }

  it('displays resolved tags rather than range metadata and retains exact-version labels', () => {
    const component = createComponent();
    const response = resolvedTree(firstTag);
    response.tree.dependencies[0].declaredVersion = '^2.3.0';
    response.tree.dependencies[0].resolvedVersion = 'v2.4.0';
    response.tree.dependencies[0].resolutionCheckedAt = '2026-11-04T00:00:00.000Z';
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(response);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('v2.4.0');
    expect(text).toContain('v3.7.0');
    expect(text).not.toContain('^2.3.0');
    expect(text).not.toContain('2026-11-04T00:00:00.000Z');
  });

  it('shows changelog buttons for changed roots and transitive nodes, but not added, removed, or unchanged nodes', () => {
    const baseline = resolvedTree(firstTag);
    const comparison = resolvedTree(secondTag);
    baseline.tree.dependencies.push(
      { projectId: 'removed', projectName: 'Removed', version: 'v1', dependencies: [] },
      { projectId: 'unchanged', projectName: 'Unchanged', version: 'v1', dependencies: [] },
    );
    comparison.tree.dependencies[0].version = 'v2.5.0';
    comparison.tree.dependencies[0].dependencies[0].version = 'v3.8.0';
    comparison.tree.dependencies.push(
      { projectId: 'added', projectName: 'Added', version: 'v1', dependencies: [] },
      { projectId: 'unchanged', projectName: 'Unchanged', version: 'v1', dependencies: [] },
    );
    createComparedComponent(comparison, baseline);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.tree-show-changes').length).toBe(3);
    expect(host.querySelector('.tree-row:first-child .tree-show-changes')).toBeTruthy();
    expect(host.querySelectorAll('.tree-row--changed .tree-show-changes').length).toBe(3);
    expect(host.querySelector('.tree-row--added .tree-show-changes')).toBeNull();
    expect(host.querySelector('.tree-row--removed .tree-show-changes')).toBeNull();
    expect(host.querySelector('.tree-row:not(.tree-row--changed) .tree-show-changes')).toBeNull();
    for (const button of host.querySelectorAll<HTMLButtonElement>('.tree-show-changes')) {
      expect(button.textContent?.trim()).toBe('');
      expect(button.title).toBe('Show changes');
      expect(button.getAttribute('aria-label')).toMatch(/^Show changes for .+ between .+ and .+$/);
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(host.querySelector('dialog')).toBeNull();
    http.expectNone(request => request.url.endsWith('/commit-diffs'));
  });

  it('loads the clicked dependency changelog on demand and restores focus when closing it', () => {
    const comparison = resolvedTree(secondTag);
    comparison.tree.dependencies[0].version = 'v2.5.0';
    createComparedComponent(comparison);
    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelectorAll<HTMLButtonElement>('.tree-show-changes')[1];
    button.focus();
    button.click();
    fixture.detectChanges();
    const request = http.expectOne(request =>
      request.url === `${projectsUrl}/child-project/commit-diffs`
      && request.params.get('fromVersion') === 'v2.4.0'
      && request.params.get('toVersion') === 'v2.5.0');
    expect(host.querySelector('#commit-diff-title')?.textContent).toContain('Child Project');
    request.flush({
      projectId: 'child-project', projectName: 'Child Project',
      fromVersion: 'v2.4.0', toVersion: 'v2.5.0',
      fromCommitHash: 'a'.repeat(40), toCommitHash: 'a'.repeat(40),
      fromOnly: [], toOnly: [],
    });
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('[aria-label="Close commit changes"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('opens the changelog from the eye button using the keyboard', async () => {
    createComparedComponent();
    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector<HTMLButtonElement>('.tree-show-changes')!;
    button.focus();
    await userEvent.keyboard('{Enter}');
    fixture.detectChanges();
    const request = http.expectOne(request => request.url === `${projectsUrl}/${projectId}/commit-diffs`);
    expect(request.request.params.get('fromVersion')).toBe(firstTag);
    expect(request.request.params.get('toVersion')).toBe(secondTag);
    expect(host.querySelector('dialog')?.open).toBe(true);
    host.querySelector<HTMLButtonElement>('[aria-label="Close commit changes"]')!.click();
    fixture.detectChanges();
    expect(request.cancelled).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('uses a compact square eye button with the shared Expand/Collapse styling', () => {
    createComparedComponent();
    const host = fixture.nativeElement as HTMLElement;
    const showChanges = host.querySelector<HTMLButtonElement>('.tree-show-changes')!;
    const expand = host.querySelector<HTMLButtonElement>('.tree-actions .control-btn')!;
    const compactStyle = getComputedStyle(showChanges);
    const controlStyle = getComputedStyle(expand);
    expect(showChanges.classList.contains('control-btn')).toBe(true);
    expect(compactStyle.backgroundColor).toBe(controlStyle.backgroundColor);
    expect(compactStyle.color).toBe(controlStyle.color);
    expect(compactStyle.borderColor).toBe(controlStyle.borderColor);
    expect(compactStyle.borderRadius).toBe(controlStyle.borderRadius);
    expect(compactStyle.transition).toBe(controlStyle.transition);
    expect(showChanges.getBoundingClientRect().width).toBe(28);
    expect(showChanges.getBoundingClientRect().height).toBe(28);
    expect(expand.getBoundingClientRect().height).toBe(40);
    const icon = showChanges.querySelector<SVGSVGElement>('svg')!;
    expect(icon.getBoundingClientRect().width).toBe(16);
    expect(icon.getBoundingClientRect().height).toBe(16);
    expect(icon.querySelector('circle')).not.toBeNull();
  });

  it.each(['baseline', 'comparison'] as const)('cancels an open changelog when the %s selection changes', (column) => {
    const component = createComparedComponent();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('.tree-show-changes')!.click();
    fixture.detectChanges();
    const request = http.expectOne(request => request.url.endsWith('/commit-diffs'));
    if (column === 'baseline') {
      component.chooseVersion('');
    } else {
      component.removeComparison();
    }
    fixture.detectChanges();
    expect(host.querySelector('dialog')).toBeNull();
    expect(request.cancelled).toBe(true);
  });

  it('cancels a pending changelog when the popup is closed', () => {
    createComparedComponent();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('.tree-show-changes')!.click();
    fixture.detectChanges();
    const request = http.expectOne(request => request.url.endsWith('/commit-diffs'));
    host.querySelector<HTMLButtonElement>('[aria-label="Close commit changes"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('dialog')).toBeNull();
    expect(request.cancelled).toBe(true);
  });

  it('cancels a pending changelog and restores focus when clicking outside the popup', async () => {
    createComparedComponent();
    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector<HTMLButtonElement>('.tree-show-changes')!;
    button.focus();
    button.click();
    fixture.detectChanges();
    const request = http.expectOne(request => request.url.endsWith('/commit-diffs'));
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    await userEvent.click(dialog, { position: { x: -8, y: -8 }, force: true });
    fixture.detectChanges();
    expect(host.querySelector('dialog')).toBeNull();
    expect(request.cancelled).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('renders a supplied result without loading projects, versions, or resolving again', () => {
    fixture = TestBed.createComponent(DependencyTreeComponent);
    const response = resolvedTree(firstTag);
    response.tree.creationDate = '2026-10-26T11:35:00.000Z';
    fixture.componentRef.setInput('providedTree', response);
    fixture.componentRef.setInput('providedRepositoryUrls', new Map([[projectId, project.repoUrl]]));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    expect(host.querySelector('#dependency-tree-project-select')).toBeNull();
    expect(host.querySelector<HTMLAnchorElement>('.tree-node-link')?.href).toBe(project.repoUrl);
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe(response.tree.creationDate);
    expect(host.querySelector('.tree-controls')?.closest('.panel')).toBe(host.querySelector('.tree-panel'));
    expect(localStorage.getItem(selectionKey)).toBeNull();
    http.expectNone(request => request.url.startsWith(projectsUrl));

    fixture.componentInstance.collapseAll();
    fixture.detectChanges();
    fixture.componentRef.setInput('providedTree', resolvedTree(secondTag));
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    expect(host.textContent).toContain(secondTag);
    expect(host.querySelector('time')).toBeNull();
    expect(host.querySelectorAll('.tree-tag-popover__date').length).toBe(3);
    expect(host.querySelector(':popover-open')).toBeNull();
    http.expectNone(request => request.url.startsWith(projectsUrl));
  });

  it('loads versions once and refreshes the source only through the dropdown action', () => {
    const component = createComponent();
    component.openVersionList();
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.version-refresh')!;
    button.click();
    component.refreshVersions();
    fixture.detectChanges();
    expect(component.versionStatus()).toBe('refreshing');
    expect(button.disabled).toBe(true);
    expect(component.versions().length).toBe(2);
    const request = http.expectOne(`${projectsUrl}/${projectId}/versions?forceRefresh=true`);
    const versions = component.versions().slice(0, 1);
    request.flush({ projectId, versions, latest: versions[0] });
    fixture.detectChanges();
    expect(component.versionStatus()).toBe('ready');
    expect(component.versionListOpen()).toBe(true);
    expect(button.disabled).toBe(false);
    expect(component.versions()).toEqual(versions);
  });

  it('allows source refresh from an empty stored catalog', () => {
    const component = createComponent([project], []);
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector<HTMLInputElement>('#dependency-tree-version-input')!;
    expect(input.disabled).toBe(false);
    input.focus();
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('.version-refresh')!.click();
    http.expectOne(`${projectsUrl}/${projectId}/versions?forceRefresh=true`)
      .flush({ projectId, versions: [], latest: null });
    fixture.detectChanges();
    expect(component.versionStatus()).toBe('ready');
  });

  it('keeps the dropdown open when keyboard focus moves to its refresh button', () => {
    const component = createComponent();
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector<HTMLInputElement>('#dependency-tree-version-input')!;
    input.focus();
    fixture.detectChanges();
    const button = host.querySelector<HTMLButtonElement>('.version-refresh')!;
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: button }));
    fixture.detectChanges();
    expect(component.versionListOpen()).toBe(true);
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    fixture.detectChanges();
    expect(component.versionListOpen()).toBe(false);
  });

  it('preserves input focus when pressing the label, empty space, or busy refresh action', () => {
    const component = createComponent();
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector<HTMLInputElement>('#dependency-tree-version-input')!;
    input.focus();
    fixture.detectChanges();
    const dropdown = host.querySelector<HTMLElement>('.version-dropdown')!;
    const targets = [dropdown.querySelector('span')!, dropdown, dropdown.querySelector('.version-list')!];
    for (const target of targets) {
      const press = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
      target.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(input);
      expect(component.versionListOpen()).toBe(true);
    }
    const button = dropdown.querySelector<HTMLButtonElement>('.version-refresh')!;
    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    const press = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    button.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(component.versionListOpen()).toBe(true);
    http.expectOne(`${projectsUrl}/${projectId}/versions?forceRefresh=true`)
      .flush({ projectId, versions: component.versions(), latest: null });
  });

  it('returns keyboard focus to the input before disabling the refresh action', () => {
    const component = createComponent();
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector<HTMLInputElement>('#dependency-tree-version-input')!;
    input.focus();
    fixture.detectChanges();
    const button = host.querySelector<HTMLButtonElement>('.version-refresh')!;
    button.focus();
    button.click();
    fixture.detectChanges();
    expect(document.activeElement).toBe(input);
    expect(component.versionListOpen()).toBe(true);
    expect(button.disabled).toBe(true);
    http.expectOne(`${projectsUrl}/${projectId}/versions?forceRefresh=true`)
      .flush({ projectId, versions: component.versions(), latest: null });
  });

  it('still selects a version through pointer interaction inside the dropdown', () => {
    const component = createComponent();
    component.openVersionList();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector('.version-option')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(component.selectedVersion()).toBe(firstTag);
    expect(component.versionListOpen()).toBe(false);
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
  });

  it.each([
    ['baseline', 90],
    ['baseline', 250],
    ['comparison', 90],
    ['comparison', 250],
  ] as const)('scrolls the %s dropdown to the selected tag at catalog index %i', async (column, selectedIndex) => {
    const versions: ProjectVersion[] = Array.from({ length: 300 }, (_, index) => ({
      version: `release/v${300 - index}.0.0`,
      creationDate: null,
      commitHash: null,
      removed: false,
      hasDependencyTree: false,
    }));
    const selectedTag = versions[selectedIndex].version;
    const component = createComponent([project], versions);
    const baselineTag = column === 'baseline' ? selectedTag : versions[0].version;
    component.chooseVersion(baselineTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(baselineTag)).flush(resolvedTree(baselineTag));
    if (column === 'comparison') {
      component.addComparison();
      component.chooseComparisonVersion(selectedTag);
      fixture.detectChanges();
      http.expectOne(dependenciesUrl(selectedTag)).flush(resolvedTree(selectedTag));
    }
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const inputId = column === 'comparison' ? 'dependency-tree-compare-input' : 'dependency-tree-version-input';
    const listId = column === 'comparison' ? 'dependency-tree-compare-list' : 'dependency-tree-version-list';
    const input = host.querySelector<HTMLInputElement>(`#${inputId}`)!;
    input.focus();
    fixture.detectChanges();
    await fixture.whenStable();

    const list = host.querySelector<HTMLUListElement>(`#${listId}`)!;
    const selectedOption = list.querySelector<HTMLElement>('[aria-selected="true"]')!;
    expect(selectedOption).not.toBeNull();
    expect(selectedOption.textContent).toContain(selectedTag);
    expect(selectedOption.classList.contains('version-option--active')).toBe(true);
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedOption.id);
    expect(list.querySelectorAll('.version-option')).toHaveLength(200);
    expect(list.scrollTop).toBeGreaterThan(0);
    const listBounds = list.getBoundingClientRect();
    const selectedBounds = selectedOption.getBoundingClientRect();
    expect(selectedBounds.top).toBeGreaterThanOrEqual(listBounds.top - 1);
    expect(selectedBounds.bottom).toBeLessThanOrEqual(listBounds.bottom + 1);

    const highlightedIndex = component.versionPickers[column].highlight();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.versionPickers[column].highlight()).toBe(highlightedIndex - 1);

    component.setVersionQuery('release/v', column);
    fixture.detectChanges();
    const matches = column === 'comparison' ? component.filteredComparisonVersions() : component.filteredVersions();
    expect(matches.items).toHaveLength(200);
    expect(matches.items[0].version.version).toBe(versions[column === 'comparison' ? 1 : 0].version);
    expect(input.getAttribute('aria-activedescendant')).toBe(`${listId}-option-0`);
  });

  it('opens the dropdown at the first tag when none is selected', async () => {
    createComponent();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLInputElement>('#dependency-tree-version-input')!.focus();
    fixture.detectChanges();
    await fixture.whenStable();

    const list = host.querySelector<HTMLUListElement>('#dependency-tree-version-list')!;
    expect(list.querySelector('.version-option--active')?.textContent).toContain(firstTag);
    expect(list.querySelector('[aria-selected="true"]')).toBeNull();
    expect(list.scrollTop).toBe(0);
  });

  it('preserves both selections when refreshing from the comparison dropdown', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(secondTag)).flush(resolvedTree(secondTag));
    component.openVersionList('comparison');
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.version-refresh')!.click();
    http.expectOne(`${projectsUrl}/${projectId}/versions?forceRefresh=true`)
      .flush({ projectId, versions: component.versions(), latest: null });
    fixture.detectChanges();
    expect(document.activeElement?.id).toBe('dependency-tree-compare-input');
    expect(component.comparisonListOpen()).toBe(true);
    expect(component.selectedVersion()).toBe(firstTag);
    expect(component.comparisonVersion()).toBe(secondTag);
    expect(component.comparisonEnabled()).toBe(true);
    http.expectNone(dependenciesUrl(firstTag));
    http.expectNone(dependenciesUrl(secondTag));
  });

  it('retains the previous list and selection after a source refresh fails', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    const versions = component.versions();
    component.refreshVersions();
    http.expectOne(`${projectsUrl}/${projectId}/versions?forceRefresh=true`)
      .flush({ error: 'Source unavailable' }, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(component.versions()).toEqual(versions);
    expect(component.selectedVersion()).toBe(firstTag);
    expect(component.versionError()).toContain('keeping the previous list');
    expect(component.versionsBusy()).toBe(false);
  });

  it('clears a selection that becomes unavailable after a source refresh', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    component.refreshVersions();
    const versions = component.versions().map(version => ({
      ...version, removed: version.version === firstTag, hasDependencyTree: false,
    }));
    http.expectOne(`${projectsUrl}/${projectId}/versions?forceRefresh=true`)
      .flush({ projectId, versions, latest: versions[1] });
    fixture.detectChanges();
    expect(component.selectedVersion()).toBe('');
    expect(component.comparisonEnabled()).toBe(false);
  });

  it('labels removed tags and resolves their saved trees using the original tag name', () => {
    const versions: ProjectVersion[] = [firstTag, secondTag].map(version => ({
      version,
      creationDate: null,
      commitHash: null,
      removed: version === firstTag,
      hasDependencyTree: true,
    }));
    const component = createComponent([project], versions);
    component.openVersionList();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const options = host.querySelectorAll('.version-option');
    expect(options[0].textContent).toContain(`${firstTag} (removed)`);
    expect(options[0].textContent).not.toContain('(latest)');
    expect(options[0].getAttribute('aria-disabled')).toBe('false');
    expect(options[1].textContent).toContain(`${secondTag} (latest)`);

    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    expect(component.dependencyTreeStatus()).toBe('ready');
    expect(component.selectedVersion()).toBe(firstTag);
  });

  it('disables removed tags without snapshots for mouse, keyboard, and comparison selection', () => {
    const versions: ProjectVersion[] = [firstTag, secondTag].map(version => ({
      version,
      creationDate: null,
      commitHash: null,
      removed: version === firstTag,
      hasDependencyTree: false,
    }));
    const component = createComponent([project], versions);
    component.openVersionList();
    fixture.detectChanges();
    const option = (fixture.nativeElement as HTMLElement).querySelector('.version-option')!;
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('No saved tree');
    option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    component.onVersionKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    component.chooseComparisonVersion(firstTag);
    fixture.detectChanges();
    expect(component.selectedVersion()).toBe('');
    expect(component.comparisonVersion()).toBe('');
    http.expectNone(dependenciesUrl(firstTag));
  });

  it('resolves the exact root tag and renders direct and transitive versions', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();

    expect(component.dependencyTreeStatus()).toBe('loading');
    expect(component.currentTree()).toBeUndefined();
    const host = fixture.nativeElement as HTMLElement;
    const loadingStatus = host.querySelector('[role="status"]');
    expect(loadingStatus?.textContent?.replace(/\s+/g, ' ').trim())
      .toBe(`Resolving version ${firstTag}.`);
    expect(loadingStatus?.querySelector('.tree-resolution-spinner')).toBeTruthy();
    const request = http.expectOne(dependenciesUrl(firstTag));
    expect(request.request.method).toBe('GET');
    request.flush(resolvedTree(firstTag));
    fixture.detectChanges();

    expect(component.dependencyTreeStatus()).toBe('ready');
    expect(host.querySelector('.tree-resolution-spinner')).toBeNull();
    expect(component.currentTree()?.root.projectId).toBe(projectId);
    expect(component.currentTree()?.root.name).toBe(project.name);
    expect(component.currentTree()?.directCount).toBe(1);
    expect(component.currentTree()?.transitiveCount).toBe(1);

    expect(Array.from(host.querySelectorAll('.tree-node-version'))
      .map((node) => node.textContent?.trim())).toEqual([firstTag, 'v2.4.0', 'v3.7.0']);
    expect(host.querySelector('.risk-pill')).toBeNull();
    const badge = host.querySelector<HTMLElement>('.tree-node-version')!;
    const badgeStyle = getComputedStyle(badge);
    expect(badgeStyle.borderTopStyle).toBe('solid');
    expect(badgeStyle.borderRadius).toBe('6px');
    expect(badgeStyle.textTransform).toBe('none');
  });

  it.each([false, true])('collapses every node including the root and clears filtering (comparison: %s)', comparing => {
    let component: DependencyTreeComponent;
    if (comparing) {
      component = createComparedComponent();
    } else {
      component = createComponent();
      component.chooseVersion(firstTag);
      fixture.detectChanges();
      http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
      fixture.detectChanges();
    }
    const host = fixture.nativeElement as HTMLElement;
    const filter = host.querySelector<HTMLInputElement>('.tree-search')!;
    const collapse = host.querySelector<HTMLButtonElement>('.tree-actions button[title="Collapse all"]')!;
    const expand = host.querySelector<HTMLButtonElement>('.tree-actions button[title="Expand all"]')!;
    filter.value = 'Grandchild';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(component.matchCount()).toBe(1);
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    collapse.click();
    fixture.detectChanges();
    expect(component.expandedIds().size).toBe(0);
    expect(component.filter()).toBe('');
    expect(filter.value).toBe('');
    expect(component.matchCount()).toBeNull();
    expect(host.querySelectorAll('.tree-row').length).toBe(1);
    expect(host.querySelector('.tree-row')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tree-node-name')?.textContent).toBe(project.name);

    host.querySelector<HTMLButtonElement>('.tree-row .tree-toggle')!.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-row').length).toBe(2);
    expect(host.querySelectorAll('.tree-row')[1].getAttribute('aria-expanded')).toBe('false');
    collapse.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-row').length).toBe(1);
    expand.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    expect(host.querySelectorAll('.tree-row[aria-expanded="true"]').length).toBe(2);
    http.expectNone(() => true);
  });

  it.each(['1200px', '360px'])('aligns comparison loading with dependency resolution at %s', width => {
    const component = createComponent();
    const host = fixture.nativeElement as HTMLElement;
    host.style.width = width;
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const baseline = host.querySelector<HTMLElement>('.tree-loading')!;
    const styleProperties = [
      'font-size', 'color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'display', 'align-items', 'justify-content', 'gap', 'text-align',
    ];
    const baselineStyle = getComputedStyle(baseline);
    const expectedStyles = styleProperties.map(property => baselineStyle.getPropertyValue(property));
    const expectCenteredLoading = (status: HTMLElement): void => {
      const message = status.getBoundingClientRect();
      const spinner = status.querySelector<HTMLElement>('.tree-resolution-spinner')!.getBoundingClientRect();
      const text = status.querySelector<HTMLElement>('.tree-loading__text')!.getBoundingClientRect();
      expect((spinner.left + text.right) / 2).toBeCloseTo(message.left + message.width / 2, 1);
      expect(spinner.top + spinner.height / 2).toBeCloseTo(text.top + text.height / 2, 1);
      expect(text.left - spinner.right).toBeCloseTo(12, 1);
    };
    expectCenteredLoading(baseline);
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    const comparison = host.querySelector<HTMLElement>('.comparison-status.tree-loading')!;
    const comparisonStyle = getComputedStyle(comparison);
    expect(styleProperties.map(property => comparisonStyle.getPropertyValue(property))).toEqual(expectedStyles);
    expect(comparison.textContent?.trim()).toBe(`Resolving version ${secondTag}.`);
    expectCenteredLoading(comparison);
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    http.expectOne(dependenciesUrl(secondTag)).flush(resolvedTree(secondTag));
    fixture.detectChanges();
    expect(host.querySelector('.comparison-status')).toBeNull();
  });

  it('connects branches across row padding and stops the last branch at its midpoint', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const response = resolvedTree(firstTag);
    response.tree.dependencies.push({
      projectId: 'sibling-project',
      projectName: 'Sibling Project',
      version: 'v1.0.0',
      dependencies: [],
    });
    http.expectOne(dependenciesUrl(firstTag)).flush(response);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('.tree-row'));
    const branch = rows[1].querySelector<HTMLElement>('.tree-connector')!;
    const guide = rows[2].querySelector<HTMLElement>('.tree-guide')!;
    const lastBranch = rows[3].querySelector<HTMLElement>('.tree-connector')!;
    const lineTop = (element: HTMLElement): number => element.getBoundingClientRect().top
      + parseFloat(getComputedStyle(element, '::before').top);
    const lineBottom = (element: HTMLElement): number => element.getBoundingClientRect().bottom
      - parseFloat(getComputedStyle(element, '::before').bottom);

    expect(Math.abs(lineTop(branch) - rows[1].getBoundingClientRect().top)).toBeLessThan(0.1);
    expect(Math.abs(lineBottom(branch) - lineTop(guide))).toBeLessThan(0.1);
    expect(Math.abs(lineBottom(guide) - lineTop(lastBranch))).toBeLessThan(0.1);
    const lastRow = rows[3].getBoundingClientRect();
    expect(Math.abs(lineBottom(lastBranch) - (lastRow.top + lastRow.height / 2)))
      .toBeLessThan(0.1);
    const stem = getComputedStyle(rows[0], '::after');
    expect(stem.content).not.toBe('none');
    expect(parseFloat(stem.bottom)).toBe(0);
    expect(Math.abs(rows[0].getBoundingClientRect().left + parseFloat(stem.left)
      - (branch.getBoundingClientRect().left + parseFloat(getComputedStyle(branch, '::before').left))))
      .toBeLessThan(0.1);

    for (const width of ['360px', '1000px']) {
      host.style.display = 'block';
      host.style.width = width;
      for (const row of rows.slice(1)) {
        const connector = row.querySelector<HTMLElement>('.tree-connector')!;
        const line = getComputedStyle(connector, '::after');
        const endpoint = connector.getBoundingClientRect().left
          + parseFloat(line.left) + parseFloat(line.width);
        const toggle = row.querySelector<HTMLElement>('.tree-toggle')!;
        const name = row.querySelector<HTMLElement>('.tree-node-name')!;
        const expectedEndpoint = toggle.classList.contains('tree-toggle--leaf')
          ? name.getBoundingClientRect().left
          - parseFloat(getComputedStyle(row.querySelector<HTMLElement>('.tree-node-cell')!).columnGap)
          : toggle.getBoundingClientRect().left;
        expect(Math.abs(endpoint - expectedEndpoint)).toBeLessThan(0.1);
      }
    }

    component.collapseAll();
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-row').length).toBe(1);
    expect(getComputedStyle(rows[0], '::after').content).toBe('none');
  });

  it('links saved, resolved, and comparison-only projects to their configured repositories', () => {
    const childProject: ProjectDefinitionResponse = {
      ...project, id: 'child-project', name: 'Child Project', repoUrl: 'https://example.com/child.git',
    };
    const addedProject: ProjectDefinitionResponse = {
      ...project, id: 'new-project', name: 'New Project', repoUrl: 'https://example.com/new.git',
    };
    const component = createComponent([{
      ...project,
      dependencies: [{ project: childProject, versionReference: 'v2.4.0', manifestPath: null }],
    }, addedProject]);
    const host = fixture.nativeElement as HTMLElement;
    const savedLinks = host.querySelectorAll<HTMLAnchorElement>('.tree-node-link');
    expect(Array.from(savedLinks).map((link) => link.getAttribute('href')))
      .toEqual([project.repoUrl, childProject.repoUrl]);
    expect(host.querySelector<HTMLSelectElement>('#dependency-tree-project-select')!.value).toBe(projectId);
    expect(getComputedStyle(savedLinks[0]).textDecorationLine).toBe('underline');
    expect(Array.from(savedLinks).every((link) => getComputedStyle(link).fontWeight === '400')).toBe(true);
    for (const savedLink of savedLinks) {
      const textRange = document.createRange();
      textRange.selectNodeContents(savedLink);
      expect(Math.abs(savedLink.getBoundingClientRect().width - textRange.getBoundingClientRect().width))
        .toBeLessThan(0.1);
    }
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-node-link').length).toBe(2);
    expect(host.querySelectorAll('.tree-node-name')[2].tagName).toBe('SPAN');
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    const comparison = resolvedTree(secondTag);
    comparison.tree.dependencies.push({
      projectId: addedProject.id, projectName: addedProject.name, version: 'v1.0.0', dependencies: [],
    });
    http.expectOne(dependenciesUrl(secondTag)).flush(comparison);
    fixture.detectChanges();
    const link = host.querySelector<HTMLAnchorElement>('.tree-row--added .tree-node-link')!;
    expect(link.getAttribute('href')).toBe(addedProject.repoUrl);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('copies the displayed version without toggling the tree and confirms success', async () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const expanded = component.expandedIds();
    const host = fixture.nativeElement as HTMLElement;
    const buttons = host.querySelectorAll<HTMLButtonElement>('.tree-copy');
    expect(buttons[1].parentElement?.classList.contains('tree-node-version')).toBe(true);
    expect(buttons[1].querySelector('svg rect')).toBeTruthy();
    buttons[1].click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledTimes(1);

    expect(writeText).toHaveBeenCalledWith('v2.4.0');
    expect(component.expandedIds()).toBe(expanded);
    expect(buttons[1].title).toBe('Copied');
    expect(buttons[1].querySelector('.tree-copy__check')).toBeTruthy();
    expect(host.querySelector('.tree-copy-feedback')?.textContent)
      .toBe('Copied v2.4.0 for Child Project.');
  });

  it('handles clipboard permission failures without reporting success', async () => {
    const component = createComponent();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Permission denied'));
    await component.copyVersion(component.visibleNodes()[0]);
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledTimes(1);

    expect(writeText).toHaveBeenCalledWith('Saved project');
    expect(component.copiedNodeId()).toBeNull();
    expect(component.copyFeedback()).toContain('Unable to copy');
  });

  it('sizes badges to their labels and puts versions below the project picker', () => {
    const component = createComponent();
    const host = fixture.nativeElement as HTMLElement;
    const original = host.querySelector<HTMLElement>('.tree-node-version')!.getBoundingClientRect();
    const projectSelect = host.querySelector<HTMLElement>('#dependency-tree-project-select')!;
    const versionInput = host.querySelector<HTMLElement>('#dependency-tree-version-input')!;
    expect(versionInput.getBoundingClientRect().top).toBeGreaterThan(projectSelect.getBoundingClientRect().bottom);
    const root = component.currentTree()!;
    component.projectTrees.set([{
      ...root, projectId: 'another-project',
      root: { ...root.root, projectId: 'another-project', version: 'release/with-a-very-long-version-reference' },
    }]);
    component.projectId.set('another-project');
    fixture.detectChanges();
    const versionsUrl = `${projectsUrl}/another-project/versions`;
    http.match((request) => request.url === versionsUrl).forEach((request) => request.flush({ versions: [] }));
    fixture.detectChanges();
    const badge = host.querySelector<HTMLElement>('.tree-node-version')!;
    expect(badge.getBoundingClientRect().width).toBeGreaterThan(original.width);
    expect(badge.getBoundingClientRect().height).toBe(original.height);
    expect(original.height).toBe(32);
    const label = badge.querySelector<HTMLElement>('.tree-node-version__text')!;
    const popover = document.getElementById(label.getAttribute('aria-describedby')!)!;
    expect(popover.querySelector('.tree-tag-popover__version')?.textContent)
      .toBe('release/with-a-very-long-version-reference');
    expect(getComputedStyle(popover).display).toBe('none');
  });

  it('shows GMT tag creation details only on label hover or focus without increasing row height', async () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const response = resolvedTree(firstTag);
    const dates = ['2026-10-26T11:35:00.000Z', '2026-10-24T09:20:30.000Z', '2026-10-20T18:42:00.000Z'];
    response.tree.creationDate = dates[0];
    response.tree.dependencies[0].creationDate = dates[1];
    response.tree.dependencies[0].dependencies[0].creationDate = dates[2];
    http.expectOne(dependenciesUrl(firstTag)).flush(response);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const locale = TestBed.inject(LOCALE_ID);
    const times = host.querySelectorAll<HTMLTimeElement>('.tree-tag-popover time');
    expect(times.length).toBe(3);
    for (const [index, time] of Array.from(times).entries()) {
      const popover = time.closest<HTMLElement>('.tree-tag-popover')!;
      const badge = time.closest('.tree-version-column')!.querySelector<HTMLElement>('.tree-node-version')!;
      const label = badge.querySelector<HTMLElement>('.tree-node-version__text')!;
      const row = badge.closest<HTMLElement>('.tree-row')!;
      const rowHeight = row.getBoundingClientRect().height;
      expect(time.getAttribute('datetime')).toBe(dates[index]);
      expect(time.textContent?.trim())
        .toBe(`Created ${formatDate(dates[index], 'mediumDate', locale, 'UTC')}, ${formatDate(dates[index], 'HH:mm:ss', locale, 'UTC')} GMT`);
      expect(time.title).toBe(dates[index]);
      expect(label.getAttribute('aria-describedby')).toBe(popover.id);
      expect(label.title).toBe('');
      expect(popover.querySelector('.tree-tag-popover__version')?.textContent).toBe(label.textContent);
      expect(getComputedStyle(popover).display).toBe('none');
      expect(badge.getBoundingClientRect().height).toBe(32);
      expect(rowHeight).toBeCloseTo(32 + 2 * parseFloat(getComputedStyle(row).paddingTop), 1);
      await userEvent.hover(label);
      expect(popover.matches(':popover-open')).toBe(true);
      const bounds = popover.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(8);
      expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth - 8);
      expect(bounds.top).toBeGreaterThanOrEqual(8);
      expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 8);
      expect(row.getBoundingClientRect().height).toBe(rowHeight);
      await userEvent.unhover(label);
      expect(popover.matches(':popover-open')).toBe(false);
      label.focus();
      expect(document.activeElement).toBe(label);
      expect(popover.matches(':popover-open')).toBe(true);
      await userEvent.keyboard('{Escape}');
      expect(popover.matches(':popover-open')).toBe(false);
      expect(document.activeElement).toBe(label);
      label.blur();
    }
    expect(host.querySelector('.tree-version-metadata')).toBeNull();
    http.expectNone(request => request.url.endsWith('/versions'));
  });

  it.each([
    ['2026-10-23T17:10:21+02:00', '2026-10-23T15:10:21Z', '15:10:21'],
    ['2026-10-24T00:15:00+02:00', '2026-10-23T22:15:00Z', '22:15:00'],
    ['2026-10-23T23:50:00-05:30', '2026-10-24T05:20:00Z', '05:20:00'],
    ['2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z', '00:00:00'],
    ['2026-10-23T12:00:00Z', '2026-10-23T12:00:00Z', '12:00:00'],
  ])('formats creation date %s as 24-hour GMT', (creationDate, expectedUtc, expectedTime) => {
    fixture = TestBed.createComponent(DependencyTreeComponent);
    const response = resolvedTree(firstTag);
    response.tree.creationDate = creationDate;
    fixture.componentRef.setInput('providedTree', response);
    fixture.detectChanges();
    const time = (fixture.nativeElement as HTMLElement).querySelector('time')!;
    expect(time.textContent?.trim())
      .toBe(`Created ${formatDate(expectedUtc, 'mediumDate', TestBed.inject(LOCALE_ID), 'UTC')}, ${expectedTime} GMT`);
    expect(time.getAttribute('datetime')).toBe(creationDate);
    expect(time.textContent).not.toMatch(/GMT[+-]|\(GMT|\b(?:AM|PM)\b/);
  });

  it('closes tag details immediately when leaving the label, including moving onto the popover or copy button', async () => {
    createComparedComponent();
    const host = fixture.nativeElement as HTMLElement;
    const badge = host.querySelector<HTMLElement>('.tree-node-version')!;
    const label = badge.querySelector<HTMLElement>('.tree-node-version__text')!;
    const copy = badge.querySelector<HTMLButtonElement>('.tree-copy')!;
    const popover = document.getElementById(label.getAttribute('aria-describedby')!)!;
    await userEvent.hover(copy);
    expect(popover.matches(':popover-open')).toBe(false);
    await userEvent.hover(label);
    expect(popover.matches(':popover-open')).toBe(true);
    // The tooltip disappears during the pointer move away from the label.
    await userEvent.hover(popover, { force: true });
    expect(popover.matches(':popover-open')).toBe(false);
    await userEvent.hover(label);
    expect(popover.matches(':popover-open')).toBe(true);
    await userEvent.hover(copy);
    expect(popover.matches(':popover-open')).toBe(false);
    await userEvent.click(label);
    expect(document.activeElement).toBe(label);
    expect(popover.matches(':popover-open')).toBe(true);
    await userEvent.hover(popover, { force: true });
    expect(popover.matches(':popover-open')).toBe(false);
    expect(document.activeElement).toBe(label);
    const search = host.querySelector<HTMLInputElement>('.tree-search')!;
    search.focus();
    label.focus();
    expect(popover.matches(':popover-open')).toBe(true);
    search.focus();
    expect(popover.matches(':popover-open')).toBe(false);
    label.focus();
    expect(popover.matches(':popover-open')).toBe(true);
    await userEvent.click(search);
    expect(popover.matches(':popover-open')).toBe(false);
  });

  it('contains long tag popovers within the viewport after horizontal scrolling and closes obsolete details', async () => {
    fixture = TestBed.createComponent(DependencyTreeComponent);
    const response = resolvedTree(firstTag);
    response.tree.version = 'release/with-a-long-version-reference-'.repeat(20);
    response.tree.creationDate = '2026-10-26T11:35:00.000Z';
    fixture.componentRef.setInput('providedTree', response);
    const host = fixture.nativeElement as HTMLElement;
    host.style.width = '320px';
    fixture.detectChanges();
    const scroll = host.querySelector<HTMLElement>('.tree-scroll')!;
    scroll.scrollLeft = scroll.scrollWidth;
    const badge = host.querySelector<HTMLElement>('.tree-node-version')!;
    const label = badge.querySelector<HTMLElement>('.tree-node-version__text')!;
    const popover = document.getElementById(label.getAttribute('aria-describedby')!)!;
    label.focus();
    expect(popover.matches(':popover-open')).toBe(true);
    const bounds = popover.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(8);
    expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth - 8);
    expect(bounds.top).toBeGreaterThanOrEqual(8);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(popover.scrollWidth).toBe(popover.clientWidth);
    scroll.scrollLeft = 0;
    scroll.dispatchEvent(new Event('scroll'));
    expect(popover.matches(':popover-open')).toBe(false);
    scroll.scrollLeft = scroll.scrollWidth;
    label.blur();
    label.focus();
    expect(popover.matches(':popover-open')).toBe(true);
    fixture.componentRef.setInput('providedTree', resolvedTree(secondTag));
    fixture.detectChanges();
    expect(popover.matches(':popover-open')).toBe(false);
    expect(host.querySelector(':popover-open')).toBeNull();
    await fixture.whenStable();
  });

  it('keeps creation times independent in both comparison popovers and leaves absent versions undated', () => {
    const baseline = resolvedTree(firstTag);
    const comparison = resolvedTree(secondTag);
    const baselineDate = '2026-10-24T09:20:30.000Z';
    const comparisonDate = '2026-10-26T11:35:00.000Z';
    baseline.tree.creationDate = baselineDate;
    baseline.tree.dependencies[0].creationDate = baselineDate;
    comparison.tree.creationDate = comparisonDate;
    comparison.tree.dependencies[0].creationDate = comparisonDate;
    baseline.tree.dependencies.push({
      projectId: 'removed', projectName: 'Removed', version: 'v1', creationDate: baselineDate, dependencies: [],
    });
    comparison.tree.dependencies.push({
      projectId: 'added', projectName: 'Added', version: 'v2', creationDate: comparisonDate, dependencies: [],
    });
    createComparedComponent(comparison, baseline);
    const host = fixture.nativeElement as HTMLElement;
    const unchanged = host.querySelectorAll<HTMLElement>('.tree-row')[1];
    expect(Array.from(unchanged.querySelectorAll('time')).map(time => time.getAttribute('datetime')))
      .toEqual([baselineDate, comparisonDate]);
    for (const time of unchanged.querySelectorAll('time')) {
      const date = time.getAttribute('datetime')!;
      const locale = TestBed.inject(LOCALE_ID);
      expect(time.textContent?.trim()).toBe(
        `Created ${formatDate(date, 'mediumDate', locale, 'UTC')}, ${formatDate(date, 'HH:mm:ss', locale, 'UTC')} GMT`,
      );
    }
    const labels = unchanged.querySelectorAll<HTMLElement>('.tree-node-version__text');
    const popovers = unchanged.querySelectorAll<HTMLElement>('.tree-tag-popover');
    labels[0].focus();
    expect(popovers[0].matches(':popover-open')).toBe(true);
    expect(popovers[1].matches(':popover-open')).toBe(false);
    labels[1].focus();
    expect(popovers[0].matches(':popover-open')).toBe(false);
    expect(popovers[1].matches(':popover-open')).toBe(true);
    const added = host.querySelectorAll('.tree-row--added .tree-version-column');
    expect(added[0].querySelector('.tree-tag-popover')!.textContent?.trim()).toBe('');
    expect(added[0].querySelector('.tree-node-version__text')!.hasAttribute('aria-describedby')).toBe(false);
    expect(added[1].querySelector('time')?.getAttribute('datetime')).toBe(comparisonDate);
    const removed = host.querySelectorAll('.tree-row--removed .tree-version-column');
    expect(removed[0].querySelector('time')?.getAttribute('datetime')).toBe(baselineDate);
    expect(removed[1].querySelector('.tree-tag-popover')!.textContent?.trim()).toBe('');
    expect(removed[1].querySelector('.tree-node-version__text')!.hasAttribute('tabindex')).toBe(false);
  });

  it('keeps filtering and expand/collapse inside the tree card and reports unavailable dates without inventing them', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const response = resolvedTree(firstTag);
    response.tree.creationDate = null;
    http.expectOne(dependenciesUrl(firstTag)).flush(response);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const panel = host.querySelector<HTMLElement>('.tree-panel')!;
    expect(panel.querySelector('.tree-controls')).toBeTruthy();
    expect(host.querySelectorAll('.panel').length).toBe(2);
    expect(panel.querySelector('time')).toBeNull();
    expect(panel.querySelectorAll('.tree-tag-popover__date').length).toBe(3);
    for (const popover of panel.querySelectorAll<HTMLElement>('.tree-tag-popover')) {
      expect(getComputedStyle(popover).display).toBe('none');
    }
    const buttons = panel.querySelectorAll<HTMLButtonElement>('.tree-actions button');
    buttons[1].click();
    fixture.detectChanges();
    expect(panel.querySelectorAll('.tree-row').length).toBe(1);
    expect(panel.querySelector('.tree-node-name')?.textContent).toBe(project.name);
    buttons[0].click();
    fixture.detectChanges();
    expect(panel.querySelectorAll('.tree-row').length).toBe(3);
    const search = panel.querySelector<HTMLInputElement>('.tree-search')!;
    search.value = 'Grandchild';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(panel.querySelector('.tree-search-count')?.textContent).toBe('1 match');
    expect(panel.querySelector('.tree-row--match .tree-node-name')?.textContent).toBe('Grandchild Project');
  });

  it('uses the same content-sized badge and independent copy feedback for both version columns', async () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    const response = resolvedTree(secondTag);
    response.tree.dependencies[0].version = 'v2.5.0';
    http.expectOne(dependenciesUrl(secondTag)).flush(response);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelectorAll<HTMLElement>('.tree-row')[1];
    const badges = row.querySelectorAll<HTMLElement>('.tree-node-version');
    const unchangedBadge = host.querySelector<HTMLElement>('.tree-row:not(.tree-row--changed) .tree-node-version')!;
    expect(badges.length).toBe(2);
    expect(row.classList.contains('tree-row--changed')).toBe(true);
    expect(host.querySelectorAll('.tree-row .tree-change-icon').length).toBe(2);
    expect(host.querySelector('.tree-row:not(.tree-row--changed) .tree-change-icon')).toBeNull();
    for (const badge of badges) {
      const label = badge.querySelector<HTMLElement>('.tree-node-version__text')!;
      expect(label.scrollWidth).toBe(label.clientWidth);
      expect(badge.getBoundingClientRect().height).toBe(32);
      expect(getComputedStyle(badge).borderRadius).toBe('6px');
      expect(getComputedStyle(badge).fontWeight).toBe('700');
      expect(getComputedStyle(badge).backgroundColor).toMatch(/^rgb\(/);
      expect(getComputedStyle(badge).backgroundColor).toBe(getComputedStyle(unchangedBadge).backgroundColor);
      expect(getComputedStyle(badge).borderColor).toBe(getComputedStyle(unchangedBadge).borderColor);
      expect(badge.querySelector('.tree-copy')).toBeTruthy();
    }
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    badges[1].querySelector<HTMLButtonElement>('.tree-copy')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('v2.5.0');
    expect(badges[1].querySelector('.tree-copy__check')).toBeTruthy();
    expect(badges[0].querySelector('.tree-copy__check')).toBeNull();
    badges[0].querySelector<HTMLButtonElement>('.tree-copy')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(vi.mocked(writeText).mock.lastCall).toEqual(['v2.4.0']);
    expect(badges[0].querySelector('.tree-copy__check')).toBeTruthy();
    expect(badges[1].querySelector('.tree-copy__check')).toBeNull();
  });

  it('sizes and centers the tree card to fit its content and scrolls only when needed', () => {
    const component = createComponent();
    const host = fixture.nativeElement as HTMLElement;
    host.style.display = 'block';
    host.style.width = '1200px';
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const baseline = resolvedTree(firstTag);
    baseline.tree.creationDate = '2026-10-24T09:20:30.000Z';
    baseline.tree.dependencies[0].creationDate = baseline.tree.creationDate;
    baseline.tree.dependencies[0].dependencies[0].creationDate = baseline.tree.creationDate;
    http.expectOne(dependenciesUrl(firstTag)).flush(baseline);
    fixture.detectChanges();
    const header = host.querySelector<HTMLElement>('.tree-header')!;
    const controls = host.querySelector<HTMLElement>('.tree-controls')!;
    const panel = host.querySelector<HTMLElement>('.tree-panel')!;
    const scroll = host.querySelector<HTMLElement>('.tree-scroll')!;
    const baselineWidth = panel.getBoundingClientRect().width;
    const availableWidth = header.getBoundingClientRect().width;
    const headerCenter = header.getBoundingClientRect().left + availableWidth / 2;
    expect(controls.closest('.panel')).toBe(panel);
    expect(controls.getBoundingClientRect().width).toBe(scroll.getBoundingClientRect().width);
    expect(baselineWidth).toBeCloseTo(availableWidth * 0.7, 1);
    expect(baselineWidth).toBeLessThan(availableWidth);
    expect(panel.getBoundingClientRect().left + baselineWidth / 2).toBeCloseTo(headerCenter, 1);
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    const comparison = resolvedTree(secondTag);
    comparison.tree.creationDate = '2026-10-26T11:35:00.000Z';
    comparison.tree.dependencies[0].creationDate = comparison.tree.creationDate;
    comparison.tree.dependencies[0].dependencies[0].creationDate = comparison.tree.creationDate;
    http.expectOne(dependenciesUrl(secondTag)).flush(comparison);
    fixture.detectChanges();
    const comparisonWidth = panel.getBoundingClientRect().width;
    expect(comparisonWidth).toBeGreaterThanOrEqual(baselineWidth);
    expect(comparisonWidth).toBeLessThan(availableWidth);
    expect(panel.getBoundingClientRect().left + comparisonWidth / 2).toBeCloseTo(headerCenter, 1);
    expect(controls.getBoundingClientRect().width).toBe(scroll.getBoundingClientRect().width);
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
    expect(host.querySelector('.tree-version-metadata')).toBeNull();
    const showChanges = host.querySelector<HTMLButtonElement>('.tree-show-changes')!;
    expect(showChanges.getBoundingClientRect().right).toBeLessThanOrEqual(scroll.getBoundingClientRect().right);
    expect(scroll.getBoundingClientRect().right - showChanges.getBoundingClientRect().right).toBeLessThan(24);
    const badges = host.querySelectorAll<HTMLElement>('.tree-row:first-child .tree-node-version');
    const versionColumns = host.querySelectorAll<HTMLElement>('.tree-row:first-child .tree-version-column');
    expect(versionColumns[1].getBoundingClientRect().left - versionColumns[0].getBoundingClientRect().right)
      .toBeCloseTo(24, 1);
    const nodeCell = host.querySelector<HTMLElement>('.tree-row:first-child .tree-node-cell')!;
    const versionCell = host.querySelector<HTMLElement>('.tree-row:first-child .tree-version-column')!;
    expect(versionCell.getBoundingClientRect().left - nodeCell.getBoundingClientRect().right)
      .toBeLessThan(16);
    const nameLabel = nodeCell.querySelector<HTMLElement>('.tree-node-name')!;
    expect(versionCell.getBoundingClientRect().left - nameLabel.getBoundingClientRect().right)
      .toBeGreaterThanOrEqual(24);
    const headings = host.querySelectorAll<HTMLElement>('.tree-column-headings > span:not(.tree-change-indicator)');
    expect(Math.abs(badges[0].getBoundingClientRect().right - headings[1].getBoundingClientRect().right))
      .toBeLessThan(0.1);
    expect(Math.abs(badges[1].getBoundingClientRect().right - headings[2].getBoundingClientRect().right))
      .toBeLessThan(0.1);
    const indicators = host.querySelectorAll<HTMLElement>('.tree-row .tree-change-indicator');
    const comparisonCell = host.querySelectorAll<HTMLElement>('.tree-row:first-child .tree-version-column')[1];
    const headerDividerEnd = headings[2].getBoundingClientRect().bottom
      - parseFloat(getComputedStyle(headings[2], '::before').bottom);
    const rowDividerStart = comparisonCell.getBoundingClientRect().top
      + parseFloat(getComputedStyle(comparisonCell, '::before').top);
    expect(Math.abs(headerDividerEnd - rowDividerStart)).toBeLessThan(0.1);
    expect(indicators[0].getBoundingClientRect().left).toBeGreaterThan(comparisonCell.getBoundingClientRect().right);
    const changeIcon = indicators[0].querySelector<SVGSVGElement>('.tree-change-icon')!;
    expect(changeIcon.getBoundingClientRect().left - badges[1].getBoundingClientRect().right)
      .toBeCloseTo(12, 1);
    expect(showChanges.getBoundingClientRect().left - changeIcon.getBoundingClientRect().right)
      .toBeCloseTo(12, 1);
    for (const indicator of indicators) {
      expect(indicator.getBoundingClientRect().width).toBe(16);
      expect(indicator.getBoundingClientRect().left).toBe(indicators[0].getBoundingClientRect().left);
      expect(getComputedStyle(indicator).boxShadow).toBe('none');
      expect(getComputedStyle(indicator).borderLeftStyle).toBe('none');
      expect(getComputedStyle(indicator).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    }
    host.style.width = '360px';
    expect(panel.getBoundingClientRect().width).toBe(header.getBoundingClientRect().width);
    expect(controls.getBoundingClientRect().right).toBeLessThan(panel.getBoundingClientRect().right);
    expect(host.querySelector<HTMLElement>('.tree-actions')!.getBoundingClientRect().right)
      .toBeLessThan(panel.getBoundingClientRect().right);
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    const name = host.querySelector<HTMLElement>('.tree-node-name')!;
    expect(name.scrollWidth).toBe(name.clientWidth);
    scroll.scrollLeft = scroll.scrollWidth;
    expect(scroll.scrollLeft).toBeGreaterThan(0);
    expect(showChanges.getBoundingClientRect().left).toBeGreaterThanOrEqual(scroll.getBoundingClientRect().left);
    expect(showChanges.getBoundingClientRect().right).toBeLessThanOrEqual(scroll.getBoundingClientRect().right);
    host.style.width = '1200px';
    component.removeComparison();
    fixture.detectChanges();
    expect(panel.getBoundingClientRect().width).toBe(baselineWidth);
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
  });

  it.each([false, true])('keeps a centered 70% minimum card width for a small tree (embedded: %s)', embedded => {
    const response = resolvedTree(firstTag);
    response.tree.dependencies = [];
    if (embedded) {
      fixture = TestBed.createComponent(DependencyTreeComponent);
      fixture.componentRef.setInput('providedTree', response);
    } else {
      const component = createComponent();
      component.chooseVersion(firstTag);
      fixture.detectChanges();
      http.expectOne(dependenciesUrl(firstTag)).flush(response);
    }
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const shell = host.querySelector<HTMLElement>('.tree-shell')!;
    const panel = host.querySelector<HTMLElement>('.tree-panel')!;
    const scroll = host.querySelector<HTMLElement>('.tree-scroll')!;
    for (const width of ['1600px', '2400px']) {
      host.style.width = width;
      const shellStyle = getComputedStyle(shell);
      const availableWidth = shell.clientWidth
        - parseFloat(shellStyle.paddingLeft) - parseFloat(shellStyle.paddingRight);
      const card = panel.getBoundingClientRect();
      const layout = shell.getBoundingClientRect();
      expect(card.width).toBeCloseTo(availableWidth * 0.7, 1);
      expect(card.left + card.width / 2).toBeCloseTo(layout.left + layout.width / 2, 1);
      expect(scroll.scrollWidth).toBe(scroll.clientWidth);
      const badge = host.querySelector<HTMLElement>('.tree-node-version')!;
      const row = badge.closest<HTMLElement>('.tree-row')!;
      expect(badge.getBoundingClientRect().right)
        .toBeCloseTo(scroll.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight), 1);
    }
  });

  it('resizes an embedded tree card with its expanded content and scrolls long names internally', () => {
    fixture = TestBed.createComponent(DependencyTreeComponent);
    const response = resolvedTree(firstTag);
    fixture.componentRef.setInput('providedTree', response);
    const host = fixture.nativeElement as HTMLElement;
    host.style.width = '1200px';
    fixture.detectChanges();
    const controls = host.querySelector<HTMLElement>('.tree-controls')!;
    const panel = host.querySelector<HTMLElement>('.tree-panel')!;
    const scroll = host.querySelector<HTMLElement>('.tree-scroll')!;
    const baselineWidth = panel.getBoundingClientRect().width;
    expect(controls.closest('.panel')).toBe(panel);
    expect(baselineWidth).toBeLessThan(host.getBoundingClientRect().width);
    expect(panel.getBoundingClientRect().left + baselineWidth / 2)
      .toBeCloseTo(host.getBoundingClientRect().left + host.getBoundingClientRect().width / 2, 1);

    const longResponse = resolvedTree(firstTag);
    longResponse.tree.dependencies[0].dependencies[0].projectName = 'Grandchild Project with a long name '.repeat(12);
    fixture.componentRef.setInput('providedTree', longResponse);
    fixture.detectChanges();
    expect(panel.getBoundingClientRect().width).toBe(host.getBoundingClientRect().width);
    const expandedWidth = panel.getBoundingClientRect().width;
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    for (const name of host.querySelectorAll<HTMLElement>('.tree-node-name')) {
      expect(name.scrollWidth).toBe(name.clientWidth);
    }

    fixture.componentInstance.collapseAll();
    fixture.detectChanges();
    expect(panel.getBoundingClientRect().width).toBeLessThan(expandedWidth);
    expect(panel.getBoundingClientRect().width).toBeLessThanOrEqual(baselineWidth);
    expect(scroll.scrollWidth).toBe(scroll.clientWidth);
    fixture.componentInstance.expandAll();
    fixture.detectChanges();
    host.style.width = '360px';
    expect(panel.getBoundingClientRect().width).toBe(host.getBoundingClientRect().width);
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(host.getBoundingClientRect().right);
  });

  it('cancels the previous request when another tag is selected', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const previousRequest = http.expectOne(dependenciesUrl(firstTag));

    component.chooseVersion(secondTag);
    fixture.detectChanges();
    expect(previousRequest.cancelled).toBe(true);
    http.expectOne(dependenciesUrl(secondTag)).flush(resolvedTree(secondTag));
    fixture.detectChanges();

    expect(component.selectedVersion()).toBe(secondTag);
    expect(component.currentTree()?.root.version).toBe(secondTag);
  });

  it('adds a comparison selector, highlights differences, and removes the comparison', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('.compare-btn')!.click();
    fixture.detectChanges();
    const input = host.querySelector<HTMLInputElement>('#dependency-tree-compare-input')!;
    expect(input.labels?.[0].textContent).toBe('Compare with');
    input.focus();
    fixture.detectChanges();
    expect(Array.from(host.querySelectorAll('#dependency-tree-compare-list .version-option__name'))
      .map((option) => option.textContent?.trim())).toEqual([secondTag]);
    input.value = secondTag;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(host.querySelector('.comparison-status')?.textContent).toContain(secondTag);
    expect(host.querySelector('.comparison-status .tree-loading__text')?.textContent)
      .toBe(`Resolving version ${secondTag}.`);
    const comparison = resolvedTree(secondTag);
    comparison.tree.dependencies[0].version = 'v2.5.0';
    comparison.tree.dependencies[0].dependencies = [];
    comparison.tree.dependencies.push({
      projectId: 'new-project', projectName: 'New Project', version: 'v1.0.0', dependencies: [],
    });
    http.expectOne(dependenciesUrl(secondTag)).flush(comparison);
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-column-headings > span:not(.tree-change-indicator)').length).toBe(3);
    expect(host.querySelectorAll('.tree-row--changed').length).toBe(2);
    expect(host.querySelectorAll('.tree-row .tree-change-icon--changed').length).toBe(2);
    expect(host.querySelectorAll('.tree-row--added .tree-change-icon--added').length).toBe(1);
    expect(host.querySelectorAll('.tree-row--removed .tree-change-icon--removed').length).toBe(1);
    expect(host.querySelectorAll('.tree-row--removed').length).toBe(1);
    expect(host.querySelectorAll('.tree-row--added').length).toBe(1);
    for (const badge of host.querySelectorAll<HTMLElement>('.tree-node-version')) {
      expect(getComputedStyle(badge).backgroundColor).toMatch(/^rgb\(/);
    }
    expect(host.querySelector('.tree-row--removed .tree-comparison-version')?.textContent)
      .toContain('Not present');
    expect(host.querySelector('.tree-row--added .tree-node-version')?.textContent)
      .toContain('Not present');
    component.collapseAll();
    fixture.detectChanges();
    expect(component.visibleNodes().length).toBe(1);
    component.expandAll();
    fixture.detectChanges();
    expect(component.visibleNodes().length).toBe(4);
    host.querySelector<HTMLButtonElement>('.comparison-remove')!.click();
    fixture.detectChanges();
    expect(host.querySelector('#dependency-tree-compare-input')).toBeNull();
    expect(host.querySelector('.tree-column-headings')).toBeNull();
    expect(component.visibleNodes().length).toBe(3);
  });

  it('cancels pending comparison requests and retries comparison failures without hiding the baseline', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    const cancelled = http.expectOne(dependenciesUrl(secondTag));
    component.removeComparison();
    fixture.detectChanges();
    expect(cancelled.cancelled).toBe(true);
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(secondTag)).flush({ error: 'Comparison failed.' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(component.comparisonError()).toBe('Comparison failed.');
    expect(component.visibleNodes().length).toBe(3);
    component.retryComparison();
    http.expectOne(dependenciesUrl(secondTag)).flush(resolvedTree(secondTag));
    fixture.detectChanges();
    expect(component.comparing()).toBe(true);
  });

  it('shows the backend error and retries resolution for the same tag', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const message = 'Version "v2.4.0" was not found in the child repository.';
    http.expectOne(dependenciesUrl(firstTag)).flush({ error: message }, { status: 404, statusText: 'Not Found' });
    fixture.detectChanges();

    expect(component.dependencyTreeStatus()).toBe('error');
    expect(component.dependencyTreeError()).toBe(message);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);

    component.retryResolution();
    expect(component.dependencyTreeStatus()).toBe('loading');
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();

    expect(component.dependencyTreeStatus()).toBe('ready');
    expect(component.dependencyTreeError()).toBeNull();
  });

  it('logs an unreadable saved selection while still loading available versions', () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      localStorage.setItem(selectionKey, '{broken');

      const component = createComponent();

      expect(component.projectId()).toBe(projectId);
      expect(component.versionStatus()).toBe('ready');
      expect(component.selectedVersion()).toBe('');
      expect(logError).toHaveBeenCalledWith(
        'Unable to restore the last dependency tree selection.',
        expect.any(SyntaxError),
      );
    } finally {
      logError.mockRestore();
    }
  });

  it('restores both version selections when navigating away and back while comparison is resolving', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    component.addComparison();
    component.chooseComparisonVersion(secondTag);
    fixture.detectChanges();
    const pendingComparison = http.expectOne(dependenciesUrl(secondTag));
    expect(JSON.parse(localStorage.getItem(selectionKey)!)).toEqual({
      projectId, version: firstTag, comparisonEnabled: true, comparisonVersion: secondTag,
    });
    fixture.destroy();
    expect(pendingComparison.cancelled).toBe(true);

    const restored = createComponent();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    http.expectOne(dependenciesUrl(secondTag)).flush(resolvedTree(secondTag));
    fixture.detectChanges();
    expect(restored.selectedVersion()).toBe(firstTag);
    expect(restored.comparisonVersion()).toBe(secondTag);
    expect(restored.comparisonEnabled()).toBe(true);
    expect(restored.comparing()).toBe(true);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector<HTMLInputElement>('#dependency-tree-compare-input')?.value).toBe(secondTag);
    expect(host.querySelector('.tree-list--comparing')).toBeTruthy();
  });

  it('remembers removing comparison when navigating away and back', () => {
    localStorage.setItem(selectionKey, JSON.stringify({
      projectId, version: firstTag, comparisonEnabled: true, comparisonVersion: secondTag,
    }));
    const component = createComponent();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    http.expectOne(dependenciesUrl(secondTag)).flush(resolvedTree(secondTag));
    component.removeComparison();
    fixture.detectChanges();
    fixture.destroy();

    const restored = createComponent();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    http.expectNone(dependenciesUrl(secondTag));
    expect(restored.comparisonEnabled()).toBe(false);
    expect(restored.comparisonVersion()).toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('#dependency-tree-compare-input')).toBeNull();
  });

  it('restores an opened comparison picker even before a comparison version is chosen', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    component.addComparison();
    fixture.detectChanges();
    fixture.destroy();

    const restored = createComponent();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    expect(restored.comparisonEnabled()).toBe(true);
    expect(restored.comparisonVersion()).toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('#dependency-tree-compare-input')).toBeTruthy();
  });

  it('does not restore a comparison belonging to another project', () => {
    localStorage.setItem(selectionKey, JSON.stringify({
      projectId: 'another-project', version: firstTag, comparisonEnabled: true, comparisonVersion: secondTag,
    }));
    const component = createComponent();
    expect(component.selectedVersion()).toBe('');
    expect(component.comparisonEnabled()).toBe(false);
    expect(component.comparisonVersion()).toBe('');
    http.expectNone(dependenciesUrl(secondTag));
  });

  it('clears a remembered comparison version that is no longer available', () => {
    const missingTag = 'deleted-release';
    localStorage.setItem(selectionKey, JSON.stringify({
      projectId, version: firstTag, comparisonEnabled: true, comparisonVersion: missingTag,
    }));
    const component = createComponent();
    http.match(dependenciesUrl(missingTag)).forEach((request) => expect(request.cancelled).toBe(true));
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();
    expect(component.selectedVersion()).toBe(firstTag);
    expect(component.comparisonVersion()).toBe('');
    expect(component.comparisonStatus()).toBe('idle');
    expect(JSON.parse(localStorage.getItem(selectionKey)!).comparisonVersion).toBe('');
  });

  it('resolves the remembered root tag when the page is opened', () => {
    localStorage.setItem(selectionKey, JSON.stringify({ projectId, version: firstTag }));
    const component = createComponent();
    http.expectOne(dependenciesUrl(firstTag)).flush(resolvedTree(firstTag));
    fixture.detectChanges();

    expect(component.selectedVersion()).toBe(firstTag);
    expect(component.currentTree()?.root.version).toBe(firstTag);
  });

  it('cancels an active resolution when the component is destroyed', () => {
    const component = createComponent();
    component.chooseVersion(firstTag);
    fixture.detectChanges();
    const request = http.expectOne(dependenciesUrl(firstTag));

    fixture.destroy();
    expect(request.cancelled).toBe(true);
  });
});
