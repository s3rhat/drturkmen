/* ─── State ──────────────────────────────────────────────────────────────────
   Manages the camera feed, motion detection, auto-capture loop, and
   communication with the Flask backend.
   ─────────────────────────────────────────────────────────────────────────── */

let sessionId       = null;
let stream          = null;          // MediaStream
let scanning        = false;
let captureTimer    = null;
let motionTimer     = null;
let frameCount      = 0;
let lastFrameData   = null;          // ImageData for motion comparison
let currentDeviceId = null;

// Canvas for frame analysis (not in DOM)
const analysisCanvas  = document.createElement('canvas');
const analysisCtx     = analysisCanvas.getContext('2d');

// ─── Settings helpers ─────────────────────────────────────────────────────────
function getCaptureInterval()  { return parseInt(document.getElementById('captureInterval').value, 10) * 1000; }
function getMotionThreshold()  { return parseInt(document.getElementById('motionThreshold').value, 10); }
function isAutoCapture()       { return document.getElementById('autoCapture').checked; }

// Wire up range inputs to display their live value
document.getElementById('captureInterval').addEventListener('input', e => {
  document.getElementById('intervalValue').textContent = e.target.value + 's';
});
document.getElementById('motionThreshold').addEventListener('input', e => {
  document.getElementById('motionValue').textContent = e.target.value;
});

// ─── Session management ───────────────────────────────────────────────────────
async function ensureSession() {
  if (sessionId) return;
  const resp = await fetch('/session/new', { method: 'POST' });
  const data = await resp.json();
  sessionId = data.session_id;
}

// ─── Camera setup ─────────────────────────────────────────────────────────────
async function initCamera() {
  try {
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },  // back camera on phones
        width:  { ideal: 1280 },
        height: { ideal: 960 },
        ...(currentDeviceId ? { deviceId: { exact: currentDeviceId } } : {}),
      },
      audio: false,
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('video');
    video.srcObject = stream;
    await video.play();

    setStatus('Camera ready. Tap ▶ Start Scan');
    populateCameraList();
    return true;
  } catch (err) {
    setStatus('Camera error: ' + err.message);
    return false;
  }
}

async function populateCameraList() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter(d => d.kind === 'videoinput');
  const select  = document.getElementById('cameraSelect');
  const panel   = document.getElementById('cameraSelectPanel');

  if (cameras.length > 1) {
    select.innerHTML = cameras.map((c, i) =>
      `<option value="${c.deviceId}">${c.label || 'Camera ' + (i + 1)}</option>`
    ).join('');
    if (stream) {
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      select.value = settings.deviceId || '';
    }
    panel.classList.remove('hidden');
  }
}

async function switchCamera() {
  currentDeviceId = document.getElementById('cameraSelect').value;
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
  await initCamera();
}

// ─── Scanning controls ────────────────────────────────────────────────────────
async function startScanning() {
  if (scanning) return;

  await ensureSession();

  if (!stream) {
    const ok = await initCamera();
    if (!ok) return;
  }

  scanning = true;
  document.getElementById('btnStart').classList.add('hidden');
  document.getElementById('btnStop').classList.remove('hidden');
  document.getElementById('btnCapture').disabled = false;
  document.getElementById('btnStitch').disabled  = frameCount === 0;
  document.querySelector('.camera-container').classList.add('scanning');

  setStatus('Scanning… move the plate slowly');

  if (isAutoCapture()) {
    scheduleCaptureLoop();
  }

  // Start motion detection loop
  startMotionDetection();
}

function stopScanning() {
  scanning = false;
  clearTimeout(captureTimer);
  clearInterval(motionTimer);

  document.getElementById('btnStart').classList.remove('hidden');
  document.getElementById('btnStop').classList.add('hidden');
  document.querySelector('.camera-container').classList.remove('scanning');
  document.getElementById('motionIndicator').classList.add('hidden');
  document.getElementById('btnStitch').disabled = frameCount === 0;

  setStatus(frameCount + ' frames captured. Ready to stitch.');
}

// ─── Auto-capture loop ────────────────────────────────────────────────────────
function scheduleCaptureLoop() {
  if (!scanning || !isAutoCapture()) return;
  captureTimer = setTimeout(async () => {
    if (scanning) {
      await captureFrame();
      scheduleCaptureLoop();
    }
  }, getCaptureInterval());
}

// ─── Motion detection ─────────────────────────────────────────────────────────
function startMotionDetection() {
  const video = document.getElementById('video');
  motionTimer = setInterval(() => {
    if (!video.videoWidth) return;

    analysisCanvas.width  = 160;   // small for speed
    analysisCanvas.height = 120;
    analysisCtx.drawImage(video, 0, 0, 160, 120);
    const current = analysisCtx.getImageData(0, 0, 160, 120);

    if (lastFrameData) {
      const motion = computeMotion(current.data, lastFrameData.data);
      const threshold = getMotionThreshold();
      const indicator = document.getElementById('motionIndicator');

      if (motion > threshold) {
        indicator.classList.remove('hidden');
      } else {
        indicator.classList.add('hidden');
      }
    }
    lastFrameData = current;
  }, 200);
}

