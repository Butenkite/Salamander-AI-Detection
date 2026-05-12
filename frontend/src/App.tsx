import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeVideoStream,
  type AnalyzeMeta,
  type DetectionFrame,
} from "./api";
import { VideoOverlay } from "./VideoOverlay";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; total: number }
  | { kind: "error"; message: string };

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<AnalyzeMeta | null>(null);
  const [frames, setFrames] = useState<DetectionFrame[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      abortRef.current?.abort();
    };
  }, [videoUrl]);

  const totalDetections = useMemo(
    () => frames.reduce((sum, f) => sum + f.boxes.length, 0),
    [frames],
  );

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    abortRef.current?.abort();
    const f = e.target.files?.[0] ?? null;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(f);
    setMeta(null);
    setFrames([]);
    setStatus({ kind: "idle" });
    setVideoUrl(f ? URL.createObjectURL(f) : null);
  }

  async function onAnalyze() {
    if (!file) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setMeta(null);
    setFrames([]);
    setStatus({ kind: "loading" });

    try {
      await analyzeVideoStream(file, {
        signal: controller.signal,
        onMeta: (m) => setMeta(m),
        onFrame: (f) => setFrames((prev) => [...prev, f]),
        onDone: (total) => setStatus({ kind: "ok", total }),
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }

  function onCancel() {
    abortRef.current?.abort();
    setStatus({ kind: "idle" });
  }

  function onReset() {
    abortRef.current?.abort();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setFile(null);
    setVideoUrl(null);
    setMeta(null);
    setFrames([]);
    setStatus({ kind: "idle" });
  }

  const busy = status.kind === "loading";
  const progressLabel =
    meta && frames.length < meta.frame_count
      ? `Analyzed ${frames.length} / ${meta.frame_count} frames`
      : meta
        ? `Analyzed ${frames.length} frames`
        : busy
          ? "Waiting for first frame…"
          : null;

  return (
    <div>
      <h1>Salamander detector</h1>
      <p>
        Upload a video, run the trained model, and watch bounding boxes
        appear as each frame is processed.
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
        {busy && <button onClick={onCancel}>Cancel</button>}
        {(file || frames.length > 0 || meta) && !busy && (
          <button onClick={onReset}>Reset</button>
        )}
      </div>

      <div className={`status ${status.kind === "error" ? "error" : ""}`}>
        {status.kind === "error" && status.message}
        {status.kind === "ok" &&
          `Done. ${status.total} frames analyzed, ${totalDetections} detections total.`}
      </div>

      {progressLabel && <div className="progress">{progressLabel}</div>}

      {videoUrl && (
        <>
          <hr />
          <VideoOverlay videoUrl={videoUrl} frames={frames} meta={meta} />

          {meta && (
            <table className="meta">
              <tbody>
                <tr>
                  <th>FPS</th>
                  <td>{meta.fps.toFixed(2)}</td>
                </tr>
                <tr>
                  <th>Duration</th>
                  <td>{meta.duration_sec.toFixed(2)} s</td>
                </tr>
                <tr>
                  <th>Source size</th>
                  <td>
                    {meta.width} x {meta.height}
                  </td>
                </tr>
                <tr>
                  <th>Frames received</th>
                  <td>
                    {frames.length}
                    {meta.frame_count > 0 ? ` / ${meta.frame_count}` : ""}
                  </td>
                </tr>
                <tr>
                  <th>Detections so far</th>
                  <td>{totalDetections}</td>
                </tr>
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
