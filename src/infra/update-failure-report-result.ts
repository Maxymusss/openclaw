/** Projects durable report receipts into submission outcomes without performing I/O. */
import type { UpdateFailureReportReceipt } from "./restart-sentinel.js";

export type UpdateFailureReportSubmitResult =
  | { message?: string; savedReportPath: string; status: "created"; url: string }
  | {
      fallbackUrl: string;
      message: string;
      savedReportPath: string;
      status: "fallback";
    }
  | {
      fallbackUrl?: string;
      message: string;
      savedReportPath: string;
      status: "duplicate";
      url?: string;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "pending";
      url?: undefined;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "retryable";
      url?: undefined;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "stale";
      url?: undefined;
    };

export function resultFromExistingReceipt(
  receipt: UpdateFailureReportReceipt | null,
  savedReportPath: string,
  expectedPreviewDigest: string,
  expectedFallbackUrl: string | undefined,
): UpdateFailureReportSubmitResult {
  if (receipt?.status === "pending") {
    return {
      message: "This update attempt already has a report submission in progress.",
      savedReportPath,
      status: "pending",
    };
  }
  if (receipt?.status === "preparing") {
    return {
      message: "This update attempt already has a report preparation in progress.",
      savedReportPath,
      status: "retryable",
    };
  }
  if (receipt?.status === "prepared") {
    return {
      message: "This update attempt already has a report publication in progress.",
      savedReportPath,
      status: "retryable",
    };
  }
  if (receipt?.status === "retryable") {
    return {
      message: "No GitHub issue submission was started. This report can be retried.",
      savedReportPath,
      status: "retryable",
    };
  }
  const previewMatches = receipt?.previewDigest === expectedPreviewDigest;
  const matchingFallbackUrl =
    previewMatches && receipt?.status === "fallback" && receipt.fallbackUrl === expectedFallbackUrl
      ? receipt.fallbackUrl
      : undefined;
  return {
    status: "duplicate",
    savedReportPath,
    ...(previewMatches && receipt?.url ? { url: receipt.url } : {}),
    ...(matchingFallbackUrl ? { fallbackUrl: matchingFallbackUrl } : {}),
    message:
      receipt && !previewMatches
        ? "This update attempt has a report result for a different reviewed preview."
        : receipt?.status === "fallback" && !matchingFallbackUrl
          ? "This update attempt has a report handoff for a different reviewed preview."
          : receipt
            ? "This update attempt was already reported."
            : "This update attempt already has a report reservation.",
  };
}
