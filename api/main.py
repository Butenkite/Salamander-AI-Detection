"""FastAPI inference server for salamander video detection.

Accepts a video upload, runs YOLO (Ultralytics) frame-by-frame, and streams
each frame's detections back as newline-delimited JSON so a React frontend
can show progress as the analysis runs.

Run from the repo root:

    uvicorn api.main:app --reload --port 8000

The response from ``POST /analyze`` is ``application/x-ndjson``. Each line is
one JSON object with a ``type`` field:

    {"type": "meta",  "fps": ..., "width": ..., "height": ..., "frame_count": ..., "duration_sec": ..., "class_names": {...}}
    {"type": "frame", "frame_idx": 0, "t": 0.0, "boxes": [{"x1":...,"y1":...,"x2":...,"y2":...,"conf":...,"cls":...,"label":...}, ...]}
    {"type": "frame", "frame_idx": 1, ...}
    ...
    {"type": "done",  "total_frames": N}

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


def _ndjson(obj: dict[str, Any]) -> bytes:
    return (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")


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

    def stream() -> Iterator[bytes]:
        emitted = 0
        csv_path = REPO_ROOT / "videos" / "tracks.csv"
        csv_path.parent.mkdir(exist_ok=True)

        csv_file = open(csv_path, "w", newline="")
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
            "confidence"
        ])
        try:
            yield _ndjson(
                {
                    "type": "meta",
                    "fps": fps,
                    "width": width,
                    "height": height,
                    "frame_count": frame_count,
                    "duration_sec": duration_sec,
                    "class_names": class_names,
                }
            )

            results_iter = model.track(
                source=str(tmp_path),
                stream=True,
                persist=True,
                imgsz=_imgsz(),
                conf=_conf(),
                device=_device(),
                verbose=False,
            )

            for frame_idx, result in enumerate(results_iter):
                t_sec = frame_idx / fps if fps > 0 else 0.0
                boxes_out: list[dict[str, Any]] = []
                boxes = getattr(result, "boxes", None)
                if boxes is not None and len(boxes) > 0:
                    xyxy = boxes.xyxy.cpu().numpy()
                    confs = boxes.conf.cpu().numpy() if boxes.conf is not None else None
                    clss = boxes.cls.cpu().numpy().astype(int) if boxes.cls is not None else None
                    ids = boxes.id.cpu().numpy().astype(int) if boxes.id is not None else None
                    for i in range(len(xyxy)):
                        x1, y1, x2, y2 = xyxy[i].tolist()
                        print("Frame:", frame_idx)
                        print("Top-left:", x1, y1)
                        print("Bottom-right:", x2, y2)
                        cls_id = int(clss[i]) if clss is not None else -1
                        track_id = int(ids[i]) if ids is not None else None
                        csv_writer.writerow([
                        frame_idx,
                        round(t_sec, 2),
                        track_id,
                        class_names.get(str(cls_id), str(cls_id)),
                        round(float(x1), 2),
                        round(float(y1), 2),
                        round(float(x2), 2),
                        round(float(y2), 2),
                        round(float(confs[i]), 4) if confs is not None else None
                    ])
                        boxes_out.append(
                            {
                                "track_id": track_id,
                                "x1": float(x1) / width,
                                "y1": float(y1) / height,
                                "x2": float(x2) / width,
                                "y2": float(y2) / height,
                                "conf": float(confs[i]) if confs is not None else None,
                                "cls": cls_id,
                                "label": class_names.get(str(cls_id), str(cls_id)),
                            }
                        )
                yield _ndjson(
                    {
                        "type": "frame",
                        "frame_idx": frame_idx,
                        "t": t_sec,
                        "boxes": boxes_out,
                    }
                )
                emitted += 1

            yield _ndjson({"type": "done", "total_frames": emitted})
        except Exception as exc:
            logger.exception("Error during streaming inference")
            try:
                yield _ndjson({"type": "error", "message": str(exc)})
            except Exception:
                pass
        finally:
            csv_file.close()
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not delete temp file %s", tmp_path)

    return StreamingResponse(stream(), media_type="application/x-ndjson")
    
