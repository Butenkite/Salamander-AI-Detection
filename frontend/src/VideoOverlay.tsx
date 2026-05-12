import { useEffect, useRef } from "react";
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

/** Binary-search the frame whose `t` is nearest to the playback time. */
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

function readCssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export function VideoOverlay({ videoUrl, frames, meta }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framesRef = useRef<DetectionFrame[]>(frames);
  const rafRef = useRef<number | null>(null);

  framesRef.current = frames;

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

      const list = framesRef.current;
      const frame = findNearestFrame(list, t);
      const fps = meta?.fps ?? 0;
      const tolerance = fps > 0 ? 1 / fps : Number.POSITIVE_INFINITY;
      if (frame && Math.abs(frame.t - t) <= tolerance && frame.boxes.length > 0) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.fillStyle = fill;
        ctx.font = "12px system-ui, sans-serif";
        ctx.textBaseline = "top";

        for (const box of frame.boxes) {
          const x = rect.offsetX + box.x1 * rect.width;
          const y = rect.offsetY + box.y1 * rect.height;
          const w = (box.x2 - box.x1) * rect.width;
          const h = (box.y2 - box.y1) * rect.height;

          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);

          const label =
            box.conf != null
              ? `${box.label} ${(box.conf * 100).toFixed(0)}%`
              : box.label;
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
