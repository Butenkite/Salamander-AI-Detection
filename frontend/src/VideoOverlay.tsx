import { useEffect, useMemo, useRef } from "react";
import type { AnalyzeMeta, DetectionFrame } from "./api";

interface Props {
  videoUrl: string;
  frames: DetectionFrame[];
  meta: AnalyzeMeta | null;
}

interface ContentRect {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface PathPoint {
  t: number;
  cx: number;
  cy: number;
}

/** Centroid trail per track_id (same data as CSV rows, normalized coords). */
type TrackPaths = Map<number, PathPoint[]>;

const PATH_COLORS = [
  "#e6a700",
  "#2a7a3a",
  "#2563eb",
  "#c026d3",
  "#dc2626",
  "#0891b2",
];

function getContentRect(video: HTMLVideoElement): ContentRect {
  const elementW = video.clientWidth;
  const elementH = video.clientHeight;
  const intrinsicW = video.videoWidth || elementW;
  const intrinsicH = video.videoHeight || elementH;

  if (intrinsicW <= 0 || intrinsicH <= 0 || elementW <= 0 || elementH <= 0) {
    return { offsetX: 0, offsetY: 0, width: elementW, height: elementH };
  }

  const videoRatio = intrinsicW / intrinsicH;
  const elementRatio = elementW / elementH;

  if (videoRatio > elementRatio) {
    const width = elementW;
    const height = elementW / videoRatio;
    return { offsetX: 0, offsetY: (elementH - height) / 2, width, height };
  } else {
    const height = elementH;
    const width = elementH * videoRatio;
    return { offsetX: (elementW - width) / 2, offsetY: 0, width, height };
  }
}

function findNearestFrame(
  frames: DetectionFrame[],
  t: number,
): DetectionFrame | null {
  if (frames.length === 0) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const candidate = frames[lo];
  if (lo > 0) {
    const prev = frames[lo - 1];
    if (Math.abs(prev.t - t) < Math.abs(candidate.t - t)) return prev;
  }
  return candidate;
}

function buildTrackPaths(frames: DetectionFrame[]): TrackPaths {
  const paths: TrackPaths = new Map();

  for (const frame of frames) {
    for (const box of frame.boxes ?? []) {
      if (box.track_id == null) continue;

      const cx = (box.x1 + box.x2) / 2;
      const cy = (box.y1 + box.y2) / 2;
      const list = paths.get(box.track_id) ?? [];
      list.push({ t: frame.t, cx, cy });
      paths.set(box.track_id, list);
    }
  }

  return paths;
}

function readCssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function toScreen(
  rect: ContentRect,
  cx: number,
  cy: number,
): [number, number] {
  return [rect.offsetX + cx * rect.width, rect.offsetY + cy * rect.height];
}

function drawTrackPaths(
  ctx: CanvasRenderingContext2D,
  paths: TrackPaths,
  rect: ContentRect,
  currentTime: number,
) {
  for (const [trackId, points] of paths) {
    const visible = points.filter((p) => p.t <= currentTime + 1e-6);
    if (visible.length === 0) continue;

    const color = PATH_COLORS[trackId % PATH_COLORS.length];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (visible.length === 1) {
      const [x, y] = toScreen(rect, visible[0].cx, visible[0].cy);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    ctx.beginPath();
    const [x0, y0] = toScreen(rect, visible[0].cx, visible[0].cy);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < visible.length; i++) {
      const [x, y] = toScreen(rect, visible[i].cx, visible[i].cy);
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    const last = visible[visible.length - 1];
    const [lx, ly] = toScreen(rect, last.cx, last.cy);
    ctx.beginPath();
    ctx.arc(lx, ly, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function VideoOverlay({ videoUrl, frames, meta }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framesRef = useRef<DetectionFrame[]>(frames);
  const pathsRef = useRef<TrackPaths>(new Map());
  const rafRef = useRef<number | null>(null);

  const trackPaths = useMemo(() => buildTrackPaths(frames), [frames]);
  framesRef.current = frames;
  pathsRef.current = trackPaths;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const stroke = readCssColor("--color-accent", "#2a7a3a");
    const fill = readCssColor("--color-accent-fill", "rgba(42,122,58,0.18)");

    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = video.clientWidth;
      const h = video.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      const t = video.currentTime;
      const rect = getContentRect(video);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      drawTrackPaths(ctx, pathsRef.current, rect, t);

      const list = framesRef.current;
      const frame = findNearestFrame(list, t);
      const fps = meta?.fps ?? 0;
      const tolerance = fps > 0 ? 1 / fps : Number.POSITIVE_INFINITY;
      const boxes = frame?.boxes ?? [];
      if (frame && Math.abs(frame.t - t) <= tolerance && boxes.length > 0) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.fillStyle = fill;
        ctx.font = "12px system-ui, sans-serif";
        ctx.textBaseline = "top";

        for (const box of boxes) {
          const x = rect.offsetX + box.x1 * rect.width;
          const y = rect.offsetY + box.y1 * rect.height;
          const w = (box.x2 - box.x1) * rect.width;
          const h = (box.y2 - box.y1) * rect.height;

          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);

          const trackTag =
            box.track_id != null ? ` #${box.track_id}` : "";
          const label =
            box.conf != null
              ? `${box.label}${trackTag} ${(box.conf * 100).toFixed(0)}%`
              : `${box.label}${trackTag}`;
          const padding = 3;
          const textWidth = ctx.measureText(label).width;
          const textH = 14;
          const tagY = y - textH >= 0 ? y - textH : y;

          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fillRect(x, tagY, textWidth + padding * 2, textH);

          ctx.fillStyle = stroke;
          ctx.fillText(label, x + padding, tagY + 1);

          ctx.fillStyle = fill;
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    const handleLoaded = () => resizeCanvas();
    const observer = new ResizeObserver(() => resizeCanvas());

    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("resize", handleLoaded);
    observer.observe(video);

    resizeCanvas();
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("resize", handleLoaded);
      observer.disconnect();
    };
  }, [videoUrl, meta]);

  return (
    <div className="player-wrap">
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        playsInline
        preload="metadata"
      />
      <canvas ref={canvasRef} />
    </div>
  );
}
