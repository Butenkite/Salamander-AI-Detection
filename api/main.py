"""FastAPI inference server for salamander video detection.

Accepts a video upload and streams newline-delimited JSON (NDJSON) from
``POST /analyze`` as YOLO tracking runs. Completed runs are saved under
``videos/exports/<run_id>/`` (video, tracks.csv, meta.json) and can be reopened
via ``GET /exports`` and ``GET /exports/{run_id}/replay``.

Run from the repo root:

    uvicorn api.main:app --reload --port 8000
"""

from __future__ import annotations

import csv
import json
import logging
import os
import re
import shutil
import tempfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from ultralytics import YOLO

logger = logging.getLogger("salamander.api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WEIGHTS = REPO_ROOT / "runs" / "detect" / "run1" / "weights" / "best.pt"
EXPORTS_DIR = REPO_ROOT / "videos" / "exports"
LATEST_CSV = REPO_ROOT / "videos" / "tracks.csv"


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
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
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


def _safe_run_id(run_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", run_id):
        raise HTTPException(status_code=400, detail="Invalid run id.")
    return run_id


def _export_dir(run_id: str) -> Path:
    _safe_run_id(run_id)
    path = (EXPORTS_DIR / run_id).resolve()
    try:
        path.relative_to(EXPORTS_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Export not found.") from exc
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Export not found.")
    return path


def _create_export_dir(source_filename: str) -> tuple[str, Path]:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = re.sub(r"[^\w\-]+", "_", Path(source_filename).stem).strip("_")[:40] or "video"
    run_id = f"{stamp}_{slug}"
    export_dir = EXPORTS_DIR / run_id
    export_dir.mkdir(parents=True, exist_ok=False)
    return run_id, export_dir


def _write_export_meta(
    export_dir: Path,
    run_id: str,
    source_video: str,
    video_file: str,
    fps: float,
    width: int,
    height: int,
    frame_count: int,
    class_names: dict[str, str],
    tracks: list[dict[str, Any]],
) -> None:
    duration_sec = frame_count / fps if fps > 0 else 0.0
    meta = {
        "run_id": run_id,
        "source_video": source_video,
        "video_file": video_file,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "fps": fps,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "duration_sec": round(duration_sec, 2),
        "class_names": class_names,
        "tracks": tracks,
    }
    (export_dir / "meta.json").write_text(
        json.dumps(meta, indent=2),
        encoding="utf-8",
    )


def _find_export_video(export_dir: Path) -> Path | None:
    meta_path = export_dir / "meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        video_name = meta.get("video_file")
        if video_name:
            candidate = export_dir / video_name
            if candidate.is_file():
                return candidate
    for pattern in ("source.*", "video.*"):
        matches = sorted(export_dir.glob(pattern))
        if matches:
            return matches[0]
    return None


def _track_video_events(
    tmp_path: Path,
    fps: float,
    width: int,
    height: int,
    frame_count: int,
    class_names: dict[str, str],
    export_dir: Path,
    run_id: str,
) -> Iterator[dict[str, Any]]:
    duration_sec = frame_count / fps if fps > 0 else 0.0

    yield {
        "type": "meta",
        "fps": fps,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "duration_sec": round(duration_sec, 2),
        "class_names": class_names,
        "export_id": run_id,
    }

    model = get_model()
    frames_seen: defaultdict[int, int] = defaultdict(int)
    label_for: dict[int, str] = {}

    csv_path = export_dir / "tracks.csv"
    LATEST_CSV.parent.mkdir(parents=True, exist_ok=True)

    with open(csv_path, "w", newline="", encoding="utf-8") as csv_file:
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

    shutil.copy2(csv_path, LATEST_CSV)

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
        "export_id": run_id,
    }


def _replay_export_events(export_dir: Path) -> Iterator[dict[str, Any]]:
    meta_path = export_dir / "meta.json"
    csv_path = export_dir / "tracks.csv"
    if not meta_path.is_file() or not csv_path.is_file():
        raise HTTPException(status_code=404, detail="Export missing meta or tracks.csv.")

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    fps = float(meta["fps"])
    width = int(meta["width"])
    height = int(meta["height"])
    frame_count = int(meta["frame_count"])
    class_names = meta.get("class_names") or {}
    run_id = meta.get("run_id", export_dir.name)

    yield {
        "type": "meta",
        "fps": fps,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "duration_sec": meta.get("duration_sec", round(frame_count / fps, 2) if fps else 0),
        "class_names": class_names,
        "export_id": run_id,
    }

    by_frame: dict[int, list[dict[str, Any]]] = defaultdict(list)

    with open(csv_path, newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            frame_idx = int(row["frame_idx"])
            track_raw = row.get("track_id", "")
            track_id = int(track_raw) if track_raw not in ("", "None") else None
            label = row.get("label", "")
            conf_raw = row.get("confidence", "")
            conf_val = float(conf_raw) if conf_raw not in ("", "None") else None
            x1 = float(row["x1"])
            y1 = float(row["y1"])
            x2 = float(row["x2"])
            y2 = float(row["y2"])

            by_frame[frame_idx].append({
                "x1": round(x1 / width, 6),
                "y1": round(y1 / height, 6),
                "x2": round(x2 / width, 6),
                "y2": round(y2 / height, 6),
                "conf": round(conf_val, 4) if conf_val is not None else None,
                "cls": -1,
                "label": label,
                "track_id": track_id,
            })

    for frame_idx in range(frame_count):
        t_sec = frame_idx / fps if fps > 0 else 0.0
        percent = int(((frame_idx + 1) / frame_count) * 100) if frame_count > 0 else 100
        yield {
            "type": "frame",
            "frame_idx": frame_idx,
            "t": round(t_sec, 4),
            "boxes": by_frame.get(frame_idx, []),
            "percent": percent,
        }

    tracks = meta.get("tracks")
    if not tracks:
        frames_seen: defaultdict[int, int] = defaultdict(int)
        label_for: dict[int, str] = {}
        for frame_idx, boxes in by_frame.items():
            for box in boxes:
                tid = box.get("track_id")
                if tid is not None:
                    frames_seen[tid] += 1
                    label_for[tid] = box["label"]
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
        "total_frames": frame_count,
        "tracks": tracks,
        "export_id": run_id,
    }


@app.get("/analyze")
def get_analyze_status() -> dict[str, Any]:
    return job


@app.get("/exports")
def list_exports() -> dict[str, Any]:
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    runs: list[dict[str, Any]] = []

    for export_dir in sorted(EXPORTS_DIR.iterdir(), reverse=True):
        if not export_dir.is_dir():
            continue
        meta_path = export_dir / "meta.json"
        if not meta_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue

        runs.append({
            "run_id": meta.get("run_id", export_dir.name),
            "source_video": meta.get("source_video", ""),
            "analyzed_at": meta.get("analyzed_at", ""),
            "frame_count": meta.get("frame_count", 0),
            "duration_sec": meta.get("duration_sec", 0),
            "track_count": len(meta.get("tracks") or []),
            "has_video": _find_export_video(export_dir) is not None,
        })

    return {"runs": runs}


@app.get("/exports/{run_id}/video")
def export_video(run_id: str) -> FileResponse:
    export_dir = _export_dir(run_id)
    video_path = _find_export_video(export_dir)
    if video_path is None:
        raise HTTPException(status_code=404, detail="Video not found for this export.")
    return FileResponse(
        path=video_path,
        media_type="video/mp4",
        filename=video_path.name,
    )


@app.get("/exports/{run_id}/replay")
def replay_export(run_id: str) -> StreamingResponse:
    export_dir = _export_dir(run_id)

    def stream_body() -> Iterator[bytes]:
        try:
            for event in _replay_export_events(export_dir):
                yield _ndjson_line(event).encode("utf-8")
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Replay failed for %s", run_id)
            yield _ndjson_line({"type": "error", "message": str(exc)}).encode("utf-8")

    return StreamingResponse(stream_body(), media_type="application/x-ndjson")


def _probe_video(path: Path) -> tuple[float, int, int, int]:
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
    source_video = file.filename

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
        logger.info(
            "Analyzing %s (%dx%d, %.2f fps, %d frames)",
            source_video, width, height, fps, frame_count,
        )

        model = get_model()
        class_names_raw = getattr(model, "names", None) or {}
        class_names: dict[str, str] = (
            {str(k): str(v) for k, v in class_names_raw.items()}
            if isinstance(class_names_raw, dict)
            else {}
        )

        run_id, export_dir = _create_export_dir(source_video)
        video_file = f"source{suffix}"
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    def stream_body() -> Iterator[bytes]:
        job.clear()
        job["status"] = "processing"
        job["percent"] = 0
        tracks: list[dict[str, Any]] = []
        try:
            for event in _track_video_events(
                tmp_path,
                fps,
                width,
                height,
                frame_count,
                class_names,
                export_dir,
                run_id,
            ):
                if event.get("type") == "done":
                    tracks = event.get("tracks") or []
                yield _ndjson_line(event).encode("utf-8")

            dest_video = export_dir / video_file
            shutil.copy2(tmp_path, dest_video)
            _write_export_meta(
                export_dir,
                run_id,
                source_video,
                video_file,
                fps,
                width,
                height,
                frame_count,
                class_names,
                tracks,
            )
            logger.info("Saved export %s", run_id)

            job.clear()
            job["status"] = "done"
            job["percent"] = 100
        except Exception as exc:
            logger.exception("Analyze failed")
            shutil.rmtree(export_dir, ignore_errors=True)
            job.clear()
            job["status"] = "error"
            job["message"] = str(exc)
            yield _ndjson_line({"type": "error", "message": str(exc)}).encode("utf-8")
        finally:
            tmp_path.unlink(missing_ok=True)

    return StreamingResponse(stream_body(), media_type="application/x-ndjson")
