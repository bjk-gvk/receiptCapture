import * as db from './db.js';
import { Dictation } from './dictation.js';
import { buildExport, localStamp } from './export.js';
import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);
const MAX_EDGE = 2560; // px, longest side of saved photos
const JPEG_QUALITY = 0.88;
const HINT = 'Describe it: what it was for, who was there.';

let screen = 'camera';
let stream = null;
let cameraStarting = null;
let currentId = null; // receipt shown on the review screen
let busy = false;
let reviewUrl = null;
let thumbUrls = [];
let exportFile = null;
let exportUrl = null;

// ---------- debounced saves (flushed before export / when the app is hidden) ----------
const pending = new Map();
function later(key, fn, ms = 500) {
  clearTimeout(pending.get(key)?.timer);
  pending.set(key, { fn, timer: setTimeout(() => (pending.delete(key), fn()), ms) });
}
function cancel(key) {
  clearTimeout(pending.get(key)?.timer);
  pending.delete(key);
}
function cancelAll() {
  pending.forEach((j) => clearTimeout(j.timer));
  pending.clear();
}
async function flush() {
  const jobs = [...pending.values()];
  pending.clear();
  jobs.forEach((j) => clearTimeout(j.timer));
  await Promise.all(jobs.map((j) => j.fn()));
}

// ---------- dictation ----------
const dictation = new Dictation(onDictationText, renderMic);

function onDictationText(text) {
  if (screen === 'review') {
    $('review-text').value = text;
    if (currentId != null) {
      const id = currentId;
      later(`desc-${id}`, () => db.updateDescription(id, text));
    }
  } else {
    renderCamText(text);
  }
}

function renderMic(state = dictation.supported ? 'off' : 'unsupported', detail) {
  const fallback = 'after the photo, tap the text box and use the keyboard mic.';
  const msg = {
    listening: 'Listening',
    off: 'Mic off',
    unsupported: `Live dictation isn't available in this browser: ${fallback}`,
    blocked: `Dictation isn't allowed: ${fallback}`,
    error: `Dictation stopped${detail ? ` (${detail})` : ''}.`,
  }[state];
  for (const id of ['cam-mic', 'rev-mic']) {
    $(id).textContent = msg;
    $(id).dataset.state = state;
  }
  $('mic-toggle').hidden = !dictation.supported;
  $('mic-toggle').textContent = state === 'listening' ? 'Pause mic' : 'Resume mic';
}

function renderCamText(text) {
  $('cam-text').textContent = text || HINT;
  $('cam-text').classList.toggle('placeholder', !text);
}

// ---------- camera ----------
function startCamera() {
  if (stream || cameraStarting) return cameraStarting;
  $('cam-error').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    return showCamError('Camera not available here. The app must be opened over HTTPS in Safari or Chrome.');
  }
  cameraStarting = navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    })
    .then(async (s) => {
      if (document.hidden || screen === 'list') {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      $('video').srcObject = s;
      await $('video').play().catch(() => {});
    })
    .catch((err) => {
      showCamError(
        err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access for this app, then try again.'
          : `Camera error: ${err.message || err.name}`,
      );
    })
    .finally(() => (cameraStarting = null));
  return cameraStarting;
}

function stopCamera() {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('video').srcObject = null;
}

function showCamError(text) {
  $('cam-error-text').textContent = `${text} You can still add photos with the Photos button.`;
  $('cam-error').hidden = false;
}

function encodeJpeg(source, w, h) {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', JPEG_QUALITY),
  );
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => (URL.revokeObjectURL(url), resolve(img));
    img.onerror = () => (URL.revokeObjectURL(url), reject(new Error('Could not read that image')));
    img.src = url;
  });
}

// ---------- screens ----------
function setScreen(name) {
  screen = name;
  document.body.dataset.screen = name;
}

