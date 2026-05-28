export interface DetectionBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number | null;
  cls: number;
  label: string;
  track_id: number | null;
}

export interface DetectionFrame {
  frame_idx: number;
  t: number;
  boxes: DetectionBox[];
}

export interface AnalyzeMeta {
  fps: number;
  width: number;
  height: number;
  frame_count: number;
  duration_sec: number;
  class_names: Record<string, string>;
}

export interface TrackMetric {
  track_id: number;
  label: string;
  frames_seen: number;
  time_on_screen_s: number;
}

export interface StreamAnalyzeHandlers {
  onMeta: (meta: AnalyzeMeta) => void;
  onFrame: (frame: DetectionFrame) => void;
  onProgress: (percent: number) => void;
  onDone: (tracks: TrackMetric[]) => void;
}

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:8000";

/** Stream NDJSON from POST /analyze; boxes arrive frame-by-frame as inference runs. */
export async function streamAnalyzeVideo(
  file: File,
  handlers: StreamAnalyzeHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${API_URL}/analyze`, {
    method: "POST",
    body: form,
    signal,
  });

  if (!res.ok) {
    throw new Error(`Analyze failed: ${res.status} ${res.statusText}`);
  }

  const body = res.body;
  if (!body) {
    throw new Error("Analyze response has no body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const msg = JSON.parse(trimmed) as {
        type: string;
        message?: string;
        percent?: number;
        tracks?: TrackMetric[];
      } & AnalyzeMeta &
        DetectionFrame;

      switch (msg.type) {
        case "meta":
          handlers.onMeta({
            fps: msg.fps,
            width: msg.width,
            height: msg.height,
            frame_count: msg.frame_count,
            duration_sec: msg.duration_sec,
            class_names: msg.class_names,
          });
          break;
        case "frame":
          handlers.onFrame({
            frame_idx: msg.frame_idx,
            t: msg.t,
            boxes: msg.boxes,
          });
          if (typeof msg.percent === "number") {
            handlers.onProgress(msg.percent);
          }
          break;
        case "done":
          handlers.onDone(msg.tracks ?? []);
          break;
        case "error":
          throw new Error(msg.message ?? "Analysis failed.");
        default:
          break;
      }
    }
  }
}
