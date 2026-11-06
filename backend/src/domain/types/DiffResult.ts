export type DependencyChange = {
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
};

export type DiffResult = {
  added: DependencyChange[];
  removed: DependencyChange[];
  updated: DependencyChange[];
};
