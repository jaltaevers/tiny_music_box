// A classic Winamp-style spectrum analyzer, drawn on a <canvas>. Four
// visual variants share the same signal-generation engine below:
// 'bar-strip' and 'ambient-backdrop' are the calm/subtle looks (the
// chunky LED-segment bars on the now-playing overlay, and a soft blurred
// glow behind the kid-mode tile grid, low-opacity enough that tiles on
// top stay perfectly legible); 'bar-strip-winamp' and 'winamp-backdrop'
// are their turned-up counterparts — bolder, faster-moving, color-cycling,
// mirrored, and throwing off sparkles on the loud peaks, the way classic
// Winamp/AVS presets never just sat still. A kid or parent can switch
// between them by tapping the visualizer toggle a second time, cycling
// off -> subtle -> winamp, the same click-to-cycle-visualization feel the
// real thing had.
//
// This does NOT analyze real audio: playback comes from a hidden, cross-
// origin YouTube <iframe> (see youtube-player.js) with no accessible
// <audio> element or MediaStream anywhere in this page's own DOM, so
// there's nothing a Web Audio AnalyserNode could ever be attached to — the
// IFrame Player API exposes playback control and state, not raw audio.
// Bars are driven by a synthetic signal — layered sine waves per bar plus
// a slowly wandering "energy" envelope — shaped to swell and settle the
// way a real spectrum does, and tied to actual play/pause state via
// setPlaying() so it goes quiet exactly when the music does.

const FRAME_INTERVAL_MS = 50; // ~20fps — plenty smooth for chunky bars, cheap on battery

const VARIANTS = {
  'bar-strip': {
    minBars: 16,
    maxBars: 48,
    pxPerBar: 14, // roughly how wide (css px) each bar+gap reads as
    barFillRatio: 0.72,
    heightRatio: 1, // bars can fill the full canvas height
    gradientStops: [
      [0, '#00e676'],
      [0.55, '#ffea00'],
      [0.8, '#ff9100'],
      [1, '#ff1744'],
    ],
    segmentStride: 5, // css px between LED-style gap lines
    segmentHeight: 1.5,
    peakCapHeight: 2,
    blurPx: 0,
  },
  // Same strip, same placement — but this is the one a kid actually taps
  // into on the second cycle, and it used to look *identical* to 'bar-strip'
  // regardless of mode, which made "winamp mode" nearly invisible on the
  // one surface that's on screen the whole time a song plays. Now it gets
  // its own turned-up treatment: fewer, chunkier bars, hue constantly
  // cycling, mirrored out from the center, and sparkles off the loud peaks.
  'bar-strip-winamp': {
    minBars: 10,
    maxBars: 26,
    pxPerBar: 20,
    barFillRatio: 0.8,
    heightRatio: 1,
    gradientStops: [
      [0, '#00e676'],
      [0.55, '#ffea00'],
      [0.8, '#ff9100'],
      [1, '#ff1744'],
    ],
    segmentStride: 5,
    segmentHeight: 1.5,
    peakCapHeight: 3,
    blurPx: 0,
    colorCycle: true,
    mirror: true,
    sparkles: true,
  },
  'ambient-backdrop': {
    minBars: 8,
    maxBars: 16,
    pxPerBar: 90,
    barFillRatio: 1.3, // > 1 so blurred columns overlap into one soft field instead of separate blobs
    heightRatio: 0.8, // leaves the top of the screen clear
    gradientStops: [
      [0, 'rgba(0, 230, 118, 0.4)'],
      [0.55, 'rgba(255, 234, 0, 0.32)'],
      [0.8, 'rgba(255, 145, 0, 0.28)'],
      [1, 'rgba(255, 23, 68, 0.22)'],
    ],
    segmentStride: 0, // no LED segmentation — a smooth glow, not a readout
    segmentHeight: 0,
    peakCapHeight: 0, // no peak caps — too fine a detail once blurred
    blurPx: 36,
  },
  // Same placement as ambient-backdrop (behind the grid, z-index unchanged)
  // but turned up rather than washed out: more, narrower bars, nearly
  // opaque, and only lightly blurred — reads as an actual visualizer
  // filling the screen instead of a mood-lighting glow. Tiles stay tappable
  // regardless of intensity since they sit on their own opaque layer above
  // this one; it's only ever visible in the gaps and empty space around them.
  'winamp-backdrop': {
    minBars: 14,
    maxBars: 28,
    pxPerBar: 46,
    barFillRatio: 1.1,
    heightRatio: 0.98,
    gradientStops: [
      [0, 'rgba(0, 230, 118, 0.88)'],
      [0.55, 'rgba(255, 234, 0, 0.8)'],
      [0.8, 'rgba(255, 145, 0, 0.75)'],
      [1, 'rgba(255, 23, 68, 0.7)'],
    ],
    segmentStride: 0,
    segmentHeight: 0,
    peakCapHeight: 0,
    blurPx: 10,
    colorCycle: true,
    mirror: true,
    sparkles: true,
  },
};

