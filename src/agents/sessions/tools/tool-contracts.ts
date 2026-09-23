/**
 * Shared built-in session tool input/detail contracts.
 *
 * Keeps tool factories, renderers, and callers aligned on typed payload and metadata shapes.
 */
import { Type, type Static } from "typebox";
import type { bashSchema } from "./bash.js";
import type { editSchema, EditToolOutputSchema } from "./edit.js";
import type { findSchema } from "./find.js";
import type { grepSchema } from "./grep.js";
import type { lsSchema } from "./ls.js";
import type {
  readToolInputSchema,
  readToolOutputSchema,
  readTruncationOutputSchema,
} from "./read-tool-contract.js";
import type { TruncationResult } from "./truncate.js";
import type { writeSchema, WriteToolOutputSchema } from "./write.js";

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export function formatFullOutputFooter(path: string): string {
  return `Full output: ${path}`;
}

export type EditToolInput = Static<typeof editSchema>;
export type EditToolDetails = Static<typeof EditToolOutputSchema>;
export type FindToolInput = Static<typeof findSchema>;

// Keep one text payload; duplicate truncation content can exceed Code Mode value bounds.
export interface FindToolDetails {
  content: string;
  truncation?: Omit<TruncationResult, "content">;
  resultLimitReached?: number;
}

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
  content: string;
  truncation?: Omit<TruncationResult, "content">;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
  content: string;
  nextAfter?: string;
}

export type ReadToolInput = Static<typeof readToolInputSchema>;
export type ReadToolTruncationDetails = Static<typeof readTruncationOutputSchema>;

const readContinuationFields = {
  offset: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
};

export const ReadToolContinuationSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("line"), ...readContinuationFields },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("cursor"),
      ...readContinuationFields,
      cursor: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
]);

export type ReadToolContinuation = Static<typeof ReadToolContinuationSchema>;

export type ReadToolDetails = Static<typeof readToolOutputSchema>;
export type WriteToolInput = Static<typeof writeSchema>;
export type WriteToolDetails = Static<typeof WriteToolOutputSchema>;
