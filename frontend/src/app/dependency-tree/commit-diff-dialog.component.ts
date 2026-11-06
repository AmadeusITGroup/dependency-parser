import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';

import {
  CommitDiffResponse,
  ProjectDefinitionApiService,
} from '../tree-builder/project-definition-api.service';
import { CommitComparisonTarget } from './dependency-tree.models';

@Component({
  selector: 'app-commit-diff-dialog',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './commit-diff-dialog.component.html',
  styleUrl: './commit-diff-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommitDiffDialogComponent implements AfterViewInit, OnDestroy {
  readonly comparison = input.required<CommitComparisonTarget>();
  readonly closed = output<void>();
  private readonly projectApi = inject(ProjectDefinitionApiService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private requestSub?: Subscription;
  private pointerDownOutside = false;

  readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  readonly error = signal<string | null>(null);
  readonly result = signal<CommitDiffResponse | null>(null);
  readonly areas = computed(() => {
    const result = this.result();
    return result ? [
      { side: 'baseline', version: result.fromVersion, missingFrom: result.toVersion, commits: result.fromOnly },
      { side: 'comparison', version: result.toVersion, missingFrom: result.fromVersion, commits: result.toOnly },
    ].filter(area => area.commits.length > 0) : [];
  });

  constructor() {
    effect(() => {
      const comparison = this.comparison();
      untracked(() => this.loadChanges(comparison));
    });
  }

  ngAfterViewInit(): void {
    this.dialog().nativeElement.showModal();
  }

  ngOnDestroy(): void {
    this.requestSub?.unsubscribe();
    this.dialog().nativeElement.close();
  }

  close(): void {
    this.dialog().nativeElement.close();
    this.closed.emit();
  }

  onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  onDialogPointerDown(event: PointerEvent): void {
    this.pointerDownOutside = this.isOutsideDialog(event);
  }

  onDialogClick(event: MouseEvent): void {
    const dismiss = this.pointerDownOutside && this.isOutsideDialog(event);
    this.pointerDownOutside = false;
    if (dismiss) {
      this.close();
    }
  }

  retry(): void {
    this.loadChanges(this.comparison());
  }

  private isOutsideDialog(event: MouseEvent): boolean {
    const dialog = this.dialog().nativeElement;
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (
      event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom
    );
  }

  private loadChanges(comparison: CommitComparisonTarget): void {
    this.requestSub?.unsubscribe();
    this.result.set(null);
    this.error.set(null);
    this.status.set('loading');
    this.requestSub = this.projectApi.compareCommits(
      comparison.projectId, comparison.fromVersion, comparison.toVersion,
    ).subscribe({
      next: result => {
        this.result.set(result);
        this.status.set('ready');
      },
      error: (error: unknown) => {
        const body: unknown = error instanceof HttpErrorResponse ? error.error : null;
        this.error.set(
          typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error : 'Unable to load commit changes. Please try again.',
        );
        this.status.set('error');
      },
    });
  }
}
