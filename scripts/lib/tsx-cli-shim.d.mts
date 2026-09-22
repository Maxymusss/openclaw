import type { StdioOptions } from "node:child_process";

type CliShimOptions = {
  implementation?: string | URL;
  detached?: boolean;
  forceKillDelayMs?: number;
  executable?: string;
  execArgv?: readonly string[];
  stdio?: StdioOptions;
  terminationOwner?: "implementation";
  failureTool?: string;
};

export function resolveForwardedNodeCompilerArgs(execArgv?: readonly string[]): string[];
export function resolveTsxImport(checkoutRoot: string): string;
export function registerToolingTsx(): Promise<void>;
export function runNodeCliShim(moduleUrl: string | URL, options?: CliShimOptions): Promise<void>;
export function runTsxCliShim(moduleUrl: string | URL, options?: CliShimOptions): Promise<void>;
