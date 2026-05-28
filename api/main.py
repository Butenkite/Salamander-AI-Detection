"""FastAPI inference server for salamander video detection.

Accepts a video upload and streams newline-delimited JSON (NDJSON) from
``POST /analyze`` as YOLO tracking runs — one line per event:

    {"type": "meta", "fps": ..., "width": ..., ...}
    {"type": "frame", "frame_idx": 0, "t": 0.0, "boxes": [...], "percent": 1}
    ...
    {"type": "done", "total_frames": N, "tracks": [...]}

The final ``done`` line includes track metrics; boxes are normalized 0–1 for
the React overlay. Pixel coordinates are also written to ``videos/tracks.csv``.

Run from the repo root:

    uvicorn api.main:app --reload --port 8000

Environment variables:
    SALAMANDER_WEIGHTS  Path to the trained weights (default
                        ``runs/detect/run1/weights/best.pt``).
    SALAMANDER_IMGSZ    Inference image size (default ``320`` to match
                        ``scripts/train.py``).
    SALAMANDER_CONF     Confidence threshold (default ``0.25``).
    SALAMANDER_DEVICE   Force a device, e.g. ``cpu`` / ``0`` / ``mps``.
                        Default lets Ultralytics auto-detect.
    SALAMANDER_CORS     Comma-separated allowed origins (default allows
                        ``http://localhost:5173`` and ``http://127.0.0.1:5173``).
"""

from __future__ import annotations

import csv
import json
import logging
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator

import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from ultralytics import YOLO

