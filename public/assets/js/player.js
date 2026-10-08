'use strict';
/*
 * Powerful, smooth media player for the drive.
 *
 * Built on the native <video>/<audio> element so playback rides on HTTP Range
 * requests (206 Partial Content) served by /api/fs/{mount}/preview — the browser
 * streams and seeks a multi-GB file without downloading it whole. This module
 * adds a real control surface on top: a scrub-able seek bar with a live buffered
 * indicator, volume, playback speed, skip, fullscreen, Picture-in-Picture,
 * keyboard shortcuts, auto-hiding controls and explicit buffering/error states.
 *
 * No external dependencies; teardown is explicit so the preview modal can unmount
 * it cleanly (removing listeners and stopping network activity).
 */
import { el } from './util.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const ICON = {
  play: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M13 6v12l8.5-6L13 6zM4 18l8.5-6L4 6v12z"/></svg>',
  vol: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  mute: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3 10v4h4l5 5V5L7 10H3zm15.5-1.1-1.4 1.4L18.7 12l-1.6 1.7 1.4 1.4L20.1 13.4 21.7 15l1.4-1.4L21.5 12l1.6-1.6-1.4-1.4L20.1 10.6 18.5 8.9z"/></svg>',
  pip: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M19 11h-8v6h8v-6zm2-8H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z"/></svg>',
  fs: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  dl: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M5 20h14v-2H5v2zM12 3v10.6l3.3-3.3 1.4 1.4L12 17.4 6.3 11.7l1.4-1.4L11 13.6V3z"/></svg>',
  music: '<svg viewBox="0 0 24 24" width="72" height="72" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
};

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Build a media player for a drive entry.
 *
 * @param {object}  opts
 * @param {string}  opts.url         stream URL (Range-capable preview endpoint)
 * @param {string}  [opts.downloadUrl] URL for the download button
 * @param {boolean} [opts.isAudio]
 * @param {string}  [opts.title]
 * @returns {{node: HTMLElement, destroy: () => void}}
 */