function computeMotion(current, previous) {
  let diff = 0;
  // Sample every 4th pixel for performance (each pixel = 4 bytes RGBA)
  for (let i = 0; i < current.length; i += 16) {
    diff += Math.abs(current[i] - previous[i]);
  }
  return diff / (current.length / 16) / 2.55;  // 0-100 scale
}

// ─── Frame capture ────────────────────────────────────────────────────────────
async function captureFrame() {
  const video = document.getElementById('video');
  if (!video.videoWidth || !sessionId) return;

  // Draw full-resolution frame to a capture canvas
  const cap = document.createElement('canvas');
  cap.width  = video.videoWidth;
  cap.height = video.videoHeight;
  cap.getContext('2d').drawImage(video, 0, 0);

  // Flash effect
  const container = document.querySelector('.camera-container');
  container.classList.remove('flash');
  void container.offsetWidth;  // force reflow
  container.classList.add('flash');

  const dataUrl = cap.toDataURL('image/jpeg', 0.85);

  try {
    const resp = await fetch(`/session/${sessionId}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
    });
    const data = await resp.json();

    if (data.success) {
      frameCount = data.frame_count;
      document.getElementById('frameCount').textContent = frameCount + ' frames';
      document.getElementById('btnStitch').disabled = false;
      setStatus('Frame ' + frameCount + ' captured');
    }
  } catch (err) {
    setStatus('Capture error: ' + err.message);
  }
}

async function manualCapture() {
  await ensureSession();
  await captureFrame();
}

// ─── Clear session ────────────────────────────────────────────────────────────
async function clearSession() {
  if (sessionId) {
    await fetch(`/session/${sessionId}/clear`, { method: 'POST' });
  }
  frameCount = 0;
  document.getElementById('frameCount').textContent = '0 frames';
  document.getElementById('btnStitch').disabled = true;
  document.getElementById('resultsPanel').classList.add('hidden');
  setStatus('Cleared. Ready to scan.');
}

// ─── Stitch & Count ───────────────────────────────────────────────────────────
async function stitchAndCount() {
  if (!sessionId || frameCount === 0) return;

  showLoading('Stitching images…');

  try {
    const resp = await fetch(`/session/${sessionId}/stitch`, { method: 'POST' });
    const data = await resp.json();

    hideLoading();

    if (!data.success) {
      alert('Error: ' + (data.error || 'Unknown error'));
      return;
    }

    displayResults(data);
  } catch (err) {
    hideLoading();
    alert('Network error: ' + err.message);
  }
}

// ─── Display results ──────────────────────────────────────────────────────────
function displayResults(data) {
  const panel = document.getElementById('resultsPanel');
  panel.classList.remove('hidden');

  // Stitched image
  const img = document.getElementById('stitchedImage');
  img.src = data.stitched_image + '?t=' + Date.now();

  const analysis = data.worm_analysis || {};

  // Counts
  const setCount = (id, val) => {
    const el = document.getElementById(id);
    el.textContent = (val !== undefined && val !== null && val >= 0) ? val : '–';
  };

  setCount('countTotal',  analysis.count);
  setCount('countAdults', analysis.adults);
  setCount('countLarvae', analysis.larvae);
  setCount('countEggs',   analysis.eggs);

  // Meta badges
  const conf = analysis.confidence;
  const confBadge = document.getElementById('confidenceBadge');
  if (conf) {
    confBadge.textContent = '📊 ' + conf.charAt(0).toUpperCase() + conf.slice(1) + ' confidence';
    confBadge.style.color = conf === 'high' ? '#4ade80' : conf === 'medium' ? '#fbbf24' : '#f87171';
  }

  const qual = analysis.image_quality;
  const qualBadge = document.getElementById('qualityResultBadge');
  if (qual) {
    qualBadge.textContent = '🖼 ' + qual.charAt(0).toUpperCase() + qual.slice(1) + ' quality';
  }

  document.getElementById('framesBadge').textContent = '📷 ' + data.frame_count + ' frames';

  // Observations
  const obsCard = document.getElementById('observationsCard');
  const obsText = document.getElementById('observationsText');
  if (analysis.observations) {
    obsText.textContent = analysis.observations;
    obsCard.classList.remove('hidden');
  } else {
    obsCard.classList.add('hidden');
  }

  // Raw response
  document.getElementById('rawResponse').textContent =
    analysis.raw_response || JSON.stringify(analysis, null, 2);

  // Scroll to results
  panel.scrollIntoView({ behavior: 'smooth' });
}

// ─── New Scan ─────────────────────────────────────────────────────────────────
async function newScan() {
  await clearSession();
  sessionId = null;
  await ensureSession();
  document.getElementById('resultsPanel').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(msg) {
  document.getElementById('statusText').textContent = msg;
}

function showLoading(msg) {
  document.getElementById('loadingText').textContent = msg || 'Processing…';
  document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  await ensureSession();
  await initCamera();
})();
