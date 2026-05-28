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
  export_id?: string;
}

export interface TrackMetric {
  track_id: number;
  label: string;
  frames_seen: number;
  time_on_screen_s: number;
}

export interface ExportSummary {
  run_id: string;
  source_video: string;
  analyzed_at: string;
  frame_count: number;
  duration_sec: number;
  track_count: number;
  has_video: boolean;
}

export interface StreamAnalyzeHandlers {
  onMeta: (meta: AnalyzeMeta) => void;
  onFrame: (frame: DetectionFrame) => void;
  onProgress: (percent: number) => void;
  onDone: (tracks: TrackMetric[], exportId?: string) => void;
}

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:8000";

export function exportVideoUrl(runId: string): string {
  return `${API_URL}/exports/${encodeURIComponent(runId)}/video`;
}

export function exportReplayUrl(runId: string): string {
  return `${API_URL}/exports/${encodeURIComponent(runId)}/replay`;
}

export async function listExports(): Promise<ExportSummary[]> {
  const res = await fetch(`${API_URL}/exports`);
  if (!res.ok) {
    throw new Error(`Failed to list exports: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { runs: ExportSummary[] };
  return data.runs ?? [];
}

async function consumeNdjsonStream(
  res: Response,
  handlers: StreamAnalyzeHandlers,
): Promise<void> {
  const body = res.body;
  if (!body) {
    throw new Error("Response has no body.");
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
        export_id?: string;
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
            export_id: msg.export_id,
          });
          break;
        case "frame":
          handlers.onFrame({
            frame_idx: msg.frame_idx,
            t: msg.t,
            boxes: (msg.boxes ?? []).map((box) => ({
              ...box,
              track_id: box.track_id ?? null,
            })),
          });
          if (typeof msg.percent === "number") {
            handlers.onProgress(msg.percent);
          }
          break;
        case "done":
          handlers.onDone(msg.tracks ?? [], msg.export_id);
          break;
        case "error":
          throw new Error(msg.message ?? "Request failed.");
        default:
          break;
      }
    }
  }
}

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

  await consumeNdjsonStream(res, handlers);
}

export async function streamReplayExport(
  runId: string,
  handlers: StreamAnalyzeHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(exportReplayUrl(runId), { signal });

  if (!res.ok) {
    throw new Error(`Replay failed: ${res.status} ${res.statusText}`);
  }

  await consumeNdjsonStream(res, handlers);
}
