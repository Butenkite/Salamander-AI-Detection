import { useEffect, useRef, useState } from "react";
import {
  streamAnalyzeVideo,
  type AnalyzeMeta,
  type DetectionFrame,
  type TrackMetric,
} from "./api";
import { VideoOverlay } from "./VideoOverlay";
import { StatsPanel } from "./StatsPanel";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

/** Batch frame appends so React is not re-rendered on every single frame. */
const FRAME_BATCH = 8;

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackMetric[]>([]);
  const [frames, setFrames] = useState<DetectionFrame[]>([]);
  const [meta, setMeta] = useState<AnalyzeMeta | null>(null);
  const [percent, setPercent] = useState(0);
  const [processedFrames, setProcessedFrames] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const pendingFrames = useRef<DetectionFrame[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      abortRef.current?.abort();
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, [videoUrl]);

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
    if (pendingFrames.current.length >= FRAME_BATCH) {
      flushPendingFrames();
    } else {
      scheduleFlush();
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;

    abortRef.current?.abort();
    if (flushTimer.current) clearTimeout(flushTimer.current);

    if (videoUrl) URL.revokeObjectURL(videoUrl);

    setFile(f);
    setTracks([]);
    setFrames([]);
    setMeta(null);
    setPercent(0);
    setProcessedFrames(0);
    pendingFrames.current = [];
    setStatus({ kind: "idle" });
    setVideoUrl(f ? URL.createObjectURL(f) : null);
  }

  async function onAnalyze() {
    if (!file) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setTracks([]);
    setFrames([]);
    setMeta(null);
    setPercent(0);
    setProcessedFrames(0);
    pendingFrames.current = [];
    setStatus({ kind: "loading" });

    try {
      await streamAnalyzeVideo(
        file,
        {
          onMeta: (m) => setMeta(m),
          onFrame: (frame) => {
            setProcessedFrames(frame.frame_idx + 1);
            queueFrame(frame);
          },
          onProgress: (p) => setPercent(p),
          onDone: (t) => {
            flushPendingFrames();
            setTracks(t);
            setPercent(100);
            setStatus({ kind: "ok" });
          },
        },
        controller.signal,
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }

  function onReset() {
    abortRef.current?.abort();
    if (flushTimer.current) clearTimeout(flushTimer.current);

    if (videoUrl) URL.revokeObjectURL(videoUrl);

    setFile(null);
    setVideoUrl(null);
    setTracks([]);
    setFrames([]);
    setMeta(null);
    setPercent(0);
    setProcessedFrames(0);
    pendingFrames.current = [];
    setStatus({ kind: "idle" });
  }

  const busy = status.kind === "loading";
  const statusKind = status.kind;
  const showOverlay = meta !== null && (busy || status.kind === "ok");

  return (
    <div>
      <h1>Salamander detector</h1>

      <p>
        Upload a video and click Analyze. Bounding boxes and colored movement
        paths appear live as each frame is processed — play the video while
        analysis runs or after it finishes. Track metrics appear when done.
      </p>

      <div className="controls">
        <input
          type="file"
          accept="video/*"
          onChange={onPickFile}
          disabled={busy}
        />

        <button onClick={onAnalyze} disabled={!file || busy}>
          {busy ? "Analyzing…" : "Analyze"}
        </button>

        {(file || tracks.length > 0) && !busy && (
          <button onClick={onReset}>Reset</button>
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
          "Processing… play the video to see boxes and travel paths for frames analyzed so far."}
        {status.kind === "ok" && "Done. All frames analyzed."}
      </div>

      {videoUrl && (
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
                    <td>{track.time_on_screen_s.toFixed(2)} s</td>
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
              fileName={file?.name ?? null}
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
