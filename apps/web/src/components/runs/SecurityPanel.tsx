import { formatDateTime } from "../../lib/format";
import type { Run, RunSecurityResult } from "../../types";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Panel, PanelHeader } from "../ui/Panel";

const STATUS_TONES: Record<string, BadgeTone> = {
  passed: "success",
  failed: "danger",
  error: "danger",
  unavailable: "neutral",
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function overallStatus(results: RunSecurityResult[]): string {
  if (results.some((result) => result.status === "failed")) {
    return "failed";
  }

  if (results.some((result) => result.status === "error")) {
    return "error";
  }

  if (
    results.length > 0 &&
    results.every((result) => result.status === "unavailable")
  ) {
    return "unavailable";
  }

  return "passed";
}

/**
 * Shows the persisted security gate results for a coding run. It only renders
 * what the backend actually stored; runs that were never scanned render
 * nothing.
 */
export function SecurityPanel({
  run,
  security = [],
}: {
  run: Run;
  security?: RunSecurityResult[];
}) {
  const artifact = run.artifacts?.find(
    (entry) => entry.kind === "security_scan"
  );
  const summary = record(artifact?.data);
  const results = security.length > 0 ? security : [];
  const status =
    typeof summary?.status === "string"
      ? summary.status
      : overallStatus(results);
  const policy =
    typeof summary?.policy === "string" ? summary.policy : null;
  const blocking = summary?.blocking === true;
  const gateError =
    typeof summary?.error === "string" ? summary.error : null;

  if (results.length === 0 && !summary) {
    return null;
  }

  const tone = STATUS_TONES[status] ?? "neutral";
  const label =
    status === "passed"
      ? "Passed"
      : status === "failed"
        ? "Findings"
        : status === "error"
          ? "Error"
          : "Unavailable";

  return (
    <Panel>
      <PanelHeader
        title="Security"
        description="Gate executed against the worktree before commit"
        action={
          <span className="flex items-center gap-2">
            {policy ? <Badge tone="neutral">{policy}</Badge> : null}
            <Badge tone={tone} dot>
              {label}
            </Badge>
          </span>
        }
      />
      <div className="space-y-3 p-4">
        {blocking ? (
          <p className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[11px] leading-5 text-danger">
            The fail-closed policy blocked this run because the gate reported
            findings.
          </p>
        ) : null}

        {gateError ? (
          <p className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[11px] leading-5 text-warn">
            {gateError}
          </p>
        ) : null}

        {results.length === 0 ? (
          <p className="text-[11px] text-muted">
            The gate provided a summary but no per-scanner rows.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {results.map((result) => (
              <li key={result.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={STATUS_TONES[result.status] ?? "neutral"}
                    dot
                  >
                    {result.status}
                  </Badge>
                  <code className="font-mono text-[11px] text-fg">
                    {result.scannerId}
                  </code>
                  <span className="ml-auto font-mono text-[10px] text-muted">
                    {formatDateTime(result.scannedAt)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-5 break-words text-muted">
                  {result.description}
                </p>
                {result.error ? (
                  <details className="group mt-1.5">
                    <summary className="cursor-pointer list-none text-[11px] font-medium text-muted hover:text-fg">
                      <span className="group-open:hidden">Show scanner output</span>
                      <span className="hidden group-open:inline">
                        Hide scanner output
                      </span>
                    </summary>
                    <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-line bg-subtle/60 px-2.5 py-2 font-mono text-[10px] leading-4 whitespace-pre-wrap text-fg">
                      {result.error}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
