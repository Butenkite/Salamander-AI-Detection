import { useCallback, useEffect, useState } from "react";
import { listExports, type ExportSummary } from "./api";

interface Props {
  disabled: boolean;
  activeRunId: string | null;
  onOpen: (run: ExportSummary) => void;
  refreshToken: number;
}

function formatWhen(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function PreviousRuns({
  disabled,
  activeRunId,
  onOpen,
  refreshToken,
}: Props) {
  const [runs, setRuns] = useState<ExportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRuns(await listExports());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <section className="previous-runs">
      <div className="previous-runs-header">
        <h2>Previous runs</h2>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading && runs.length === 0 && (
        <p className="previous-runs-muted">Loading…</p>
      )}
      {error && <p className="previous-runs-error">{error}</p>}
      {!loading && !error && runs.length === 0 && (
        <p className="previous-runs-muted">
          No saved runs yet. Analyze a video to create one.
        </p>
      )}

      <ul className="previous-runs-list">
        {runs.map((run) => (
          <li
            key={run.run_id}
            className={
              activeRunId === run.run_id ? "previous-run active" : "previous-run"
            }
          >
            <div className="previous-run-info">
              <strong>{run.source_video || run.run_id}</strong>
              <span>{formatWhen(run.analyzed_at)}</span>
              <span>
                {run.frame_count} frames ·{" "}
                {(Number(run.duration_sec) || 0).toFixed(1)} s ·{" "}
                {run.track_count} track{run.track_count === 1 ? "" : "s"}
              </span>
            </div>
            <button
              type="button"
              disabled={disabled || !run.has_video}
              onClick={() => onOpen(run)}
              title={
                run.has_video
                  ? "Load video and detections"
                  : "Video file missing for this run"
              }
            >
              Open
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
