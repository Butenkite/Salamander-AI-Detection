export interface DetectionBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number | null;
  cls: number;
  label: string;
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

export interface AnalyzeCallbacks {
  onMeta: (meta: AnalyzeMeta) => void;
  onFrame: (frame: DetectionFrame) => void;
  onDone: (totalFrames: number) => void;
  signal?: AbortSignal;
}

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

/**
 * Stream per-frame detections from POST /analyze.
 */
export async function analyzeVideoStream(
  file: File,
  cb: AnalyzeCallbacks,
): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/analyze`, {
    method: "POST",
    body: form,
    signal: cb.signal,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = `${detail}: ${body.detail}`;
    } catch {
      // ignore
    }
    throw new Error(`Analyze failed (${detail})`);
  }
  if (!res.body) {
    throw new Error("Server did not return a streaming body.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let msg: { type?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        console.warn("Could not parse stream line", line, err);
        continue;
      }

      if (msg.type === "meta") {
        cb.onMeta(msg as unknown as AnalyzeMeta);
      } else if (msg.type === "frame") {
        cb.onFrame(msg as unknown as DetectionFrame);
      } else if (msg.type === "done") {
        total = (msg.total_frames as number) ?? total;
        cb.onDone(total);
      } else if (msg.type === "error") {
        throw new Error(String(msg.message ?? "Server reported an error."));
      }
    }
  }
}
