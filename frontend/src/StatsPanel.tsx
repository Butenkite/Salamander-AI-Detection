import type { AnalyzeMeta, DetectionFrame, TrackMetric } from "./api";

type StatusKind = "idle" | "loading" | "ok" | "error";

interface Props {
  status: StatusKind;
  percent: number;
  processedFrames: number;
  meta: AnalyzeMeta | null;
  frames: DetectionFrame[];
  tracks: TrackMetric[];
  fileName: string | null;
  errorMessage?: string;
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function statusLabel(status: StatusKind): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "loading":
      return "Processing";
    case "ok":
      return "Complete";
    case "error":
      return "Error";
  }
}

export function StatsPanel({
  status,
  percent,
  processedFrames,
  meta,
  frames,
  tracks,
  fileName,
  errorMessage,
}: Props) {
  const totalFrames = meta?.frame_count ?? 0;
  const framesWithDetections = frames.filter((f) => f.boxes.length > 0).length;
  const totalDetections = frames.reduce((n, f) => n + f.boxes.length, 0);
  const uniqueTrackIds = new Set(
    frames.flatMap((f) =>
      f.boxes.map((b) => b.track_id).filter((id): id is number => id != null),
    ),
  ).size;

  const timeProcessed =
    meta && meta.fps > 0 ? (processedFrames / meta.fps).toFixed(2) : "—";
  const duration = meta ? meta.duration_sec.toFixed(2) : "—";

  return (
    <aside className="stats-panel">
      <h2>Analysis</h2>

      <dl className="stat-list">
        <StatRow label="Status" value={statusLabel(status)} />
        {fileName && <StatRow label="File" value={fileName} />}
        {status === "error" && errorMessage && (
          <StatRow label="Error" value={errorMessage} />
        )}

        {status === "idle" && !meta && (
          <StatRow label="Progress" value="—" />
        )}

        {(status === "loading" || status === "ok") && meta && (
          <>
            <StatRow label="Progress" value={`${percent}%`} />
            <StatRow
              label="Frames"
              value={
                totalFrames > 0
                  ? `${processedFrames} / ${totalFrames}`
                  : String(processedFrames)
              }
            />
            <StatRow label="Time processed" value={`${timeProcessed} s`} />
            <StatRow label="Duration" value={`${duration} s`} />
            <StatRow label="Resolution" value={`${meta.width}×${meta.height}`} />
            <StatRow label="FPS" value={meta.fps.toFixed(2)} />
            <StatRow
              label="Frames w/ detections"
              value={framesWithDetections}
            />
            <StatRow label="Total detections" value={totalDetections} />
            <StatRow label="Tracks (so far)" value={uniqueTrackIds} />
            {tracks.length > 0 && (
              <StatRow label="Tracks (final)" value={tracks.length} />
            )}
          </>
        )}
      </dl>
    </aside>
  );
}