function goCamera() {
  // Called from a tap, so dictation is allowed to start here.
  setScreen('camera');
  dictation.reset();
  startCamera();
  dictation.start();
}

async function goList() {
  dictation.stop();
  dictation.reset();
  stopCamera();
  invalidateExport();
  setScreen('list'); // visible first, so descriptions can be sized to fit
  await renderList();
}

async function refreshCount() {
  $('count').textContent = await db.countReceipts();
}

async function savePhoto(blob, capturedAt) {
  currentId = await db.addReceipt({
    capturedAt,
    description: dictation.text,
    photo: await blob.arrayBuffer(),
    type: 'image/jpeg',
  });
  navigator.storage?.persist?.().catch(() => {});
  const n = await db.countReceipts();
  $('count').textContent = n;
  if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  reviewUrl = URL.createObjectURL(blob);
  $('review-img').src = reviewUrl;
  $('review-title').textContent = `Receipt ${n}`;
  $('review-text').value = dictation.text;
  setScreen('review');
}

async function onShutter() {
  if (busy) return;
  // The tap that takes the photo also turns the mic on if it isn't already.
  if (!dictation.active) dictation.start();
  const v = $('video');
  busy = true;
  try {
    // If the camera is still starting (e.g. just came back from the list), wait for it.
    if (cameraStarting) await cameraStarting;
    for (let t = 0; stream && !v.videoWidth && t < 3000; t += 50) await new Promise((r) => setTimeout(r, 50));
    if (!stream || !v.videoWidth) return toast('Camera not ready yet');
    const capturedAt = Date.now();
    await savePhoto(await encodeJpeg(v, v.videoWidth, v.videoHeight), capturedAt);
  } catch (err) {
    toast(err.message);
  } finally {
    busy = false;
  }
}

async function onFilePicked(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || busy) return;
  busy = true;
  try {
    const img = await loadImage(file);
    const blob = await encodeJpeg(img, img.naturalWidth, img.naturalHeight);
    await savePhoto(blob, Date.now());
  } catch (err) {
    toast(err.message);
  } finally {
    busy = false;
  }
}

// Leaves the review screen, saving the description. Returns the text that was saved.
function closeReview() {
  dictation.stop();
  const id = currentId;
  const text = $('review-text').value.trim();
  currentId = null;
  cancel(`desc-${id}`);
  return id == null ? Promise.resolve() : db.updateDescription(id, text);
}

async function onNext() {
  const saved = closeReview();
  goCamera(); // before any await, so the mic can start inside this tap
  await saved;
}

async function onDone() {
  await closeReview();
  await goList();
}

async function onRetake() {
  const id = currentId;
  currentId = null;
  cancel(`desc-${id}`);
  if (id != null) await db.deleteReceipt(id);
  await refreshCount();
  // Keep what was said: it still describes the receipt being re-shot.
  if (!dictation.active) dictation.setText($('review-text').value);
  renderCamText(dictation.text);
  setScreen('camera');
  startCamera();
  dictation.start();
}

function onMicToggle() {
  if (dictation.active) return dictation.stop();
  dictation.setText($('review-text').value);
  dictation.start();
}

// ---------- list ----------
function invalidateExport() {
  $('export').hidden = true;
}

