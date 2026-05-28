import { useEffect, useRef, useState } from "react";
import {
  exportVideoUrl,
  streamAnalyzeVideo,
  streamReplayExport,
  type AnalyzeMeta,
  type DetectionFrame,
  type ExportSummary,
  type TrackMetric,
} from "./api";
import { VideoOverlay } from "./VideoOverlay";
import { StatsPanel } from "./StatsPanel";
import { PreviousRuns } from "./PreviousRuns";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

const FRAME_BATCH = 8;
const REPLAY_BATCH = 32;

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoUrlIsBlob, setVideoUrlIsBlob] = useState(false);
  const [displayFileName, setDisplayFileName] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [exportsRefresh, setExportsRefresh] = useState(0);
  const [tracks, setTracks] = useState<TrackMetric[]>([]);
  const [frames, setFrames] = useState<DetectionFrame[]>([]);
  const [meta, setMeta] = useState<AnalyzeMeta | null>(null);
  const [percent, setPercent] = useState(0);
  const [processedFrames, setProcessedFrames] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const pendingFrames = useRef<DetectionFrame[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const frameBatchSize = useRef(FRAME_BATCH);

  function revokeVideoUrl() {
    if (videoUrl && videoUrlIsBlob) {
      URL.revokeObjectURL(videoUrl);
    }
  }

  useEffect(() => {
    return () => {
      revokeVideoUrl();
      abortRef.current?.abort();
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flushPendingFrames() {
    if (pendingFrames.current.length === 0) return;
    const batch = pendingFrames.current;
    pendingFrames.current = [];
    setFrames((prev) => [...prev, ...batch]);
  }

  function scheduleFlush() {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushPendingFrames();
    }, 80);
  }

  function queueFrame(frame: DetectionFrame) {
    pendingFrames.current.push(frame);
    if (pendingFrames.current.length >= frameBatchSize.current) {
      flushPendingFrames();
    } else {
      scheduleFlush();
    }
  }

  function resetAnalysisState() {
    setTracks([]);
    setFrames([]);
    setMeta(null);
    setPercent(0);
    setProcessedFrames(0);
    pendingFrames.current = [];
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;

    abortRef.current?.abort();
    if (flushTimer.current) clearTimeout(flushTimer.current);

    revokeVideoUrl();

    setFile(f);
    setActiveRunId(null);
    resetAnalysisState();
    setStatus({ kind: "idle" });
    setDisplayFileName(f?.name ?? null);
    setVideoUrlIsBlob(!!f);
    setVideoUrl(f ? URL.createObjectURL(f) : null);
  }

  const streamHandlers = {
    onMeta: (m: AnalyzeMeta) => {
      setMeta(m);
      if (m.export_id) setActiveRunId(m.export_id);
    },
    onFrame: (frame: DetectionFrame) => {
      setProcessedFrames(frame.frame_idx + 1);
      queueFrame(frame);
    },
    onProgress: (p: number) => setPercent(p),
    onDone: (t: TrackMetric[], exportId?: string) => {
      flushPendingFrames();
      setTracks(t);
      setPercent(100);
      setStatus({ kind: "ok" });
      if (exportId) setActiveRunId(exportId);
      setExportsRefresh((n) => n + 1);
    },
  };

  async function onAnalyze() {
    if (!file) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    frameBatchSize.current = FRAME_BATCH;
    resetAnalysisState();
    setStatus({ kind: "loading" });

    try {
      await streamAnalyzeVideo(file, streamHandlers, controller.signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }

  async function onOpenPreviousRun(run: ExportSummary) {
    abortRef.current?.abort();
    if (flushTimer.current) clearTimeout(flushTimer.current);

    const controller = new AbortController();
    abortRef.current = controller;

    revokeVideoUrl();

    setFile(null);
    setActiveRunId(run.run_id);
    setDisplayFileName(run.source_video);
    resetAnalysisState();
    setStatus({ kind: "loading" });
    frameBatchSize.current = REPLAY_BATCH;

    setVideoUrlIsBlob(false);
    setVideoUrl(exportVideoUrl(run.run_id));

    try {
      await streamReplayExport(run.run_id, streamHandlers, controller.signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }

  function onReset() {
    abortRef.current?.abort();
    if (flushTimer.current) clearTimeout(flushTimer.current);

    revokeVideoUrl();

    setFile(null);
    setVideoUrl(null);
    setVideoUrlIsBlob(false);
    setDisplayFileName(null);
    setActiveRunId(null);
    resetAnalysisState();
    setStatus({ kind: "idle" });
  }

  const busy = status.kind === "loading";
  const statusKind = status.kind;
  const showOverlay = meta !== null && (busy || status.kind === "ok");
  const showWorkspace = videoUrl !== null;

  return (
    <div>
      <h1>Salamander detector</h1>

      <p>
        Upload a video and analyze, or open a previous run to replay boxes and
        paths instantly without re-running the model.
      </p>

      <PreviousRuns
        disabled={busy}
        activeRunId={activeRunId}
        onOpen={(run) => void onOpenPreviousRun(run)}
        refreshToken={exportsRefresh}
      />

      <div className="controls">
        <input
          type="file"
          accept="video/*"
          onChange={onPickFile}
          disabled={busy}
        />

        <button onClick={onAnalyze} disabled={!file || busy}>
          {busy ? "Working…" : "Analyze"}
        </button>

        {(file || videoUrl) && !busy && (
          <button type="button" onClick={onReset}>
            Reset
          </button>
        )}
      </div>

      {status.kind === "loading" && (
        <div className="progress">
          <progress value={percent} max={100} />
          <span> {percent}%</span>
        </div>
      )}

      <div className={`status ${status.kind === "error" ? "error" : ""}`}>
        {status.kind === "error" && status.message}
        {status.kind === "loading" &&
          "Loading detections… play the video to see boxes and paths."}
        {status.kind === "ok" && "Ready. All frames loaded."}
      </div>

      {showWorkspace && (
        <>
          <hr />

          <div className="workspace">
            <div className="workspace-main">
              {showOverlay ? (
                <VideoOverlay videoUrl={videoUrl} frames={frames} meta={meta} />
              ) : (
                <video src={videoUrl} controls width="720" />
              )}

              {tracks.length > 0 && (
                <table className="meta">
                  <thead>
                    <tr>
                      <th>Track ID</th>
                      <th>Label</th>
                      <th>Frames Seen</th>
                      <th>Time on Screen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tracks.map((track) => (
                      <tr key={track.track_id}>
                        <td>{track.track_id}</td>
                        <td>{track.label}</td>
                        <td>{track.frames_seen}</td>
                        <td>
                          {(Number(track.time_on_screen_s) || 0).toFixed(2)} s
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <StatsPanel
              status={statusKind}
              percent={percent}
              processedFrames={processedFrames}
              meta={meta}
              frames={frames}
              tracks={tracks}
              fileName={displayFileName}
              runId={activeRunId}
              errorMessage={
                status.kind === "error" ? status.message : undefined
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
