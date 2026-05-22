import { useEffect, useState } from "react";
import {
  startAnalyzeJob,
  getAnalyzeStatus,
  type TrackMetric,
} from "./api";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackMetric[]>([]);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;

    if (videoUrl) URL.revokeObjectURL(videoUrl);

    setFile(f);
    setTracks([]);
    setPercent(0);
    setStatus({ kind: "idle" });
    setVideoUrl(f ? URL.createObjectURL(f) : null);
  }

  async function onAnalyze() {
    if (!file) return;

    setTracks([]);
    setPercent(0);
    setStatus({ kind: "loading" });

    try {
      await startAnalyzeJob(file);

      while (true) {
        const job = await getAnalyzeStatus();

        setPercent(job.percent ?? 0);

        if (job.status === "done") {
          setTracks(job.result?.tracks ?? []);
          setPercent(100);
          setStatus({ kind: "ok" });
          break;
        }

        if (job.status === "error") {
          throw new Error(job.message ?? "Analysis failed.");
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }

  function onReset() {
    if (videoUrl) URL.revokeObjectURL(videoUrl);

    setFile(null);
    setVideoUrl(null);
    setTracks([]);
    setPercent(0);
    setStatus({ kind: "idle" });
  }

  const busy = status.kind === "loading";

  return (
    <div>
      <h1>Salamander detector</h1>

      <p>
        Upload a video, run the trained model, and watch progress while the
        salamander metrics are calculated.
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
        {status.kind === "ok" && "Done. Analysis complete."}
      </div>

      {videoUrl && (
        <>
          <hr />

          <video src={videoUrl} controls width="720" />

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
        </>
      )}
    </div>
  );
}