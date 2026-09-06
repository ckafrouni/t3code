import type { LanguageRequest, LanguageResult } from "@t3tools/contracts";

export interface DocumentChange {
  start: number;
  deleteLength: number;
  text: string;
}

/** A language adapter owns analysis only; workspace synchronization and lifecycle are shared. */
export interface LanguageBackend {
  readonly closed: boolean;
  update(contents: string, version: number, change?: DocumentChange): Promise<void>;
  query(input: LanguageRequest): Promise<LanguageResult>;
  dispose(): void;
}
