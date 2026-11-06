export class Version {
  constructor(
    public version: string,
    public creationDate: Date | null,
    public commitHash: string | null = null,
    public removed = false,
    public hasDependencyTree = false
  ) {}
}
