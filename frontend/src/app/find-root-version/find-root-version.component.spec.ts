import { formatDate } from '@angular/common';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, LOCALE_ID } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { FindRootVersionResponse, ProjectDefinitionResponse, } from '../tree-builder/project-definition-api.service';
import { FindRootVersionComponent } from './find-root-version.component';

@Component({ standalone: true, template: 'Another tab' })
class OtherTabComponent {}

describe('FindRootVersionComponent', () => {
  const projectsUrl = '/api/projects';
  const searchUrl = `${projectsUrl}/a/find-root-version`;
  const resultKey = 'dep-root-version:last-result';
  const dependency: ProjectDefinitionResponse = {
    id: 'c', name: 'c', repoUrl: 'https://example.com/c.git', description: null, dependencies: null,
  };
  const project: ProjectDefinitionResponse = {
    id: 'a', name: 'a', repoUrl: 'https://example.com/a.git', description: null,
    dependencies: [{
      project: {
        id: 'b', name: 'b', repoUrl: 'https://example.com/b.git', description: null,
        dependencies: [{ project: dependency, manifestPath: 'package.json', versionReference: 'c' }],
      },
      manifestPath: 'package.json', versionReference: 'b',
    }],
  };
  let fixture: ComponentFixture<FindRootVersionComponent>;
  let http: HttpTestingController;
  let previousResult: string | null;

  beforeEach(async () => {
    previousResult = localStorage.getItem(resultKey);
    localStorage.removeItem(resultKey);
    await TestBed.configureTestingModule({
      imports: [FindRootVersionComponent],
      providers: [
        provideRouter([
          { path: 'find-root-version', component: FindRootVersionComponent },
          { path: 'other-tab', component: OtherTabComponent },
        ]),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(FindRootVersionComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture?.destroy();
    vi.restoreAllMocks();
    if (previousResult === null) {
      localStorage.removeItem(resultKey);
    } else {
      localStorage.setItem(resultKey, previousResult);
    }
    http?.verify();
  });

  function loadProjects(projects = [project]): FindRootVersionComponent {
    http.expectOne(projectsUrl).flush({ projects });
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function prepareSearch(): FindRootVersionComponent {
    const component = loadProjects();
    component.selectDependency('c');
    component.setMinimumVersion(' 1.0.9 ');
    fixture.detectChanges();
    return component;
  }

  function reopenTab(projects = [project]): FindRootVersionComponent {
    fixture.destroy();
    fixture = TestBed.createComponent(FindRootVersionComponent);
    fixture.detectChanges();
    return loadProjects(projects);
  }

  function matchingResult(): FindRootVersionResponse {
    const path = [
      { projectId: 'a', projectName: 'a', version: '3.1.0' },
      { projectId: 'b', projectName: 'b', version: '2.0.0' },
      { projectId: 'c', projectName: 'c', version: '1.1.1' },
    ];
    return {
      projectId: 'a', dependencyProjectId: 'c', minimumVersion: '1.0.9',
      checkedVersions: 2, totalVersions: 3,
      warnings: [],
      match: {
        version: '3.1.0', dependencyVersion: '1.1.1', path,
        dependencyTree: {
          projectId: 'a', projectName: 'a', version: '3.1.0',
          tree: { ...path[0], dependencies: [{ ...path[1], dependencies: [{ ...path[2], dependencies: [] }] }] },
        },
      },
    };
  }

  function expectSearch() {
    return http.expectOne(request => request.url === searchUrl
      && request.params.get('dependencyProjectId') === 'c'
      && request.params.get('minimumVersion') === '1.0.9');
  }

  it('lists nested dependencies once and requires a dependency and minimum version', () => {
    const component = loadProjects([{
      ...project,
      dependencies: [...project.dependencies!, {
        project: dependency, manifestPath: 'package.json', versionReference: 'c',
      }],
    }]);
    expect(component.dependencies().map(value => value.id)).toEqual(['b', 'c']);
    expect(component.canSearch()).toBe(false);
    component.selectDependency('c');
    component.setMinimumVersion(' ');
    expect(component.canSearch()).toBe(false);
    component.setMinimumVersion('1.0.9');
    expect(component.canSearch()).toBe(true);
    component.selectDependency('unrelated');
    expect(component.canSearch()).toBe(false);
  });

  it('submits the threshold and renders the start of the latest matching run without refetching', () => {
    const component = prepareSearch();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')!.textContent).toBe('Find Root Version');
    expect(host.querySelector('label[for="version-search-project"] span')!.textContent).toBe('Root Project');
    expect(host.querySelector('label[for="version-search-minimum"] span')!.textContent)
      .toBe('Minimum Dependency Version');
    expect(host.querySelector('button[type="submit"]')!.textContent?.trim()).toBe('Find Root Version');
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(component.status()).toBe('loading');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(host.querySelector('.search-loading')).not.toBeNull();
    expect(host.querySelector('.search-loading')!.textContent).toContain('Validating the dependency tag');

    expectSearch().flush(matchingResult());
    fixture.detectChanges();

    expect(component.status()).toBe('ready');
    expect(host.textContent).not.toContain('First Root Version in Latest Matching Run');
    expect(host.querySelector('.result-label')).toBeNull();
    expect(host.querySelector('h2')!.textContent).toContain('3.1.0');
    expect(host.querySelector('.release-count')!.textContent).toContain('2 of 3');
    expect(Array.from(host.querySelectorAll('.dependency-path code')).map(node => node.textContent))
      .toEqual(['3.1.0', '2.0.0', '1.1.1']);
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    expect(host.querySelector<HTMLAnchorElement>('.tree-node-link')?.href).toBe(project.repoUrl);
    expect(host.querySelector('.warnings-button')).toBeNull();
    expect(JSON.parse(localStorage.getItem(resultKey)!)).toEqual(matchingResult());
    http.expectNone(request => request.url.includes('/versions'));
    http.expectNone(projectsUrl);
  });

  it.each([
    {
      status: 400, statusText: 'Bad Request',
      message: 'Tag "1.0.9" was not found for dependency "c" among its active tags matching its tag pattern.',
    },
    {
      status: 500, statusText: 'Internal Server Error',
      message: 'Cannot verify tag "1.0.9" for dependency "c". Authentication failed.',
    },
  ])('shows a dependency tag validation failure ($status) without saving a result and allows retry', failure => {
    const component = prepareSearch();
    component.search();
    expectSearch().flush({ error: failure.message }, { status: failure.status, statusText: failure.statusText });
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(failure.message);
    expect(component.status()).toBe('error');
    expect(component.projectId()).toBe('a');
    expect(component.dependencyProjectId()).toBe('c');
    expect(component.minimumVersion()).toBe(' 1.0.9 ');
    expect(component.result()).toBeNull();
    expect(localStorage.getItem(resultKey)).toBeNull();
    expect(host.querySelector('app-dependency-tree')).toBeNull();
    expect(host.textContent).not.toContain('No matching latest release run found');
    expect(component.canSearch()).toBe(true);

    component.search();
    expectSearch().flush(matchingResult());
    fixture.detectChanges();
    expect(component.status()).toBe('ready');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(resultKey)!)).toEqual(matchingResult());
  });

  it('shows the root version creation date in gray beside its heading with 24-hour GMT time', () => {
    const component = prepareSearch();
    const response = matchingResult();
    const creationDate = '2026-10-23T17:10:21+02:00';
    response.match!.dependencyTree.tree.creationDate = creationDate;
    component.search();
    expectSearch().flush(response);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    host.style.width = '1200px';
    const heading = host.querySelector<HTMLElement>('.search-result-title h2')!;
    const date = host.querySelector<HTMLTimeElement>('.search-result-date')!;
    const locale = TestBed.inject(LOCALE_ID);
    expect(date.textContent?.trim())
      .toBe(`${formatDate('2026-10-23T15:10:21Z', 'mediumDate', locale, 'UTC')}, 15:10:21 GMT`);
    expect(date.getAttribute('datetime')).toBe(creationDate);
    expect(date.title).toBe(`Version created ${creationDate}`);
    expect(date.getBoundingClientRect().left).toBeGreaterThan(heading.getBoundingClientRect().right);
    expect(getComputedStyle(date).color)
      .toBe(getComputedStyle(host.querySelector<HTMLElement>('.tree-node-version')!).color);
    expect(parseFloat(getComputedStyle(date).fontSize)).toBeLessThan(parseFloat(getComputedStyle(heading).fontSize));
    expect(host.querySelector('.release-count')?.textContent).toContain('2 of 3');
    host.style.width = '360px';
    const summary = host.querySelector<HTMLElement>('.search-results')!.getBoundingClientRect();
    expect(date.getBoundingClientRect().left).toBeGreaterThanOrEqual(summary.left);
    expect(date.getBoundingClientRect().right).toBeLessThanOrEqual(summary.right);
    expect(date.getBoundingClientRect().top).toBeGreaterThanOrEqual(heading.getBoundingClientRect().top);
    http.expectNone(() => true);
  });

  it.each([false, true])('collapses the entire result tree including its root (restored: %s)', restored => {
    let component = prepareSearch();
    const response = matchingResult();
    component.search();
    expectSearch().flush(response);
    fixture.detectChanges();
    if (restored) {
      component = reopenTab();
    }
    const host = fixture.nativeElement as HTMLElement;
    const filter = host.querySelector<HTMLInputElement>('.tree-search')!;
    filter.value = '1.1.1';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    host.querySelector<HTMLButtonElement>('.tree-actions button[title="Collapse all"]')!.click();
    fixture.detectChanges();
    expect(filter.value).toBe('');
    expect(host.querySelector('.tree-search-count')).toBeNull();
    expect(host.querySelectorAll('.tree-row').length).toBe(1);
    expect(host.querySelector('.tree-row')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.tree-node-name')?.textContent).toBe('a');
    expect(host.querySelectorAll('.dependency-path li').length).toBe(3);
    expect(component.result()).toEqual(response);
    expect(JSON.parse(localStorage.getItem(resultKey)!)).toEqual(response);
    host.querySelector<HTMLButtonElement>('.tree-actions button[title="Expand all"]')!.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    http.expectNone(() => true);
  });

  it('shows a no-match result when the newest inspectable release does not qualify', () => {
    const component = prepareSearch();
    component.search();
    expectSearch().flush({ ...matchingResult(), checkedVersions: 1, match: null });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('No matching latest release run found for c at 1.0.9 or newer.');
    expect(host.textContent).toContain('1 release checked.');
    expect(host.querySelector('app-dependency-tree')).toBeNull();
  });

  it('separates the version summary and path from the centered filter-and-tree card', () => {
    const component = prepareSearch();
    component.search();
    expectSearch().flush(matchingResult());
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const summary = host.querySelector<HTMLElement>('.search-results')!;
    const tree = host.querySelector<HTMLElement>('app-dependency-tree')!;
    const panel = tree.querySelector<HTMLElement>('.tree-panel')!;
    expect(summary.querySelector('.search-result-header')).not.toBeNull();
    expect(summary.querySelector('.dependency-path')).not.toBeNull();
    expect(summary.querySelector('.tree-controls')).toBeNull();
    expect(summary.contains(tree)).toBe(false);
    expect(summary.parentElement).toBe(tree.parentElement);
    expect(tree.querySelector('.tree-controls')?.closest('.panel')).toBe(panel);
    expect(getComputedStyle(panel).borderRadius).toBe(getComputedStyle(summary).borderRadius);
    for (const width of ['1200px', '360px']) {
      host.style.width = width;
      const card = panel.getBoundingClientRect();
      const layout = summary.getBoundingClientRect();
      expect(card.top - layout.bottom).toBeGreaterThanOrEqual(16);
      expect(Math.round(card.width)).toBeGreaterThanOrEqual(Math.round(layout.width * 0.7));
      expect(card.width).toBeLessThanOrEqual(layout.width);
      expect(card.left + card.width / 2).toBeCloseTo(layout.left + layout.width / 2, 1);
    }
    http.expectNone(() => true);
  });

  it('restores the last result and search inputs after navigating to another tab without searching again', async () => {
    loadProjects();
    fixture.destroy();
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl('/find-root-version', FindRootVersionComponent);
    http.expectOne(projectsUrl).flush({ projects: [project] });
    harness.detectChanges();
    component.selectDependency('c');
    component.setMinimumVersion(' 1.0.9 ');
    component.search();
    const response = matchingResult();
    expectSearch().flush(response);
    harness.detectChanges();
    expect(JSON.parse(localStorage.getItem(resultKey)!)).toEqual(response);

    await harness.navigateByUrl('/other-tab', OtherTabComponent);
    const restored = await harness.navigateByUrl('/find-root-version', FindRootVersionComponent);
    http.expectOne(projectsUrl).flush({
      projects: [{ ...project, id: 'other-root', name: '0 Other root' }, project],
    });
    harness.detectChanges();

    expect(restored).not.toBe(component);
    expect(restored.projectId()).toBe('a');
    expect(restored.dependencyProjectId()).toBe('c');
    expect(restored.minimumVersion()).toBe('1.0.9');
    expect(restored.result()).toEqual(response);
    expect(restored.status()).toBe('ready');
    const host = harness.routeNativeElement!;
    expect(host.querySelector<HTMLSelectElement>('#version-search-project')!.value).toBe('a');
    expect(host.querySelector<HTMLSelectElement>('#version-search-dependency')!.value).toBe('c');
    expect(host.querySelector<HTMLInputElement>('#version-search-minimum')!.value).toBe('1.0.9');
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    expect(host.querySelector<HTMLAnchorElement>('.tree-node-link')?.href).toBe(project.repoUrl);
    expect(host.querySelector('h2')!.textContent).toContain('3.1.0');
    http.expectNone(request => request.url !== projectsUrl);
  });

  it.each([false, true])('restores a completed result and its warnings after recreation (no match: %s)', noMatch => {
    const component = prepareSearch();
    const response = matchingResult();
    response.warnings = [{
      version: '3.2.0', reason: 'partial_tree',
      message: 'Some dependency versions could not be fully inspected.',
      dependencies: [{
        projectId: 'b', projectName: 'b', version: '2.0.0', reason: 'unretrievable_version',
      }, {
        projectId: 'c', projectName: 'c', version: 'unknown', reason: 'unknown_version',
      }],
    }];
    if (noMatch) {
      response.match = null;
    } else {
      response.match!.dependencyTree.tree.dependenciesResolved = false;
    }
    component.search();
    expectSearch().flush(response);
    fixture.detectChanges();

    const restored = reopenTab();
    expect(restored.result()).toEqual(response);
    expect(restored.status()).toBe('ready');
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.tree-row').length).toBe(noMatch ? 0 : 3);
    expect(host.querySelector('.release-count')!.textContent).toContain(noMatch ? '2 releases checked' : '2 of 3');
    expect(Array.from(host.querySelectorAll('.dependency-path code')).map(node => node.textContent))
      .toEqual(noMatch ? [] : ['3.1.0', '2.0.0', '1.1.1']);
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    expect(dialog.open).toBe(false);
    host.querySelector<HTMLButtonElement>('.warnings-button')!.click();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('2.0.0');
    expect(dialog.textContent).toContain('unknown');
    http.expectNone(request => request.url !== projectsUrl);
  });

  it.each([undefined, null, '2026-10-26T11:35:00.000Z'])('restores version creation dates and supports older undated snapshots (%s)', creationDate => {
    const response = matchingResult();
    response.match!.dependencyTree.tree.creationDate = creationDate;
    localStorage.setItem(resultKey, JSON.stringify(response));
    const component = loadProjects();
    expect(component.status()).toBe('ready');
    const host = fixture.nativeElement as HTMLElement;
    const root = host.querySelector('.tree-row')!;
    const popover = root.querySelector<HTMLElement>('.tree-tag-popover')!;
    expect(getComputedStyle(popover).display).toBe('none');
    if (creationDate) {
      expect(root.querySelector('time')?.getAttribute('datetime')).toBe(creationDate);
      expect(host.querySelector('.search-result-date')?.getAttribute('datetime')).toBe(creationDate);
    } else {
      expect(root.querySelector('time')).toBeNull();
      expect(host.querySelector('.search-result-date')).toBeNull();
      expect(root.querySelector('.tree-tag-popover__date')?.textContent).toBe('Date unavailable');
    }
    root.querySelector<HTMLElement>('.tree-node-version__text')!.focus();
    expect(popover.matches(':popover-open')).toBe(true);
    expect(host.querySelector('.tree-controls')?.closest('.panel')).toBe(host.querySelector('.tree-panel'));
    http.expectNone(() => true);
  });

  it.each(['not-a-date', 42])('rejects a malformed saved creation time (%s) with the existing restoration notice', creationDate => {
    const response = matchingResult();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(resultKey, JSON.stringify({
      ...response,
      match: {
        ...response.match,
        dependencyTree: {
          ...response.match!.dependencyTree,
          tree: { ...response.match!.dependencyTree.tree, creationDate },
        },
      },
    }));
    const component = loadProjects();
    expect(component.result()).toBeNull();
    expect(component.storageError()).toContain('The saved search result could not be restored.');
    expect(errorLog).toHaveBeenCalled();
    expect(localStorage.getItem(resultKey)).toBeNull();
  });

  it.each(['project', 'dependency', 'minimum version', 'new search'])('clears the saved result on %s changes', input => {
    const component = prepareSearch();
    component.search();
    expectSearch().flush(matchingResult());
    expect(localStorage.getItem(resultKey)).not.toBeNull();
    switch (input) {
      case 'project': component.selectProject('a'); break;
      case 'dependency': component.selectDependency('b'); break;
      case 'minimum version': component.setMinimumVersion('1.1.0'); break;
      case 'new search': component.search(); break;
    }
    expect(localStorage.getItem(resultKey)).toBeNull();
    expect(component.result()).toBeNull();
    if (input === 'new search') {
      expectSearch().flush({ error: 'Search failed' }, { status: 500, statusText: 'Internal Server Error' });
      expect(localStorage.getItem(resultKey)).toBeNull();
      expect(component.status()).toBe('error');
    } else {
      const restored = reopenTab();
      expect(restored.result()).toBeNull();
      expect(restored.status()).toBe('idle');
    }
  });

  it.each([
    { name: 'malformed JSON', stored: '{invalid' },
    { name: 'an incomplete response', stored: JSON.stringify({ projectId: 'a' }) },
    {
      name: 'an invalid dependency tree',
      stored: JSON.stringify({
        ...matchingResult(),
        match: {
          ...matchingResult().match,
          dependencyTree: {
            ...matchingResult().match!.dependencyTree,
            tree: { projectId: 'a', projectName: 'a', version: '3.1.0', dependencies: [null] },
          },
        },
      }),
    },
    {
      name: 'invalid release counts',
      stored: JSON.stringify({ ...matchingResult(), checkedVersions: -1 }),
    },
    {
      name: 'invalid warnings',
      stored: JSON.stringify({
        ...matchingResult(),
        warnings: [{ version: '3.2.0', reason: 'partial_tree', message: 'Partial', dependencies: [null] }],
      }),
    },
    {
      name: 'a mismatched dependency path',
      stored: JSON.stringify({
        ...matchingResult(),
        match: {
          ...matchingResult().match,
          path: [{ projectId: 'a', projectName: 'a', version: '3.1.0' }],
        },
      }),
    },
  ])('discards $name without breaking the tab', ({ stored }) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(resultKey, stored);
    const component = loadProjects();
    expect(component.result()).toBeNull();
    expect(component.status()).toBe('idle');
    expect(localStorage.getItem(resultKey)).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('The saved search result could not be restored.');
    expect(errorLog).toHaveBeenCalled();
    component.selectDependency('c');
    component.setMinimumVersion('1.0.9');
    expect(component.canSearch()).toBe(true);
  });

  it.each(['project', 'dependency'])('discards a saved result whose %s is no longer configured', removed => {
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(resultKey, JSON.stringify(matchingResult()));
    const component = loadProjects(removed === 'project'
      ? [{ ...project, id: 'other-root' }]
      : [{ ...project, dependencies: null }]);
    expect(component.result()).toBeNull();
    expect(component.status()).toBe('idle');
    expect(component.projectId()).toBe(removed === 'project' ? 'other-root' : 'a');
    expect(component.dependencyProjectId()).toBe('');
    expect(localStorage.getItem(resultKey)).toBeNull();
    expect(warningLog).toHaveBeenCalled();
    expect(component.storageError()).toContain('project or dependency is no longer configured');
  });

  it('retains the saved result while project loading fails and restores it after retry', () => {
    const response = matchingResult();
    localStorage.setItem(resultKey, JSON.stringify(response));
    http.expectOne(projectsUrl).flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    expect(fixture.componentInstance.result()).toBeNull();
    expect(JSON.parse(localStorage.getItem(resultKey)!)).toEqual(response);
    fixture.componentInstance.loadProjects();
    const component = loadProjects();
    expect(component.result()).toEqual(response);
    expect(component.status()).toBe('ready');
    http.expectNone(searchUrl);
  });

  it('reports unavailable browser storage without preventing a new search', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError');
    });
    const component = loadProjects();
    getItem.mockRestore();
    expect(component.storageError()).toContain('Unable to read');
    expect(errorLog).toHaveBeenCalled();
    component.selectDependency('c');
    component.setMinimumVersion('1.0.9');
    component.search();
    expectSearch().flush(matchingResult());
    expect(component.result()).toEqual(matchingResult());
    expect(component.storageError()).toBeNull();
  });

  it('keeps the completed result visible and reports browser storage quota failures', () => {
    const component = prepareSearch();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });
    component.search();
    expectSearch().flush(matchingResult());
    fixture.detectChanges();
    expect(component.result()).toEqual(matchingResult());
    expect(component.status()).toBe('ready');
    expect(localStorage.getItem(resultKey)).toBeNull();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.tree-row').length).toBe(3);
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Unable to save this result in browser storage');
    expect(errorLog).toHaveBeenCalled();
  });

  it('reports failures to clear a saved result while still clearing the visible result', () => {
    const component = prepareSearch();
    component.search();
    expectSearch().flush(matchingResult());
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError');
    });
    component.setMinimumVersion('2.0.0');
    fixture.detectChanges();
    expect(component.result()).toBeNull();
    expect(component.status()).toBe('idle');
    expect(component.storageError()).toContain('Unable to clear');
    expect((fixture.nativeElement as HTMLElement).querySelector('app-dependency-tree')).toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });

  it.each([
    { name: 'malformed data', stored: '{invalid', projects: [project] },
    { name: 'a removed project', stored: JSON.stringify(matchingResult()), projects: [] },
  ])('reports clearing failures when discarding $name', ({ stored, projects }) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(resultKey, stored);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError');
    });
    const component = loadProjects(projects);
    expect(component.result()).toBeNull();
    expect(component.storageError()).toContain('Unable to clear the saved search result');
    expect(localStorage.getItem(resultKey)).toBe(stored);
    expect(errorLog).toHaveBeenCalled();
  });

  it('opens a tag-grouped warning dialog, preserves known versions, and restores focus on close', async () => {
    const component = prepareSearch();
    component.search();
    expectSearch().flush({
      ...matchingResult(),
      warnings: [{
        version: '3.2.0',
        reason: 'tree_unavailable',
        message: 'Version "3.2.0" was not found in "https://example.com/a.git".',
        dependencies: [],
      }, {
        version: '3.1.0',
        reason: 'partial_tree',
        message: 'Some dependency versions could not be fully inspected.',
        dependencies: [{
          projectId: 'b', projectName: 'b', version: '2.3.4', reason: 'unretrievable_version',
        }, {
          projectId: 'c', projectName: 'c', version: 'unknown', reason: 'unknown_version',
        }],
      }],
    });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector<HTMLButtonElement>('.warnings-button')!;
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    expect(button.textContent).toContain('2 tags');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(dialog.open).toBe(false);
    button.focus();
    button.click();
    expect(dialog.open).toBe(true);
    expect(dialog.matches(':modal')).toBe(true);
    expect(dialog.querySelectorAll('.tag-warning').length).toBe(2);
    expect(Array.from(dialog.querySelectorAll('h3 code')).map(node => node.textContent)).toEqual(['3.2.0', '3.1.0']);
    expect(dialog.textContent).toContain('2.3.4');
    expect(dialog.textContent).toContain('unknown');
    expect(dialog.textContent).toContain('Declared version preserved.');
    expect(dialog.textContent).toContain('https://example.com/a.git');
    expect(host.querySelector('h2:not(#warnings-title)')?.textContent).toContain('3.1.0');
    const closeButton = dialog.querySelector<HTMLButtonElement>('button')!;
    expect(document.activeElement).toBe(closeButton);
    closeButton.click();
    await fixture.whenStable();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(button);
    button.click();
    expect(dialog.open).toBe(true);
    component.setMinimumVersion('2.0.0');
    fixture.detectChanges();
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelector('.warnings-button')).toBeNull();
  });

  it('shows warnings with a no-match result and clears them before retrying', () => {
    const component = prepareSearch();
    component.search();
    expectSearch().flush({
      ...matchingResult(),
      match: null,
      warnings: [{
        version: '3.1.0', reason: 'tree_unavailable',
        message: 'The tree could not be inspected.', dependencies: [],
      }],
    });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('No matching latest release run found');
    const button = host.querySelector<HTMLButtonElement>('.warnings-button')!;
    expect(button.textContent).toContain('1 tag');
    button.click();
    expect(host.querySelector<HTMLDialogElement>('dialog')!.open).toBe(true);
    component.search();
    fixture.detectChanges();
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelector('.warnings-button')).toBeNull();
    expectSearch().flush(matchingResult());
    fixture.detectChanges();
    expect(host.querySelector('.warnings-button')).toBeNull();
  });

  it('shows an incomplete-search error and allows retrying without losing inputs', () => {
    const component = prepareSearch();
    component.search();
    const error = 'The start of the latest containing release run cannot be confirmed.';
    expectSearch().flush({ error }, { status: 500, statusText: 'Internal Server Error' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')!.textContent).toContain(error);
    expect(component.minimumVersion()).toBe(' 1.0.9 ');
    expect(component.canSearch()).toBe(true);
    component.search();
    expectSearch().flush(matchingResult());
    fixture.detectChanges();
    expect(component.result()?.match?.version).toBe('3.1.0');
  });

  it('cancels an obsolete request and clears stale results when inputs change', () => {
    const component = prepareSearch();
    component.search();
    const pending = expectSearch();
    component.setMinimumVersion('1.1.0');
    expect(pending.cancelled).toBe(true);
    expect(component.status()).toBe('idle');
    component.setMinimumVersion('1.0.9');
    component.search();
    expectSearch().flush(matchingResult());
    fixture.detectChanges();
    component.selectProject('a');
    fixture.detectChanges();
    expect(component.result()).toBeNull();
    expect(component.dependencyProjectId()).toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('app-dependency-tree')).toBeNull();
  });

  it('handles empty project lists and projects with no dependencies', () => {
    const component = loadProjects([]);
    expect(component.canSearch()).toBe(false);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No saved projects.');
    component.loadProjects();
    http.expectOne(projectsUrl).flush({ projects: [{ ...project, dependencies: null }] });
    fixture.detectChanges();
    expect(component.dependencies()).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No configured dependencies for this project.');
  });

  it('can retry loading projects after a server failure', () => {
    http.expectOne(projectsUrl).flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Unable to retrieve saved projects.');
    fixture.componentInstance.loadProjects();
    loadProjects();
    expect(fixture.componentInstance.projectsStatus()).toBe('ready');
  });

  it('unsubscribes from a pending search when leaving the tab', () => {
    const component = prepareSearch();
    component.search();
    const pending = expectSearch();
    fixture.destroy();
    expect(pending.cancelled).toBe(true);
  });
});
