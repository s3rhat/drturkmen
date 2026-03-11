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

// ─── Grid state ───────────────────────────────────────────────────────────────
let gridCols        = 3;             // current grid size (0 = off)
let gridDone        = new Set();     // set of cell indices (0-based) marked done
let gridCurrent     = 0;             // index of the suggested next cell
let gridRafId       = null;          // requestAnimationFrame id for grid drawing

// Canvas for frame analysis (not in DOM)
const analysisCanvas  = document.createElement('canvas');
const analysisCtx     = analysisCanvas.getContext('2d');

// ─── Settings helpers ─────────────────────────────────────────────────────────
function getCaptureInterval()  { return parseInt(document.getElementById('captureInterval').value, 10) * 1000; }
function getMotionThreshold()  { return parseInt(document.getElementById('motionThreshold').value, 10); }
function isAutoCapture()       { return document.getElementById('autoCapture').checked; }
function getGridSize()         { return parseInt(document.getElementById('gridSize').value, 10); }

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
      // Auto-advance the grid suggestion
      if (gridCols > 0) markCellDone(gridCurrent);
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
  frameCount  = 0;
  gridDone    = new Set();
  gridCurrent = 0;
  updateGridProgress();
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

// ─── Grid overlay ─────────────────────────────────────────────────────────────

function onGridSizeChange() {
  gridCols    = getGridSize();
  gridDone    = new Set();
  gridCurrent = 0;
  updateGridProgress();
  // restart the draw loop (handles off/on transition)
  if (gridRafId) cancelAnimationFrame(gridRafId);
  drawGrid();
}

function updateGridProgress() {
  const total = gridCols * gridCols;
  const el    = document.getElementById('gridProgress');
  if (gridCols === 0) { el.textContent = ''; return; }
  el.textContent = gridDone.size + '/' + total;
  el.style.color = gridDone.size === total ? '#4ade80' : '#94a3b8';
}

/** Mark a cell done and advance the suggestion to the next unchecked cell. */
function markCellDone(idx) {
  if (gridCols === 0) return;
  const total = gridCols * gridCols;
  gridDone.add(idx);
  // advance gridCurrent to next undone cell (row-major order)
  for (let i = 1; i <= total; i++) {
    const next = (idx + i) % total;
    if (!gridDone.has(next)) { gridCurrent = next; break; }
  }
  updateGridProgress();
}

/** Toggle a cell's done state when the user taps it. */
function handleOverlayTap(e) {
  if (gridCols === 0) return;
  const canvas  = document.getElementById('overlay');
  const rect    = canvas.getBoundingClientRect();
  const x       = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const y       = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  const cellW   = rect.width  / gridCols;
  const cellH   = rect.height / gridCols;
  const col     = Math.floor(x / cellW);
  const row     = Math.floor(y / cellH);
  const idx     = row * gridCols + col;

  if (gridDone.has(idx)) {
    gridDone.delete(idx);
    // reset suggestion if we unchecked the current
    if (idx === gridCurrent) gridCurrent = idx;
  } else {
    markCellDone(idx);
  }
  updateGridProgress();
}

/** Draw the grid on the overlay canvas every animation frame. */
function drawGrid() {
  const canvas  = document.getElementById('overlay');
  const video   = document.getElementById('video');
  const ctx     = canvas.getContext('2d');

  // Match canvas resolution to its displayed size
  canvas.width  = canvas.offsetWidth  || video.videoWidth  || 640;
  canvas.height = canvas.offsetHeight || video.videoHeight || 480;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (gridCols > 0) {
    const W     = canvas.width;
    const H     = canvas.height;
    const cellW = W / gridCols;
    const cellH = H / gridCols;
    const total = gridCols * gridCols;

    for (let r = 0; r < gridCols; r++) {
      for (let c = 0; c < gridCols; c++) {
        const idx = r * gridCols + c;
        const x   = c * cellW;
        const y   = r * cellH;

        // Cell fill
        if (gridDone.has(idx)) {
          ctx.fillStyle = 'rgba(74, 222, 128, 0.18)';   // green — done
        } else if (idx === gridCurrent && scanning) {
          ctx.fillStyle = 'rgba(251, 191, 36, 0.15)';   // yellow — suggested next
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.03)';
        }
        ctx.fillRect(x, y, cellW, cellH);

        // Cell border
        ctx.strokeStyle = gridDone.has(idx)
          ? 'rgba(74, 222, 128, 0.7)'
          : (idx === gridCurrent && scanning)
            ? 'rgba(251, 191, 36, 0.9)'
            : 'rgba(255,255,255,0.25)';
        ctx.lineWidth = gridDone.has(idx) || (idx === gridCurrent && scanning) ? 2 : 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

        // Cell number
        const fontSize = Math.max(10, Math.min(18, cellW * 0.18));
        ctx.font       = `600 ${fontSize}px -apple-system, sans-serif`;
        ctx.textAlign  = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle  = gridDone.has(idx)
          ? 'rgba(74,222,128,0.9)'
          : 'rgba(255,255,255,0.55)';
        ctx.fillText(idx + 1, x + 5, y + 4);

        // Checkmark for done cells
        if (gridDone.has(idx)) {
          const cx = x + cellW / 2;
          const cy = y + cellH / 2;
          const sz = Math.min(cellW, cellH) * 0.28;
          ctx.strokeStyle = 'rgba(74,222,128,0.95)';
          ctx.lineWidth   = Math.max(2, sz * 0.18);
          ctx.lineCap     = 'round';
          ctx.lineJoin    = 'round';
          ctx.beginPath();
          ctx.moveTo(cx - sz * 0.5, cy);
          ctx.lineTo(cx - sz * 0.1, cy + sz * 0.45);
          ctx.lineTo(cx + sz * 0.5, cy - sz * 0.35);
          ctx.stroke();
        }

        // "NEXT" label on suggested cell
        if (idx === gridCurrent && !gridDone.has(idx) && scanning) {
          ctx.font      = `700 ${Math.max(9, fontSize * 0.7)}px -apple-system, sans-serif`;
          ctx.fillStyle = 'rgba(251,191,36,0.9)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('NEXT', x + cellW / 2, y + cellH / 2);
        }
      }
    }

    // Progress bar at bottom of overlay
    if (total > 0) {
      const barH   = Math.max(3, H * 0.012);
      const filled = (gridDone.size / total) * W;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, H - barH, W, barH);
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(0, H - barH, filled, barH);
    }
  }

  gridRafId = requestAnimationFrame(drawGrid);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  await ensureSession();
  await initCamera();

  // Wire up overlay tap/click for grid cell marking
  const overlay = document.getElementById('overlay');
  overlay.addEventListener('click',      handleOverlayTap);
  overlay.addEventListener('touchstart', handleOverlayTap, { passive: true });

  // Start the draw loop
  drawGrid();
})();
