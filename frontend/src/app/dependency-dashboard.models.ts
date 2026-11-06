export type DashboardViewState = 'ready' | 'loading' | 'empty' | 'error';
export type RiskLevel = 'low' | 'medium' | 'high';
export type TrendState = 'improving' | 'steady' | 'rising';
export type ChangeImpact = 'added' | 'patch' | 'minor' | 'major' | 'removed';

export interface ProjectSnapshot {
  id: string;
  name: string;
  owner: string;
  latestRelease: string;
  activeDependencies: number;
  transitiveDependencies: number;
  openRisks: number;
  riskLevel: RiskLevel;
  trend: TrendState;
  note: string;
}

export interface DependencyChange {
  dependency: string;
  ecosystem: string;
  projectId: string;
  projectName: string;
  fromVersion: string;
  toVersion: string;
  impact: ChangeImpact;
  riskLevel: RiskLevel;
  note: string;
}

export interface ReleaseTimelineEntry {
  id: string;
  label: string;
  releasedAt: string;
  summary: string;
  projectIds: string[];
  changeCount: number;
  riskScore: number;
  highlights: string[];
  dependencyChanges: DependencyChange[];
}

export interface DependencyOverviewItem {
  name: string;
  ecosystem: string;
  currentVersion: string;
  latestVersion: string;
  projectsUsing: string[];
  riskLevel: RiskLevel;
  recentChange: string;
}

export interface DependencyDashboardData {
  generatedAt: string;
  projects: ProjectSnapshot[];
  timeline: ReleaseTimelineEntry[];
  dependencies: DependencyOverviewItem[];
}
