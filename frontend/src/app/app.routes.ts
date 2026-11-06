import { Routes } from '@angular/router';
import { DependencyTreeComponent } from './dependency-tree/dependency-tree.component';
import { FindRootVersionComponent } from './find-root-version/find-root-version.component';
import { TreeBuilderComponent } from './tree-builder/tree-builder.component';

export const routes: Routes = [
  { path: '', redirectTo: 'tree', pathMatch: 'full' },
  { path: 'tree', component: DependencyTreeComponent },
  { path: 'tree/:projectId', component: DependencyTreeComponent },
  { path: 'builder', component: TreeBuilderComponent },
  { path: 'find-root-version', component: FindRootVersionComponent },
];
