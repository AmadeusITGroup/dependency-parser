import { formatDate } from '@angular/common';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LOCALE_ID } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { page, userEvent } from 'vitest/browser';

import { CommitDiffResponse } from '../tree-builder/project-definition-api.service';
import { CommitDiffDialogComponent } from './commit-diff-dialog.component';
import { CommitComparisonTarget } from './dependency-tree.models';

describe('CommitDiffDialogComponent', () => {
  const target: CommitComparisonTarget = {
    projectId: 'child/project',
    name: 'Child Project',
    fromVersion: 'release/v1+build',
    toVersion: 'release/v2',
  };
  const url = `/api/projects/${encodeURIComponent(target.projectId)}/commit-diffs`;
  const fromHash = 'a'.repeat(40);
  const toHash = 'b'.repeat(40);
  const fromDate = '2026-10-20T12:34:56+02:00';
  const toDate = '2026-10-22T09:08:07-04:00';
  let fixture: ComponentFixture<CommitDiffDialogComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await page.viewport(1280, 900);
    await TestBed.configureTestingModule({
      imports: [CommitDiffDialogComponent],
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    fixture?.destroy();
    http.verify();
  });

  function createDialog(): HTMLElement {
    fixture = TestBed.createComponent(CommitDiffDialogComponent);
    fixture.componentRef.setInput('comparison', target);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function expectRequest(toVersion = target.toVersion) {
    return http.expectOne(request => request.url === url
      && request.params.get('fromVersion') === target.fromVersion
      && request.params.get('toVersion') === toVersion);
  }

  function response(overrides: Partial<CommitDiffResponse> = {}): CommitDiffResponse {
    return {
      projectId: target.projectId,
      projectName: target.name,
      fromVersion: target.fromVersion,
      toVersion: target.toVersion,
      fromCommitHash: fromHash,
      toCommitHash: toHash,
      fromOnly: [{
        hash: fromHash, subject: 'Only in baseline', committedAt: fromDate,
        url: `https://github.com/example/child/commit/${fromHash}`,
      }],
      toOnly: [{
        hash: toHash, subject: 'Fix <markup> & "quoted" names', committedAt: toDate,
        url: `https://github.com/example/child/commit/${toHash}`,
      }],
      ...overrides,
    };
  }

  it('opens a labelled native modal, shows loading, and keeps focus inside it', () => {
    const host = createDialog();
    const request = expectRequest();
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close commit changes"]')!;
    expect(dialog.open).toBe(true);
    expect(dialog.matches(':modal')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('commit-diff-title');
    expect(host.querySelector('#commit-diff-title')?.textContent).toContain(target.name);
    expect(host.querySelector('#commit-diff-versions')?.textContent).toContain(target.fromVersion);
    expect(host.querySelector('#commit-diff-versions')?.textContent).toContain(target.toVersion);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading commit changes');
    const spinner = host.querySelector<HTMLElement>('.commit-diff__spinner')!;
    expect(spinner.getAttribute('aria-hidden')).toBe('true');
    expect(spinner.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(getComputedStyle(spinner).animationName).toContain('commit-diff-spin');
    expect(getComputedStyle(spinner).animationIterationCount).toBe('infinite');
    expect(document.activeElement).toBe(close);

    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      outside.focus();
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      outside.remove();
    }
    fixture.destroy();
    expect(request.cancelled).toBe(true);
  });

  it('keeps a larger card while loading and after empty or failed responses', () => {
    const host = createDialog();
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const minimumHeight = 32 * rootFontSize;
    const expectedWidth = Math.min(76 * rootFontSize, window.innerWidth - 2 * rootFontSize);
    expect(dialog.getBoundingClientRect().height).toBeGreaterThanOrEqual(minimumHeight);
    expect(dialog.getBoundingClientRect().width).toBeCloseTo(expectedWidth, 0);
    expectRequest().flush(response({ fromOnly: [], toOnly: [] }));
    fixture.detectChanges();
    expect(dialog.getBoundingClientRect().height).toBeGreaterThanOrEqual(minimumHeight);
    expect(host.querySelector('.commit-diff__spinner')).toBeNull();
    fixture.componentInstance.retry();
    fixture.detectChanges();
    expect(host.querySelector('.commit-diff__spinner')).not.toBeNull();
    expectRequest().error(new ProgressEvent('error'));
    fixture.detectChanges();
    expect(dialog.getBoundingClientRect().height).toBeGreaterThanOrEqual(minimumHeight);
    expect(host.querySelector('.commit-diff__spinner')).toBeNull();
  });

  it.each([[1280, 900], [390, 844], [390, 320]])(
    'centers the loading wheel and text in the content area at %i x %i',
    async (width, height) => {
      await page.viewport(width, height);
      const host = createDialog();
      const body = host.querySelector<HTMLElement>('.commit-diff__body')!;
      const loading = host.querySelector<HTMLElement>('.commit-diff__loading')!;
      const bodyRect = body.getBoundingClientRect();
      const loadingRect = loading.getBoundingClientRect();
      expect(bodyRect.height).toBeGreaterThan(0);
      expect(Math.abs(loadingRect.left + loadingRect.width / 2 - bodyRect.left - bodyRect.width / 2))
        .toBeLessThan(1);
      expect(Math.abs(loadingRect.top + loadingRect.height / 2 - bodyRect.top - bodyRect.height / 2))
        .toBeLessThan(1);
      expectRequest().flush(response());
      fixture.detectChanges();
      expect(body.classList.contains('commit-diff__body--loading')).toBe(false);
    },
  );

  it('bounds the larger minimum card to a short mobile viewport', async () => {
    await page.viewport(390, 320);
    const host = createDialog();
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(dialog.scrollWidth).toBe(dialog.clientWidth);
    expectRequest().flush(response({ fromOnly: [], toOnly: [] }));
    fixture.detectChanges();
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it('renders baseline-only commits on the left and comparison-only commits on the right with clickable hashes and subjects', () => {
    const host = createDialog();
    expectRequest().flush(response());
    fixture.detectChanges();
    const areas = host.querySelectorAll<HTMLElement>('.commit-diff__area');
    expect(areas.length).toBe(2);
    expect(areas[0].dataset['side']).toBe('baseline');
    expect(areas[1].dataset['side']).toBe('comparison');
    expect(areas[0].querySelector('h3')?.textContent).toBe(`Only in ${target.fromVersion}`);
    expect(areas[0].querySelector('p')?.textContent).toBe(`Missing from ${target.toVersion}`);
    expect(areas[1].querySelector('h3')?.textContent).toBe(`Only in ${target.toVersion}`);
    expect(areas[1].querySelector('p')?.textContent).toBe(`Missing from ${target.fromVersion}`);
    expect(areas[0].getBoundingClientRect().right).toBeLessThan(areas[1].getBoundingClientRect().left);
    expect(areas[0].getBoundingClientRect().width).toBeCloseTo(areas[1].getBoundingClientRect().width, 0);
    for (const [index, hash] of [fromHash, toHash].entries()) {
      const link = areas[index].querySelector<HTMLAnchorElement>('a')!;
      expect(link.getAttribute('href')).toBe(`https://github.com/example/child/commit/${hash}`);
      expect(link.querySelector('code')?.textContent).toBe(hash);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      const date = index === 0 ? fromDate : toDate;
      const time = link.querySelector<HTMLTimeElement>('time')!;
      expect(time.getAttribute('datetime')).toBe(date);
      expect(time.title).toBe(date);
      expect(time.textContent?.trim()).toBe(`Committed ${formatDate(date, 'medium', TestBed.inject(LOCALE_ID))}`);
    }
    expect(areas[1].querySelector('a span')?.textContent).toBe('Fix <markup> & "quoted" names');
    expect(areas[1].querySelector('markup')).toBeNull();
    expect(host.querySelector('.commit-diff__spinner')).toBeNull();
  });

  it.each(['baseline', 'comparison'] as const)('uses one full-width area when only %s has exclusive commits', (side) => {
    const host = createDialog();
    expectRequest().flush(response(side === 'baseline' ? { toOnly: [] } : { fromOnly: [] }));
    fixture.detectChanges();
    const container = host.querySelector<HTMLElement>('.commit-diff__areas')!;
    const areas = container.querySelectorAll<HTMLElement>('.commit-diff__area');
    expect(areas.length).toBe(1);
    expect(areas[0].dataset['side']).toBe(side);
    expect(container.classList.contains('commit-diff__areas--split')).toBe(false);
    expect(areas[0].getBoundingClientRect().width).toBeCloseTo(container.getBoundingClientRect().width, 0);
  });

  it('stacks the two areas on small screens without horizontal overflow', async () => {
    await page.viewport(390, 844);
    const host = createDialog();
    expectRequest().flush(response());
    fixture.detectChanges();
    const areas = host.querySelectorAll<HTMLElement>('.commit-diff__area');
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    expect(areas[0].getBoundingClientRect().bottom).toBeLessThan(areas[1].getBoundingClientRect().top);
    expect(areas[0].getBoundingClientRect().left).toBe(areas[1].getBoundingClientRect().left);
    expect(dialog.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(dialog.scrollWidth).toBe(dialog.clientWidth);
  });

  it('shows an empty state for tags with identical commit histories', () => {
    const host = createDialog();
    expectRequest().flush(response({ fromOnly: [], toOnly: [], toCommitHash: fromHash }));
    fixture.detectChanges();
    expect(host.querySelectorAll('.commit-diff__area').length).toBe(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('These tags have no commit differences.');
  });

  it('shows backend errors and retries the same comparison', () => {
    const host = createDialog();
    expectRequest().flush({ error: 'Git ref "missing" was not found.' }, { status: 404, statusText: 'Not Found' });
    fixture.detectChanges();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Git ref "missing" was not found.');
    expect(host.querySelectorAll('.commit-diff__area').length).toBe(0);
    host.querySelector<HTMLButtonElement>('.commit-diff__retry')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading');
    expectRequest().flush(response({ fromOnly: [] }));
    fixture.detectChanges();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelectorAll('.commit-diff__area').length).toBe(1);
  });

  it('reports a readable error for network failures', () => {
    const host = createDialog();
    expectRequest().error(new ProgressEvent('error'));
    fixture.detectChanges();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Unable to load commit changes. Please try again.');
  });

  it('cancels obsolete requests when the comparison changes', () => {
    const host = createDialog();
    const previous = expectRequest();
    fixture.componentRef.setInput('comparison', { ...target, toVersion: 'release/v3' });
    fixture.detectChanges();
    expect(previous.cancelled).toBe(true);
    expectRequest('release/v3').flush(response({ toVersion: 'release/v3', fromOnly: [] }));
    fixture.detectChanges();
    expect(host.querySelector('h3')?.textContent).toContain('release/v3');
  });

  it('closes and notifies the parent when Escape is pressed', async () => {
    const host = createDialog();
    expectRequest().flush(response());
    fixture.detectChanges();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    await userEvent.keyboard('{Escape}');
    expect(dialog.open).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes and notifies the parent when the backdrop is clicked', async () => {
    const host = createDialog();
    expectRequest().flush(response());
    fixture.detectChanges();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    await userEvent.click(dialog, { position: { x: -8, y: -8 }, force: true });
    expect(dialog.open).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss for clicks on content or the card padding', async () => {
    const host = createDialog();
    expectRequest().flush(response());
    fixture.detectChanges();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    await userEvent.click(host.querySelector<HTMLElement>('#commit-diff-title')!);
    await userEvent.click(dialog, { position: { x: 8, y: 8 } });
    expect(dialog.open).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  });

  it('does not dismiss when a pointer gesture starts or ends inside the card', () => {
    const host = createDialog();
    expectRequest().flush(response());
    fixture.detectChanges();
    const dialog = host.querySelector<HTMLDialogElement>('dialog')!;
    const bounds = dialog.getBoundingClientRect();
    const inside = { clientX: bounds.left + 8, clientY: bounds.top + 8, bubbles: true };
    const outside = { clientX: bounds.left - 8, clientY: bounds.top - 8, bubbles: true };
    dialog.dispatchEvent(new PointerEvent('pointerdown', inside));
    dialog.dispatchEvent(new MouseEvent('click', outside));
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new PointerEvent('pointerdown', outside));
    dialog.dispatchEvent(new MouseEvent('click', inside));
    expect(dialog.open).toBe(true);
  });

  it.each(['light', 'dark'])('uses a red Close button in the %s theme without changing Retry', (theme) => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme');
    root.setAttribute('data-theme', theme);
    try {
      const host = createDialog();
      expectRequest().flush({ error: 'Comparison failed.' }, { status: 500, statusText: 'Server Error' });
      fixture.detectChanges();
      const close = host.querySelector<HTMLButtonElement>('[aria-label="Close commit changes"]')!;
      const retry = host.querySelector<HTMLButtonElement>('.commit-diff__retry')!;
      expect(getComputedStyle(close).color).toBe(theme === 'light' ? 'rgb(185, 28, 28)' : 'rgb(254, 202, 202)');
      expect(getComputedStyle(close).backgroundColor).not.toBe(getComputedStyle(retry).backgroundColor);
      expect(retry.classList.contains('commit-diff__button--close')).toBe(false);
    } finally {
      if (previousTheme === null) {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', previousTheme);
      }
    }
  });
});
