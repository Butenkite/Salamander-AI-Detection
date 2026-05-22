export interface TrackMetric {
  track_id: number;
  label: string;
  frames_seen: number;
  time_on_screen_s: number;
}

export interface AnalyzeJobStatus {
  status: "idle" | "processing" | "done" | "error";
  percent?: number;
  message?: string;
  result?: {
    tracks: TrackMetric[];
  };
}

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:8000";

export async function startAnalyzeJob(file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${API_URL}/analyze`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Analyze failed: ${res.status} ${res.statusText}`);
  }
}

export async function getAnalyzeStatus(): Promise<AnalyzeJobStatus> {
  const res = await fetch(`${API_URL}/analyze`);

  if (!res.ok) {
    throw new Error(`Status check failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}