export function buildMediaPlayer(opts) {
  const isAudio = !!opts.isAudio;
  const media = el(isAudio ? 'audio' : 'video', {
    class: 'mp-media',
    src: opts.url,
    preload: 'metadata',
    playsinline: true,
  });
  if (!isAudio) media.setAttribute('playsinline', '');
  media.volume = 1;

  const spinner = el('div', { class: 'mp-spinner', html: '<div class="mp-ring"></div>' });
  const bigPlay = el('button', { class: 'mp-bigplay', html: ICON.play, title: 'Play' });
  const errorBox = el('div', { class: 'mp-error', style: 'display:none' });
  const audioArt = isAudio ? el('div', { class: 'mp-audio-art', html: ICON.music }) : null;

  const stage = el('div', { class: 'mp-stage' },
    audioArt,
    media,
    spinner,
    errorBox,
    bigPlay,
  );

  // --- seek bar -------------------------------------------------------------
  const buf = el('div', { class: 'mp-buf' });
  const prog = el('div', { class: 'mp-prog' });
  const knob = el('div', { class: 'mp-knob' });
  const seek = el('div', { class: 'mp-seek', role: 'slider', tabindex: '0' }, buf, prog, knob);

  // --- control row ----------------------------------------------------------
  const playBtn = el('button', { class: 'mp-btn', html: ICON.play, title: 'Play/Pause (Space)' });
  const backBtn = el('button', { class: 'mp-btn', html: ICON.back, title: 'Back 10s (←)' });
  const fwdBtn = el('button', { class: 'mp-btn', html: ICON.fwd, title: 'Forward 10s (→)' });
  const timeEl = el('span', { class: 'mp-time', text: '0:00 / 0:00' });

  const volIcon = el('button', { class: 'mp-btn', html: ICON.vol, title: 'Mute (m)' });
  const vol = el('input', { class: 'mp-vol', type: 'range', min: '0', max: '1', step: '0.01', value: '1' });
  const speedBtn = el('button', { class: 'mp-btn mp-speed', text: '1×', title: 'Playback speed' });
  const pipBtn = isAudio ? null : el('button', { class: 'mp-btn', html: ICON.pip, title: 'Picture-in-Picture' });
  const fsBtn = isAudio ? null : el('button', { class: 'mp-btn', html: ICON.fs, title: 'Fullscreen (f)' });
  const dlBtn = opts.downloadUrl
    ? el('a', { class: 'mp-btn', html: ICON.dl, title: 'Download', href: opts.downloadUrl, download: opts.title || '' })
    : null;

  const row = el('div', { class: 'mp-row' },
    playBtn, backBtn, fwdBtn, timeEl,
    el('span', { class: 'mp-spacer' }),
    volIcon, vol, speedBtn, pipBtn, fsBtn, dlBtn,
  );
  const controls = el('div', { class: 'mp-controls' }, seek, row);

  const root = el('div', { class: 'mp' + (isAudio ? ' mp-audio' : '') }, stage, controls);

  // --- state helpers --------------------------------------------------------
  let speedIdx = SPEEDS.indexOf(1);
  let hideTimer = null;

  const setPlayIcon = () => {
    const playing = !media.paused && !media.ended;
    playBtn.innerHTML = playing ? ICON.pause : ICON.play;
    bigPlay.style.display = playing ? 'none' : '';
  };
  const showSpinner = (on) => { spinner.style.display = on ? '' : 'none'; };

  function updateProgress() {
    const d = media.duration;
    const pct = isFinite(d) && d > 0 ? (media.currentTime / d) * 100 : 0;
    prog.style.width = pct + '%';
    knob.style.left = pct + '%';
    timeEl.textContent = `${fmtTime(media.currentTime)} / ${fmtTime(d)}`;
    // Buffered range ahead of the playhead.
    let end = 0;
    try {
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= media.currentTime && media.currentTime <= media.buffered.end(i)) {
          end = media.buffered.end(i);
          break;
        }
        end = Math.max(end, media.buffered.end(i));
      }
    } catch (_) { /* buffered can throw before metadata */ }
    buf.style.width = (isFinite(d) && d > 0 ? (end / d) * 100 : 0) + '%';
  }

  function seekToFraction(f) {
    f = Math.max(0, Math.min(1, f));
    if (isFinite(media.duration) && media.duration > 0) {
      media.currentTime = f * media.duration;
    }
  }

  function toggle() {
    if (media.paused) {
      const p = media.play();
      if (p && p.catch) p.catch((err) => showError(err && err.message));
    } else {
      media.pause();
    }
  }
  function skip(delta) {
    if (!isFinite(media.duration)) return;
    media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + delta));
  }
  function showError(msg) {
    errorBox.style.display = '';
    errorBox.textContent = 'Playback failed: ' + (msg || 'this format may not be supported by your browser.');
    showSpinner(false);
  }

  function cycleSpeed() {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    media.playbackRate = SPEEDS[speedIdx];
    speedBtn.textContent = SPEEDS[speedIdx] + '×';
  }

  function scheduleHide() {
    root.classList.remove('mp-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!media.paused && !media.ended) root.classList.add('mp-idle');
    }, 2600);
  }

  // --- wire controls --------------------------------------------------------
  playBtn.onclick = toggle;
  bigPlay.onclick = toggle;
  backBtn.onclick = () => skip(-10);
  fwdBtn.onclick = () => skip(10);
  speedBtn.onclick = cycleSpeed;
  volIcon.onclick = () => { media.muted = !media.muted; syncVolume(); };
  vol.oninput = () => { media.volume = Number(vol.value); media.muted = media.volume === 0; syncVolume(); };
  function syncVolume() {
    vol.value = media.muted ? '0' : String(media.volume);
    volIcon.innerHTML = (media.muted || media.volume === 0) ? ICON.mute : ICON.vol;
  }
  if (pipBtn) {
    pipBtn.onclick = async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else if (media.requestPictureInPicture) await media.requestPictureInPicture();
      } catch (_) { /* unsupported */ }
    };
  }
  if (fsBtn) {
    fsBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    };
  }

  // Scrub the seek bar with pointer events (works for mouse + touch).
  let scrubbing = false;
  const fracFromEvent = (e) => {
    const r = seek.getBoundingClientRect();
    return r.width > 0 ? (e.clientX - r.left) / r.width : 0;
  };
  seek.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    try { seek.setPointerCapture(e.pointerId); } catch (_) {}
    seekToFraction(fracFromEvent(e));
  });
  seek.addEventListener('pointermove', (e) => { if (scrubbing) seekToFraction(fracFromEvent(e)); });
  const endScrub = (e) => { scrubbing = false; try { seek.releasePointerCapture(e.pointerId); } catch (_) {} };
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('pointercancel', endScrub);

  // --- media events ---------------------------------------------------------
  media.addEventListener('loadedmetadata', updateProgress);
  media.addEventListener('durationchange', updateProgress);
  media.addEventListener('timeupdate', updateProgress);
  media.addEventListener('progress', updateProgress);
  media.addEventListener('play', () => { setPlayIcon(); scheduleHide(); });
  media.addEventListener('playing', () => { showSpinner(false); setPlayIcon(); });
  media.addEventListener('pause', () => { setPlayIcon(); root.classList.remove('mp-idle'); });
  media.addEventListener('ended', () => { setPlayIcon(); root.classList.remove('mp-idle'); });
  media.addEventListener('waiting', () => showSpinner(true));
  media.addEventListener('stalled', () => showSpinner(true));
  media.addEventListener('canplay', () => showSpinner(false));
  media.addEventListener('seeking', () => showSpinner(true));
  media.addEventListener('seeked', () => { showSpinner(false); updateProgress(); });
  media.addEventListener('error', () => showError(media.error && media.error.message));
  media.addEventListener('click', toggle);

  root.addEventListener('pointermove', scheduleHide);
  root.addEventListener('pointerleave', () => { if (!media.paused) root.classList.add('mp-idle'); });

  // --- keyboard shortcuts ---------------------------------------------------
  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); toggle(); }
    else if (k === 'ArrowRight') { e.preventDefault(); skip(5); }
    else if (k === 'ArrowLeft') { e.preventDefault(); skip(-5); }
    else if (k === 'ArrowUp') { e.preventDefault(); media.volume = Math.min(1, media.volume + 0.05); media.muted = false; syncVolume(); }
    else if (k === 'ArrowDown') { e.preventDefault(); media.volume = Math.max(0, media.volume - 0.05); syncVolume(); }
    else if (k === 'm' || k === 'M') { media.muted = !media.muted; syncVolume(); }
    else if ((k === 'f' || k === 'F') && fsBtn) { fsBtn.onclick(); }
    else if (k === 'j' || k === 'J') { skip(-10); }
    else if (k === 'l' || k === 'L') { skip(10); }
    else if (k >= '0' && k <= '9' && isFinite(media.duration)) { seekToFraction(Number(k) / 10); }
    scheduleHide();
  }
  document.addEventListener('keydown', onKey);

  // Autoplay the first frame's metadata-driven UI; do not force autoplay.
  showSpinner(true);
  setTimeout(() => { if (media.readyState >= 3) showSpinner(false); }, 0);

  function destroy() {
    clearTimeout(hideTimer);
    document.removeEventListener('keydown', onKey);
    try { media.pause(); } catch (_) {}
    try { media.removeAttribute('src'); media.load(); } catch (_) {} // stop the network
  }

  return { node: root, destroy };
}
