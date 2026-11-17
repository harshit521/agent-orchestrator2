import {
  SecurityScanner,
  resolveScannerDefinitions,
  type ScannerResult,
} from "./scanner.js";

export type SecurityPolicy = "fail-closed" | "warn-only";

export interface SecurityGate {
  readonly policy: SecurityPolicy;
  /** Scans an execution worktree before its changes are committed. */
  scan(target: string): Promise<ScannerResult[]>;
}

export interface SecurityGateOptions {
  policy: SecurityPolicy;
  scanners?: string[];
  timeoutMs: number;
}

/**
 * Builds the run-level security gate from the existing scanner. The gate is
 * only constructed when `SECURITY_ENABLED=true`; the caller treats a missing
 * gate as "security checks are disabled".
 */
export function createSecurityGate(options: SecurityGateOptions): SecurityGate {
  const definitions = resolveScannerDefinitions(options.scanners);

  if (definitions.length === 0) {
    throw new Error(
      `No known security scanners match SECURITY_SCANNERS (${(
        options.scanners ?? []
      ).join(",")}).`
    );
  }

  return {
    policy: options.policy,
    scan: (target) =>
      new SecurityScanner({
        root: target,
        definitions,
        timeoutMs: options.timeoutMs,
      }).scan("."),
  };
}
