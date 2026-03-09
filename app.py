import os
import base64
import uuid
import json
import cv2
import numpy as np
import anthropic
from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.utils import secure_filename
from datetime import datetime

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB max

UPLOAD_FOLDER = 'uploads'
STITCHED_FOLDER = 'stitched'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(STITCHED_FOLDER, exist_ok=True)

# In-memory session storage: session_id -> list of image paths
sessions: dict[str, list[str]] = {}

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))


def decode_base64_image(data_url: str) -> np.ndarray:
    """Decode a base64 data URL to a numpy array."""
    header, encoded = data_url.split(",", 1)
    img_bytes = base64.b64decode(encoded)
    arr = np.frombuffer(img_bytes, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def stitch_images(image_paths: list[str]) -> tuple[bool, str]:
    """
    Stitch a list of images together using OpenCV's Stitcher.
    Returns (success, output_path_or_error).
    """
    images = []
    for path in image_paths:
        img = cv2.imread(path)
        if img is not None:
            images.append(img)

    if len(images) == 0:
        return False, "No valid images to stitch"

    if len(images) == 1:
        out_path = os.path.join(STITCHED_FOLDER, f"stitched_{uuid.uuid4().hex}.jpg")
        cv2.imwrite(out_path, images[0])
        return True, out_path

    # Try OpenCV Stitcher first
    stitcher = cv2.Stitcher.create(cv2.Stitcher_SCANS)
    status, panorama = stitcher.stitch(images)

    if status == cv2.Stitcher_OK:
        out_path = os.path.join(STITCHED_FOLDER, f"stitched_{uuid.uuid4().hex}.jpg")
        cv2.imwrite(out_path, panorama)
        return True, out_path

    # Fallback: grid layout if stitcher fails (e.g., not enough overlap)
    return stitch_grid(images)


def stitch_grid(images: list[np.ndarray]) -> tuple[bool, str]:
    """
    Fallback: arrange images in a grid when feature-based stitching fails.
    Resizes all images to the same size and arranges them in a grid.
    """
    if not images:
        return False, "No images"

    # Resize all to same size (use first image as reference)
    h, w = images[0].shape[:2]
    resized = [cv2.resize(img, (w, h)) for img in images]

    n = len(resized)
    cols = int(np.ceil(np.sqrt(n)))
    rows = int(np.ceil(n / cols))

    # Pad with black images if needed
    while len(resized) < rows * cols:
        resized.append(np.zeros((h, w, 3), dtype=np.uint8))

    row_imgs = []
    for r in range(rows):
        row = np.hstack(resized[r * cols:(r + 1) * cols])
        row_imgs.append(row)

    grid = np.vstack(row_imgs)
    out_path = os.path.join(STITCHED_FOLDER, f"stitched_grid_{uuid.uuid4().hex}.jpg")
    cv2.imwrite(out_path, grid)
    return True, out_path


def count_worms_with_claude(image_path: str) -> dict:
    """
    Use Claude Vision to count C. elegans worms in a stitched image.
    Returns a dict with count, confidence, and details.
    """
    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    # Determine media type
    media_type = "image/jpeg"
    if image_path.lower().endswith(".png"):
        media_type = "image/png"

    system_prompt = """You are an expert C. elegans (nematode worm) researcher and image analyst.
You specialize in counting and analyzing C. elegans worms in microscopy images.

C. elegans characteristics to look for:
- Transparent, elongated worm shape (roughly 1mm in length, adult)
- Sinusoidal/curved body posture
- May appear as bright or dark elongated shapes depending on microscopy type
- Can be moving (curved) or dead (straight, rod-like)
- Larvae are smaller versions of adults
- Eggs appear as oval shapes near adult worms

Provide a structured analysis including:
1. Total worm count (adults + larvae separately if possible)
2. Egg count (if visible)
3. Confidence level (high/medium/low)
4. Any observations about worm health or behavior
5. Image quality assessment"""

    with client.messages.stream(
        model="claude-opus-4-6",
        max_tokens=1024,
        thinking={"type": "adaptive"},
        system=system_prompt,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": """Please analyze this microscopy image and count the C. elegans worms.

Provide your response in the following JSON format:
{
  "total_count": <number>,
  "adults": <number>,
  "larvae": <number>,
  "eggs": <number>,
  "confidence": "<high|medium|low>",
  "observations": "<brief observations>",
  "image_quality": "<good|fair|poor>"
}

Be thorough but concise. If the image is unclear or you cannot confidently identify worms, indicate this in your response.""",
                    },
                ],
            }
        ],
    ) as stream:
        response = stream.get_final_message()

    # Extract text from response
    result_text = ""
    for block in response.content:
        if block.type == "text":
            result_text = block.text
            break

    # Try to parse JSON from the response
    try:
        # Find JSON block in response
        import re
        json_match = re.search(r'\{[^{}]*\}', result_text, re.DOTALL)
        if json_match:
            data = json.loads(json_match.group())
            return {
                "success": True,
                "count": data.get("total_count", 0),
                "adults": data.get("adults", 0),
                "larvae": data.get("larvae", 0),
                "eggs": data.get("eggs", 0),
                "confidence": data.get("confidence", "unknown"),
                "observations": data.get("observations", ""),
                "image_quality": data.get("image_quality", "unknown"),
                "raw_response": result_text,
            }
    except (json.JSONDecodeError, AttributeError):
        pass

    # Fallback: return raw text
    return {
        "success": True,
        "count": -1,
        "raw_response": result_text,
        "parse_error": "Could not parse structured JSON from response",
    }


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/session/new", methods=["POST"])
def new_session():
    session_id = uuid.uuid4().hex
    sessions[session_id] = []
    return jsonify({"session_id": session_id})


@app.route("/session/<session_id>/capture", methods=["POST"])
def capture_frame(session_id: str):
    """Accept a base64 image frame and save it for later stitching."""
    if session_id not in sessions:
        return jsonify({"error": "Invalid session"}), 404

    data = request.get_json()
    if not data or "image" not in data:
        return jsonify({"error": "No image data"}), 400

    try:
        img = decode_base64_image(data["image"])
        filename = f"{session_id}_{len(sessions[session_id]):04d}.jpg"
        path = os.path.join(UPLOAD_FOLDER, filename)
        cv2.imwrite(path, img)
        sessions[session_id].append(path)

        return jsonify({
            "success": True,
            "frame_count": len(sessions[session_id]),
            "filename": filename,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/session/<session_id>/stitch", methods=["POST"])
def stitch_session(session_id: str):
    """Stitch all captured frames and count worms."""
    if session_id not in sessions:
        return jsonify({"error": "Invalid session"}), 404

    paths = sessions[session_id]
    if not paths:
        return jsonify({"error": "No frames captured"}), 400

    # Stitch images
    success, result = stitch_images(paths)
    if not success:
        return jsonify({"error": f"Stitching failed: {result}"}), 500

    # Count worms with Claude
    try:
        worm_data = count_worms_with_claude(result)
    except Exception as e:
        worm_data = {"success": False, "error": str(e)}

    # Get relative path for serving
    stitched_filename = os.path.basename(result)

    return jsonify({
        "success": True,
        "stitched_image": f"/stitched/{stitched_filename}",
        "frame_count": len(paths),
        "worm_analysis": worm_data,
    })


@app.route("/session/<session_id>/clear", methods=["POST"])
def clear_session(session_id: str):
    """Clear captured frames for a session."""
    if session_id in sessions:
        # Remove files
        for path in sessions[session_id]:
            try:
                os.remove(path)
            except OSError:
                pass
        sessions[session_id] = []
    return jsonify({"success": True})


@app.route("/stitched/<filename>")
def serve_stitched(filename: str):
    safe_filename = secure_filename(filename)
    return send_from_directory(STITCHED_FOLDER, safe_filename)


@app.route("/health")
def health():
    return jsonify({"status": "ok", "timestamp": datetime.now().isoformat()})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    # Use 0.0.0.0 so the app is accessible from the smartphone on the same network
    app.run(host="0.0.0.0", port=port, debug=False)