const PEAK_FALL_PER_SEC = 0.7; // fraction of full height per second
const HUE_CYCLE_DEG_PER_SEC = 30; // ~12s for a full color rotation — lively, not seizure-fast
const SPARKLE_LIFE_SEC = 0.7;

export function createVisualizer({ canvas, variant = 'bar-strip' }) {
  let currentVariant = variant;
  let cfg = VARIANTS[currentVariant];
  const ctx = canvas.getContext('2d');

  let cssWidth = 0;
  let cssHeight = 0;
  let bars = [];
  let gradient = null;
  let particles = [];
  let playing = false;
  let envelope = 0;
  let energyPhase = Math.random() * Math.PI * 2;
  let t = 0;
  let rafHandle = null;
  let lastFrameAt = 0;

  function makeBar() {
    return {
      freq1: 1.1 + Math.random() * 1.6,
      freq2: 2.3 + Math.random() * 2.7,
      phase1: Math.random() * Math.PI * 2,
      phase2: Math.random() * Math.PI * 2,
      value: 0,
      peak: 0,
    };
  }

  // How many bars fit is still driven by pxPerBar against the real width,
  // but a mirrored variant only ever generates half that many *distinct*
  // signals — the other half of the screen just mirrors them — so the
  // visual density matches non-mirrored variants instead of doubling it.
  function slotCount() {
    const total = Math.max(cfg.minBars, Math.min(cfg.maxBars, Math.round(cssWidth / cfg.pxPerBar)));
    return cfg.mirror ? Math.max(2, Math.round(total / 2)) * 2 : total;
  }

  // Resolves bar index i (0-based within `bars`, the generated-signal half)
  // to the x position(s) it actually draws at: one for a normal layout,
  // two — mirrored left/right from center — for cfg.mirror.
  function slotX(i, stride, barWidth, totalSlots) {
    if (!cfg.mirror) return [i * stride + (stride - barWidth) / 2];
    const half = totalSlots / 2;
    return [(half + i) * stride + (stride - barWidth) / 2, (half - 1 - i) * stride + (stride - barWidth) / 2];
  }

  // Reads the canvas's actual on-screen size so bar count/spacing scales
  // with it (a phone-width overlay and a tablet-width one shouldn't render
  // the same fixed bar count) and so drawing can happen in crisp css-pixel
  // coordinates on high-DPI screens instead of a blurry stretched bitmap.
  function resizeToDisplaySize() {
    // clientWidth/clientHeight (unlike getBoundingClientRect, which reports
    // the visually transformed box) reflect the untransformed layout size —
    // important here since start() calls this right as the panel un-hides,
    // the same moment its scaleY() entrance animation begins at 0.
    cssWidth = Math.max(1, canvas.clientWidth);
    cssHeight = Math.max(1, canvas.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const totalSlots = slotCount();
    const barCount = cfg.mirror ? totalSlots / 2 : totalSlots;
    bars = Array.from({ length: barCount }, makeBar);
    particles = [];

    const drawHeight = cssHeight * cfg.heightRatio;
    gradient = ctx.createLinearGradient(0, cssHeight, 0, cssHeight - drawHeight);
    for (const [stop, color] of cfg.gradientStops) gradient.addColorStop(stop, color);
  }

  function step(dt) {
    t += dt;
    energyPhase += dt * 0.6;
    // A slow, non-repeating-feeling "loudness" wander so bars have quiet
    // and loud passages instead of a constant hum. Settles toward 0 (bars
    // fall flat) whenever nothing's actually playing.
    const targetEnvelope = playing ? 0.5 + 0.5 * Math.max(0, 0.6 * Math.sin(energyPhase) + 0.4 * Math.sin(energyPhase * 2.3 + 1.2)) : 0;
    envelope += (targetEnvelope - envelope) * Math.min(1, dt * (playing ? 2.2 : 5));

    for (const bar of bars) {
      const wobble = 0.5 + 0.5 * (0.6 * Math.sin(t * bar.freq1 + bar.phase1) + 0.4 * Math.sin(t * bar.freq2 + bar.phase2));
      const target = Math.max(0, Math.min(1, wobble)) * envelope;
      bar.value += (target - bar.value) * Math.min(1, dt * 9);
      bar.peak = bar.value > bar.peak ? bar.value : Math.max(bar.value, bar.peak - dt * PEAK_FALL_PER_SEC);
    }

    if (particles.length) {
      for (const p of particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt / SPARKLE_LIFE_SEC;
      }
      particles = particles.filter((p) => p.life > 0);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (!bars.length) return;

    const drawHeight = cssHeight * cfg.heightRatio;
    const totalSlots = cfg.mirror ? bars.length * 2 : bars.length;
    const stride = cssWidth / totalSlots;
    const barWidth = Math.max(1, stride * cfg.barFillRatio);

    ctx.save();
    const filters = [];
    if (cfg.blurPx) filters.push(`blur(${cfg.blurPx}px)`);
    // Constantly rotating the whole fill's hue — rather than redefining the
    // gradient's colors every frame — is what real AVS/MilkDrop presets do
    // to feel alive even when the "music" itself is steady: the shapes
    // barely change, but the palette never sits still.
    if (cfg.colorCycle) filters.push(`hue-rotate(${(t * HUE_CYCLE_DEG_PER_SEC) % 360}deg)`);
    if (filters.length) ctx.filter = filters.join(' ');
    ctx.fillStyle = gradient;
    bars.forEach((bar, i) => {
      const h = bar.value * drawHeight;
      if (h <= 0) return;
      for (const x of slotX(i, stride, barWidth, totalSlots)) {
        ctx.fillRect(x, cssHeight - h, barWidth, h);
        // Sparks off a bar right as it's near its own peak — sparse enough
        // (checked once per bar per frame) to read as occasional glints,
        // not a constant snowstorm.
        if (cfg.sparkles && bar.value > 0.82 && Math.random() < 0.05) {
          particles.push({
            x: x + barWidth / 2,
            y: cssHeight - h,
            vx: (Math.random() - 0.5) * 50,
            vy: -60 - Math.random() * 70,
            life: 1,
            size: 1.5 + Math.random() * 2,
          });
        }
      }
    });
    ctx.restore();

    // Cuts transparent gap lines across the filled bars so they read as
    // segmented LED blocks instead of solid columns. Skipped for variants
    // with no segmentStride (a soft glow has no business looking like a
    // readout).
    if (cfg.segmentStride) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      for (let y = cssHeight - cfg.segmentStride; y > 0; y -= cfg.segmentStride) {
        ctx.fillRect(0, y, cssWidth, cfg.segmentHeight);
      }
      ctx.restore();
    }

    if (cfg.peakCapHeight) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      bars.forEach((bar, i) => {
        if (bar.peak <= 0) return;
        const peakY = Math.max(0, cssHeight - bar.peak * drawHeight - cfg.peakCapHeight);
        for (const x of slotX(i, stride, barWidth, totalSlots)) {
          ctx.fillRect(x, peakY, barWidth, cfg.peakCapHeight);
        }
      });
    }

    if (particles.length) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function loop(now) {
    rafHandle = requestAnimationFrame(loop);
    if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
    const dt = lastFrameAt ? Math.min(0.25, (now - lastFrameAt) / 1000) : FRAME_INTERVAL_MS / 1000;
    lastFrameAt = now;
    step(dt);
    draw();
  }

  return {
    start() {
      if (rafHandle) return;
      resizeToDisplaySize();
      lastFrameAt = 0;
      rafHandle = requestAnimationFrame(loop);
    },
    stop() {
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = null;
      if (cssWidth && cssHeight) ctx.clearRect(0, 0, cssWidth, cssHeight);
    },
    // Re-measures the canvas's on-screen size — call after a resize/rotate
    // so bar spacing keeps matching the actual layout. Cheap no-op if the
    // panel is currently hidden (display:none reads back a 0×0 rect).
    handleResize() {
      if (rafHandle) resizeToDisplaySize();
    },
    // Switches which VARIANTS entry this instance draws with (e.g. the
    // background canvas cycling 'ambient-backdrop' -> 'winamp-backdrop').
    // Rebuilds bars/gradient immediately if currently running, since each
    // variant has its own bar count/sizing — same as a resize does.
    setVariant(newVariant) {
      if (!VARIANTS[newVariant] || newVariant === currentVariant) return;
      currentVariant = newVariant;
      cfg = VARIANTS[currentVariant];
      particles = [];
      if (rafHandle) resizeToDisplaySize();
    },
    setPlaying(isPlaying) {
      playing = !!isPlaying;
    },
  };
}
