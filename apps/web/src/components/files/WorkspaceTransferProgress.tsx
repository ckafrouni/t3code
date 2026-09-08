import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  dismissWorkspaceTransfer,
  useWorkspaceTransfers,
  type TransferJob,
} from "./workspaceTransfers";

export function WorkspaceTransferProgress() {
  const jobs = useWorkspaceTransfers((s) => s.jobs);
  if (!jobs.length) return null;
  return (
    <div
      className="max-h-64 shrink-0 overflow-auto border-t border-border/60 p-2 text-xs"
      aria-label="File transfers"
    >
      {jobs.map((job) => (
        <TransferProgress key={job.id} job={job} />
      ))}
    </div>
  );
}

function TransferProgress({ job }: { job: TransferJob }) {
  const [applyAll, setApplyAll] = useState(false);
  return (
    <div className="space-y-2 py-2" role="status">
      <div className="break-all font-medium">
        {job.status === "complete"
          ? "Upload complete"
          : job.status === "cancelled"
            ? "Upload cancelled"
            : job.status === "failed"
              ? "Upload failed"
              : "Uploading"}{" "}
        · {job.destination}
      </div>
      {job.status === "uploading" ? (
        <>
          <div className="truncate">{job.entries[job.index]?.path}</div>
          <progress className="h-1 w-full" max={job.total || 1} value={job.bytes} />
          <div>
            {Math.round(job.bytes / 1024).toLocaleString()} /{" "}
            {Math.round(job.total / 1024).toLocaleString()} KB
          </div>
        </>
      ) : null}
      {job.status === "conflict" ? (
        <div className="space-y-2">
          <div className="break-all">{job.conflictPath} already exists.</div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={applyAll}
              onChange={(e) => setApplyAll(e.target.checked)}
            />
            Apply to remaining conflicts
          </label>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["replace", "Replace"],
                ["keep-both", "Keep both"],
                ["skip", "Skip"],
              ] as const
            ).map(([choice, label]) => (
              <Button
                key={choice}
                size="xs"
                variant="outline"
                onClick={() => job.decide(choice, applyAll)}
              >
                {choice === "replace" &&
                job.conflictKind === "directory" &&
                !job.entries[job.index]?.file
                  ? "Merge"
                  : label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {job.error ? <div className="break-words text-destructive">{job.error}</div> : null}
      <div className="flex gap-2">
        {job.status === "uploading" || job.status === "conflict" ? (
          <Button size="xs" variant="ghost" onClick={job.cancel}>
            Cancel transfer
          </Button>
        ) : (
          <>
            {job.status !== "complete" ? (
              <Button size="xs" variant="outline" onClick={job.retry}>
                Retry transfer
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => dismissWorkspaceTransfer(job.id)}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
