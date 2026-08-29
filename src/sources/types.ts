/**
 * Source readers fetch raw material and return typed results.
 * No filtering, no scoring — the oracle does that.
 */

export interface SourceDocument {
  /** Which reader produced this: "email" | "transcript" | "dossier". */
  kind: string;
  /** Stable pointer back to the origin, written to the Source Ref column. */
  reference: string;
  title: string;
  content: string;
}

/** A reader that is switched off or unconfigured returns [] rather than throwing. */
export type SourceReader = () => Promise<SourceDocument[]>;