logger = logging.getLogger("salamander.api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WEIGHTS = REPO_ROOT / "runs" / "detect" / "run1" / "weights" / "best.pt"


def _weights_path() -> Path:
    raw = os.environ.get("SALAMANDER_WEIGHTS")
    return Path(raw).expanduser().resolve() if raw else DEFAULT_WEIGHTS


def _imgsz() -> int:
    try:
        return int(os.environ.get("SALAMANDER_IMGSZ", "320"))
    except ValueError:
        return 320


def _conf() -> float:
    try:
        return float(os.environ.get("SALAMANDER_CONF", "0.25"))
    except ValueError:
        return 0.25


def _device() -> str | None:
    raw = os.environ.get("SALAMANDER_DEVICE")
    return raw if raw else None


def _allowed_origins() -> list[str]:
    raw = os.environ.get("SALAMANDER_CORS")
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


app = FastAPI(title="Salamander video detector", version="0.1.0")
job: dict[str, Any] = {"status": "idle"}
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


_model: YOLO | None = None


def get_model() -> YOLO:
    """Lazy-load the YOLO weights once per process."""
    global _model
    if _model is None:
        weights = _weights_path()
        if not weights.is_file():
            raise RuntimeError(
                f"Weights file not found: {weights}. Train first or set SALAMANDER_WEIGHTS."
            )
        logger.info("Loading YOLO weights from %s", weights)
        _model = YOLO(str(weights))
    return _model


@app.on_event("startup")
def _warmup() -> None:
    try:
        get_model()
    except Exception as exc:
        logger.warning("Model not loaded at startup: %s", exc)


@app.get("/health")
def health() -> dict[str, Any]:
    weights = _weights_path()
    return {
        "ok": True,
        "weights": str(weights),
        "weights_exists": weights.is_file(),
        "imgsz": _imgsz(),
        "conf": _conf(),
        "device": _device(),
    }


def _ndjson_line(obj: dict[str, Any]) -> str:
    return json.dumps(obj, separators=(",", ":")) + "\n"


def _track_video_events(
    tmp_path: Path,
    fps: float,
    width: int,
    height: int,
    frame_count: int,
    class_names: dict[str, str],
) -> Iterator[dict[str, Any]]:
    """Run YOLO tracking and yield meta / frame / done events."""
    duration_sec = frame_count / fps if fps > 0 else 0.0

    yield {
        "type": "meta",
        "fps": fps,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "duration_sec": round(duration_sec, 2),
        "class_names": class_names,
    }

    model = get_model()
    frames_seen: defaultdict[int, int] = defaultdict(int)
    label_for: dict[int, str] = {}

    csv_path = REPO_ROOT / "videos" / "tracks.csv"
    csv_path.parent.mkdir(exist_ok=True)

    with open(csv_path, "w", newline="") as csv_file:
        csv_writer = csv.writer(csv_file)
        csv_writer.writerow([
            "frame_idx",
            "time_seconds",
            "track_id",
            "label",
            "x1",
            "y1",
            "x2",
            "y2",
            "confidence",
        ])

        results_iter = model.track(
            source=str(tmp_path),
            stream=True,
            persist=True,
            imgsz=_imgsz(),
            conf=_conf(),
            device=_device(),
            verbose=False,
        )

        frame_idx = -1
        for frame_idx, result in enumerate(results_iter):
            t_sec = frame_idx / fps if fps > 0 else 0.0
            frame_boxes: list[dict[str, Any]] = []

            boxes = getattr(result, "boxes", None)

            if boxes is not None and len(boxes) > 0:
                xyxy = boxes.xyxy.cpu().numpy()
                confs = boxes.conf.cpu().numpy() if boxes.conf is not None else None
                clss = boxes.cls.cpu().numpy().astype(int) if boxes.cls is not None else None
                ids = boxes.id.cpu().numpy().astype(int) if boxes.id is not None else None

                for i in range(len(xyxy)):
                    x1, y1, x2, y2 = xyxy[i].tolist()

                    cls_id = int(clss[i]) if clss is not None else -1
                    track_id = int(ids[i]) if ids is not None else None
                    label = class_names.get(str(cls_id), str(cls_id))
                    conf_val = float(confs[i]) if confs is not None else None

                    if track_id is not None:
                        frames_seen[track_id] += 1
                        label_for[track_id] = label

                    csv_writer.writerow([
                        frame_idx,
                        round(t_sec, 2),
                        track_id,
                        label,
                        round(float(x1), 2),
                        round(float(y1), 2),
                        round(float(x2), 2),
                        round(float(y2), 2),
                        round(conf_val, 4) if conf_val is not None else None,
                    ])

                    frame_boxes.append({
                        "x1": round(float(x1) / width, 6),
                        "y1": round(float(y1) / height, 6),
                        "x2": round(float(x2) / width, 6),
                        "y2": round(float(y2) / height, 6),
                        "conf": round(conf_val, 4) if conf_val is not None else None,
                        "cls": cls_id,
                        "label": label,
                        "track_id": track_id,
                    })

            percent = (
                int(((frame_idx + 1) / frame_count) * 100)
                if frame_count > 0
                else 0
            )
            job["percent"] = percent

            yield {
                "type": "frame",
                "frame_idx": frame_idx,
                "t": round(t_sec, 4),
                "boxes": frame_boxes,
                "percent": percent,
            }

    tracks = [
        {
            "track_id": tid,
            "label": label_for[tid],
            "frames_seen": count,
            "time_on_screen_s": round(count / fps, 2),
        }
        for tid, count in frames_seen.items()
    ]

    yield {
        "type": "done",
        "total_frames": max(0, frame_idx + 1),
        "tracks": tracks,
    }


@app.get("/analyze")
def get_analyze_status() -> dict[str, Any]:
    return job


def _probe_video(path: Path) -> tuple[float, int, int, int]:
    """Return (fps, width, height, frame_count) using OpenCV."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail="Could not open uploaded video.")
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    finally:
        cap.release()
    if fps <= 0 or width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Invalid video metadata (fps/size).")
    return fps, width, height, frame_count


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)) -> StreamingResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")

    suffix = Path(file.filename).suffix or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path = Path(tmp.name)
    try:
        try:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)
        finally:
            tmp.close()

        fps, width, height, frame_count = _probe_video(tmp_path)
        duration_sec = frame_count / fps if fps > 0 else 0.0
        logger.info(
            "Analyzing %s (%dx%d, %.2f fps, %d frames, %.2fs)",
            tmp_path.name, width, height, fps, frame_count, duration_sec,
        )

        model = get_model()
        class_names_raw = getattr(model, "names", None) or {}
        class_names: dict[str, str] = (
            {str(k): str(v) for k, v in class_names_raw.items()}
            if isinstance(class_names_raw, dict)
            else {}
        )
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    def stream_body() -> Iterator[bytes]:
        job.clear()
        job["status"] = "processing"
        job["percent"] = 0
        try:
            for event in _track_video_events(
                tmp_path, fps, width, height, frame_count, class_names
            ):
                yield _ndjson_line(event).encode("utf-8")
            job.clear()
            job["status"] = "done"
            job["percent"] = 100
        except Exception as exc:
            logger.exception("Analyze failed")
            job.clear()
            job["status"] = "error"
            job["message"] = str(exc)
            yield _ndjson_line({"type": "error", "message": str(exc)}).encode("utf-8")
        finally:
            tmp_path.unlink(missing_ok=True)

    return StreamingResponse(
        stream_body(),
        media_type="application/x-ndjson",
    )
