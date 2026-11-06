import { DependencyChange, DiffResult } from "../../domain/types/DiffResult";

export type DependencyChangeDTO = {
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
};

export class DiffResultDTO {
  constructor(
    public readonly projectId: string,
    public readonly projectName: string,
    public readonly fromVersion: string,
    public readonly toVersion: string,
    public readonly compareUrl: string | null,
    public readonly added: DependencyChangeDTO[],
    public readonly removed: DependencyChangeDTO[],
    public readonly updated: DependencyChangeDTO[]
  ) {}

  static fromDomain(
    projectId: string,
    projectName: string,
    fromVersion: string,
    toVersion: string,
    diffResult: DiffResult,
    compareUrl: string | null = null
  ): DiffResultDTO {
    return new DiffResultDTO(
      projectId,
      projectName,
      fromVersion,
      toVersion,
      compareUrl,
      diffResult.added.map(change => DiffResultDTO.mapChange(change)),
      diffResult.removed.map(change => DiffResultDTO.mapChange(change)),
      diffResult.updated.map(change => DiffResultDTO.mapChange(change))
    );
  }

  private static mapChange(change: DependencyChange): DependencyChangeDTO {
    return {
      name: change.name,
      fromVersion: change.fromVersion,
      toVersion: change.toVersion,
    };
  }
}
