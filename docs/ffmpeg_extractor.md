# Salamander-AI-Detection

## Extract frames with FFmpeg (every Nth frame)

Prerequisite: [FFmpeg](https://ffmpeg.org/download.html) installed and `ffmpeg` available on your PATH (Windows: ensure `ffmpeg.exe` is discoverable from PowerShell).

From the repo root, run:

```powershell
.\scripts\extract_every_nth_frame.ps1 -InputVideo "C:\path\to\video.mp4"
```

This creates a folder next to the video named `<video_stem>_frames` and writes `frame_000001.png`, `frame_000002.png`, … for each **kept** frame only.

Options:

| Parameter      | Default              | Description                                      |
| --------------- | -------------------- | ------------------------------------------------ |
| `-InputVideo`   | (required)           | Path to the source `.mp4` (or any FFmpeg input). |
| `-OutputDir`    | `<stem>_frames`      | Output directory (created if missing).         |
| `-Nth`          | `5`                  | Keep frames at indices 0, N, 2N, … (spacing N).   |
| `-ImageFormat`  | `png`                | `png` or `jpg`.                                |

Examples:

```powershell
.\scripts\extract_every_nth_frame.ps1 -InputVideo .\clip.mp4 -OutputDir .\frames_out -Nth 5
.\scripts\extract_every_nth_frame.ps1 -InputVideo .\clip.mp4 -ImageFormat jpg
```

**Frame indexing:** sampling uses FFmpeg’s zero-based input frame index `n`. With `-Nth 5`, exported frames correspond to source frames **0, 5, 10, 15, …** (not 1, 6, 11, …).

Implementation detail: the script runs `ffmpeg` with `-vf "select='eq(mod(n\,N)\,0)',setpts=N/FRAME_RATE/TB"` and `-vsync vfr` so output files are numbered sequentially without gaps.