async function renderList() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  const items = await db.listReceipts();
  const ol = $('items');
  ol.replaceChildren();
  $('empty').hidden = items.length > 0;
  $('make-zip').disabled = items.length === 0;
  $('new-trip').hidden = items.length === 0;

  items.forEach((r, i) => {
    const url = URL.createObjectURL(new Blob([r.photo], { type: r.type || 'image/jpeg' }));
    thumbUrls.push(url);

    const li = document.createElement('li');
    li.className = 'item';

    const thumb = document.createElement('button');
    thumb.className = 'thumb';
    thumb.setAttribute('aria-label', `View receipt ${i + 1}`);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    thumb.append(img);
    thumb.onclick = () => {
      $('viewer').querySelector('img').src = url;
      $('viewer').hidden = false;
    };

    const body = document.createElement('div');
    body.className = 'item-body';
    const head = document.createElement('div');
    head.className = 'item-head';
    const num = document.createElement('strong');
    num.textContent = `#${i + 1}`;
    const when = document.createElement('span');
    when.textContent = localStamp(new Date(r.capturedAt));
    head.append(num, when);

    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.value = r.description || '';
    ta.placeholder = 'No description';
    ta.oninput = () => {
      autosize(ta);
      invalidateExport();
      later(`desc-${r.id}`, () => db.updateDescription(r.id, ta.value.trim()));
    };

    const del = document.createElement('button');
    del.className = 'link-btn danger';
    del.textContent = 'Delete';
    del.style.alignSelf = 'flex-start';
    del.onclick = async () => {
      if (!confirm(`Delete receipt #${i + 1}?`)) return;
      cancel(`desc-${r.id}`);
      await db.deleteReceipt(r.id);
      invalidateExport();
      await refreshCount();
      await renderList();
    };

    body.append(head, ta, del);
    li.append(thumb, body);
    ol.append(li);
    autosize(ta);
  });
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

async function onMakeZip() {
  await flush();
  const items = await db.listReceipts();
  if (!items.length) return toast('No receipts yet');
  const { zipName, entries } = buildExport(items, { tripName: $('trip').value });
  const blob = makeZip(entries);
  exportFile = new File([blob], zipName, { type: 'application/zip' });
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = URL.createObjectURL(blob);
  $('download').href = exportUrl;
  $('download').download = zipName;
  $('export-info').textContent = `${zipName} · ${items.length} receipt${items.length === 1 ? '' : 's'} · ${formatSize(blob.size)}`;
  $('share').hidden = !(navigator.canShare && navigator.canShare({ files: [exportFile] }));
  $('export').hidden = false;
}

async function onShare() {
  try {
    await navigator.share({ files: [exportFile], title: exportFile.name });
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Share failed: ${err.message}`);
  }
}

async function onNewTrip() {
  const n = await db.countReceipts();
  if (!confirm(`Delete all ${n} receipts and start a new trip?\n\nMake sure you've saved the ZIP first.`)) return;
  cancelAll();
  await db.clearReceipts();
  await db.setMeta('tripName', '');
  $('trip').value = '';
  invalidateExport();
  await refreshCount();
  await renderList();
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 3000);
}

// ---------- wiring ----------
$('shutter').onclick = onShutter;
$('file-input').onchange = onFilePicked;
$('to-list').onclick = goList;
$('cam-retry').onclick = () => startCamera();
$('next').onclick = onNext;
$('done').onclick = onDone;
$('retake').onclick = onRetake;
$('mic-toggle').onclick = onMicToggle;
$('review-text').onfocus = () => dictation.stop(); // typing or keyboard dictation takes over
$('review-text').oninput = () => {
  const id = currentId;
  const text = $('review-text').value;
  if (id != null) later(`desc-${id}`, () => db.updateDescription(id, text.trim()));
};
$('add').onclick = goCamera;
$('make-zip').onclick = onMakeZip;
$('share').onclick = onShare;
$('new-trip').onclick = onNewTrip;
$('trip').oninput = () => {
  invalidateExport();
  const v = $('trip').value;
  later('trip', () => db.setMeta('tripName', v.trim()));
};
$('viewer').onclick = () => ($('viewer').hidden = true);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flush();
    dictation.stop();
    stopCamera();
  } else if (screen !== 'list') {
    startCamera();
    if (screen === 'camera') dictation.start();
  }
});

async function init() {
  renderMic();
  renderCamText('');
  $('trip').value = (await db.getMeta('tripName')) || '';
  await refreshCount();
  startCamera();
  // May need a tap on some browsers; the shutter tap starts it otherwise.
  dictation.start();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
