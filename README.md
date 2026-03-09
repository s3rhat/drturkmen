# C. elegans Worm Counter

A web app for scanning microscopy plates, stitching photos, and counting C. elegans worms using Claude Vision AI.

## How It Works

1. Mount your smartphone above the microscope eyepiece with the holder
2. Open the app in your phone's browser (same Wi-Fi network)
3. Tap **▶ Start Scan** and slowly move the plate
4. The app auto-captures frames at a set interval (or tap **📷 Capture** manually)
5. Tap **🔬 Stitch & Count Worms** — OpenCV stitches the frames, then Claude Vision counts the worms

## Setup

```bash
# Install dependencies
pip install -r requirements.txt

# Set your Anthropic API key
export ANTHROPIC_API_KEY=your_key_here

# Run the server
python app.py
```

The server listens on `0.0.0.0:5000`. On your phone, navigate to:
```
http://<your-computer-ip>:5000
```

## Settings

| Setting | Description |
|---|---|
| Auto-capture | Automatically capture a frame every N seconds |
| Interval | Seconds between auto-captures (1–10s) |
| Motion sensitivity | How much movement triggers the motion indicator |

## Architecture

```
app.py                  Flask backend
├── /session/new        Create a scan session
├── /session/:id/capture  Save a camera frame
├── /session/:id/stitch   Stitch frames + count worms
└── /session/:id/clear    Reset session

templates/index.html    Mobile-optimized UI
static/js/app.js        Camera, motion detection, capture logic
static/css/style.css    Dark-mode mobile styles
```

## Worm Detection

Claude `claude-opus-4-6` with adaptive thinking analyzes the stitched panorama and reports:
- Total worm count
- Adults vs larvae breakdown
- Egg count
- Confidence level (high / medium / low)
- Image quality assessment
- Observations about worm health/behavior

## Tips for Best Results

- Use **brightfield or DIC** microscopy for best contrast
- Move the plate **slowly and steadily**
- Keep the **same focus plane** throughout the scan
- Overlap adjacent frames by ~30% for reliable stitching
- Use the **3–5 second interval** for typical hand-movement speed
- If stitching fails (not enough overlap), the app falls back to a grid layout
