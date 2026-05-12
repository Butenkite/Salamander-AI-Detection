# Salamander-AI-Detection

End-to-end flow: **extract frames from video → label in Label Studio → split export for YOLO → (optional) preview augmentations → train.**

Run all commands from the **repository root** unless noted.

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Python 3** | Use `python` or `py` in PowerShell. |
| **FFmpeg** | On PATH as `ffmpeg` (needed only for frame extraction). [Download FFmpeg](https://ffmpeg.org/download.html). |
| **Label Studio** | For labeling; export project as **YOLO** (not OBB). Docker or local install is fine. |
| **GPU (optional)** | Training works on CPU; GPU speeds things up. Ultralytics picks a device automatically unless you pass `--device`. |

---

## 1. Python environment and dependencies

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

If `Activate.ps1` is blocked:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

If `python` is not found, try:

```powershell
py -m venv venv
.\venv\Scripts\Activate.ps1
py -m pip install -r requirements.txt
```

---

## 2. Extract frames from video (FFmpeg)

Creates a folder of PNG/JPEG images (every **Nth** frame: indices `0, N, 2N, …`).

```powershell
.\scripts\extract_every_nth_frame.ps1 `
  -InputVideo .\videos\YOUR_VIDEO.mp4 `
  -OutputDir .\frames_out `
  -Nth 5
```

Swap `YOUR_VIDEO.mp4` for your file. Omit `-OutputDir` to use `.\videos\YOUR_VIDEO_frames\` next to the video.

**JPEG instead of PNG:**

```powershell
.\scripts\extract_every_nth_frame.ps1 -InputVideo .\videos\YOUR_VIDEO.mp4 -OutputDir .\frames_out -Nth 5 -ImageFormat jpg
```

Use these images as the source you **import into Label Studio** for bounding-box labeling.

---

## 3. Label Studio → YOLO export

1. Create a project and label your frames (bounding boxes).
2. **Export** the project in **YOLO** format (folder contains `images\`, `labels\`, and `classes.txt`).
3. Unzip/copy that export somewhere under the repo, for example:

```text
data\labelstudio\export\project-2-at-YYYY-MM-DD-xxxxx\
  classes.txt
  images\
  labels\
  notes.json
```

Replace paths below with your real export folder.

---

## 4. Split into `train/` / `val/` and write `dataset.yaml`

Rebuilds `data\dataset\` every run (same shuffle **seed 42** by default → reproducible split).

```powershell
python scripts\prepare_dataset.py --export-dir .\data\labelstudio\export\YOUR_EXPORT_FOLDER
```

**Examples:**

```powershell
python scripts\prepare_dataset.py --export-dir .\data\labelstudio\export\project-2-at-2026-05-12-17-28-45a897a6 --val-fraction 0.2
python scripts\prepare_dataset.py --export-dir .\data\labelstudio\export\YOUR_EXPORT_FOLDER --seed 123 --output .\data\dataset
```

Output layout:

```text
data\dataset\
  dataset.yaml
  images\train\
  images\val\
  labels\train\
  labels\val\
```

---

## 5. (Optional) Visualize augmentations

Needs **at least four** `.jpg` / `.jpeg` / `.png` files in one folder (e.g. extracted frames).

```powershell
python scripts\visualize_augmentations.py --image-dir .\frames_out --output .\augmentations.pdf
```

Open `augmentations.pdf` in a browser or PDF viewer (the editor may not preview PDFs well).

---

## 6. Train YOLO

First run downloads the base weights (e.g. `yolo11n.pt`) if they are not already present.

```powershell
python scripts\train.py --data data\dataset\dataset.yaml
```

**Common tweaks:**

```powershell
python scripts\train.py --data data\dataset\dataset.yaml --epochs 100 --batch 16 --name salamander_run1
python scripts\train.py --data data\dataset\dataset.yaml --device cpu
python scripts\train.py --data data\dataset\dataset.yaml --device 0
```

Trained weights:

```text
runs\detect\<run-name>\weights\best.pt
```

Full CLI:

```powershell
python scripts\train.py --help
```

---

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| `pip` / `python` not recognized | Use `py -m pip` and `py` instead of `pip` / `python`. |
| FFmpeg not found | Install FFmpeg and confirm `ffmpeg -version` works in PowerShell. |
| `prepare_dataset` fails | Export must be **YOLO** layout with `images\` and `labels\` beside `classes.txt`. |
| `visualize_augmentations` fails | Folder must exist and contain **≥ 4** images; set `--image-dir` explicitly. |

---

## Repo layout (scripts)

| Script | Role |
|--------|------|
| `scripts\extract_every_nth_frame.ps1` | Video → frame images |
| `scripts\prepare_dataset.py` | Label Studio YOLO export → `data\dataset` + `dataset.yaml` |
| `scripts\visualize_augmentations.py` | Demo PDF of augmentation effects |
| `scripts\train.py` | Fine-tune YOLO via Ultralytics |

More detail on FFmpeg options: [docs/ffmpeg_extractor.md](docs/ffmpeg_extractor.md).
