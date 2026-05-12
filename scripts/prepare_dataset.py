"""YOLO training expects images and labels split into train/ and val/ subfolders
with a dataset.yaml describing them. This script handles the split and writes
the yaml.

Usage:
    python scripts/prepare_dataset.py --export-dir path/to/label-studio-export
"""

from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--export-dir",
        required=True,
        help="Path to the Label Studio YOLO export directory",
    )
    parser.add_argument(
        "--output",
        default="data/dataset",
        help="Where to write the split dataset",
    )
    parser.add_argument(
        "--val-fraction",
        type=float,
        default=0.2,
        help="Fraction of images to use for validation (0-1)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for the train/val split",
    )
    args = parser.parse_args()

    src = Path(args.export_dir)
    dst = Path(args.output)
    src_images = src / "images"
    src_labels = src / "labels"
    classes_file = src / "classes.txt"

    if not src_images.is_dir() or not src_labels.is_dir():
        raise SystemExit(
            f"Expected {src_images} and {src_labels} to exist. "
            "Make sure you exported from Label Studio in the YOLO format "
        )

    image_paths = sorted(
        p
        for p in src_images.iterdir()
        if p.suffix.lower() in (".jpg", ".jpeg", ".png")
    )
    if not image_paths:
        raise SystemExit(f"No images found in {src_images}")

    random.seed(args.seed)
    random.shuffle(image_paths)
    n_val = max(1, int(len(image_paths) * args.val_fraction))
    val_paths = image_paths[:n_val]
    train_paths = image_paths[n_val:]

    # Wipe and recreate the destination so re-running is deterministic.
    if dst.exists():
        shutil.rmtree(dst)
    for split in ("train", "val"):
        (dst / "images" / split).mkdir(parents=True)
        (dst / "labels" / split).mkdir(parents=True)

    def copy_pair(img_path: Path, split: str) -> None:
        label_path = src_labels / (img_path.stem + ".txt")
        shutil.copy(img_path, dst / "images" / split / img_path.name)
        if label_path.exists():
            shutil.copy(label_path, dst / "labels" / split / label_path.name)
        else:
            print(f"warning: no label for {img_path.name}")

    for p in train_paths:
        copy_pair(p, "train")
    for p in val_paths:
        copy_pair(p, "val")

    if classes_file.exists():
        text = classes_file.read_text(encoding="utf-8")
        names = [line.strip() for line in text.splitlines() if line.strip()]
    else:
        names = ["object"]
        print("warning: classes.txt missing in export, defaulting to 'object'")

    yaml_path = dst / "dataset.yaml"
    lines = [
        f"path: {dst.resolve()}",
        "train: images/train",
        "val: images/val",
        "",
        "names:",
    ]
    for i, name in enumerate(names):
        lines.append(f"  {i}: {name}")
    yaml_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print()
    print(f"Wrote {yaml_path}")
    print(f"  train: {len(train_paths)} images")
    print(f"  val: {len(val_paths)} images")
    print(f"  classes: {names}")
    print()
    print("Next: python scripts/train.py --data " + str(yaml_path))


if __name__ == "__main__":
    main()
