import { Dependency } from "../models/Dependency";

export type ParseResult = {
  dependencies: Dependency[];

  /**
   * Optional: Some ecosystems define version ranges or indirect info
   */
  metadata?: {
    packageManager?: string;
    raw?: unknown;
  };
};
