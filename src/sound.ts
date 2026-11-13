const SINGLE_REVEAL_CELLS = 1;
const SINGLE_REVEAL_FREQUENCY_HZ = 1200;
const SINGLE_REVEAL_DURATION_MS = 70;
const BIG_FLOOD_CELLS = 40;
const BIG_FLOOD_FREQUENCY_HZ = 350;
const BIG_FLOOD_DURATION_MS = 200;
const RUMBLE_CELLS = 10;
const NOISE_BUFFER_SECONDS = 0.5;

export interface RevealCrunch {
  frequencyHz: number;
  durationMs: number;
  rumble: boolean;
}

export function revealCrunchParams(cellCount: number): RevealCrunch {
  const spread =
    (Math.min(cellCount, BIG_FLOOD_CELLS) - SINGLE_REVEAL_CELLS) /
    (BIG_FLOOD_CELLS - SINGLE_REVEAL_CELLS);
  const frequencyHz = Math.round(
    SINGLE_REVEAL_FREQUENCY_HZ *
      Math.pow(BIG_FLOOD_FREQUENCY_HZ / SINGLE_REVEAL_FREQUENCY_HZ, spread),
  );
  return {
    frequencyHz,
    durationMs: Math.round(
      SINGLE_REVEAL_DURATION_MS +
        (BIG_FLOOD_DURATION_MS - SINGLE_REVEAL_DURATION_MS) * spread,
    ),
    rumble: cellCount >= RUMBLE_CELLS,
  };
}

let audioContext: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

// why: the autoplay policy only allows creating or resuming a context
// inside a user-gesture handler; every play* call originates from one
function getContext(): AudioContext | null {
  try {
    const scope = globalThis as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!ctor) return null;
    const context = (audioContext ??= new ctor());
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
    }
    return context;
  } catch {
    return null;
  }
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  noiseBuffer ??= createNoiseBuffer(context);
  return noiseBuffer;
}

function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const buffer = context.createBuffer(
    1,
    context.sampleRate * NOISE_BUFFER_SECONDS,
    context.sampleRate,
  );
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function playNoiseBurst(
  context: AudioContext,
  filterType: BiquadFilterType,
  startHz: number,
  endHz: number,
  durationMs: number,
  volume: number,
): void {
  const seconds = durationMs / 1000;
  const now = context.currentTime;
  const source = context.createBufferSource();
  source.buffer = getNoiseBuffer(context);
  const filter = context.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(startHz, now);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(endHz, 1),
    now + seconds,
  );
  const gain = context.createGain();
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + seconds);
  source.connect(filter).connect(gain).connect(context.destination);
  source.start(now);
  source.stop(now + seconds);
}

function playTone(
  context: AudioContext,
  type: OscillatorType,
  startHz: number,
  endHz: number,
  durationMs: number,
  volume: number,
): void {
  const seconds = durationMs / 1000;
  const now = context.currentTime;
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(startHz, now);
  oscillator.frequency.exponentialRampToValueAtTime(
    Math.max(endHz, 1),
    now + seconds,
  );
  const gain = context.createGain();
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + seconds);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + seconds);
}

export function playFlagSound(placing: boolean): void {
  const context = getContext();
  if (!context) return;
  if (placing) {
    playNoiseBurst(context, "bandpass", 900, 500, 60, 0.5);
    playTone(context, "triangle", 300, 150, 90, 0.25);
  } else {
    playNoiseBurst(context, "bandpass", 1600, 2200, 45, 0.3);
    playTone(context, "triangle", 500, 800, 60, 0.15);
  }
}

export function playRevealSound(cellCount: number): void {
  const context = getContext();
  if (!context) return;
  const crunch = revealCrunchParams(cellCount);
  playNoiseBurst(
    context,
    "bandpass",
    crunch.frequencyHz,
    crunch.frequencyHz / 2,
    crunch.durationMs,
    0.4,
  );
  playTone(context, "sine", 500, 200, crunch.durationMs, 0.15);
  if (crunch.rumble) {
    playNoiseBurst(context, "lowpass", 300, 80, crunch.durationMs * 2, 0.5);
  }
}

// why: the free cell is a rescue, not terrain being uncovered — a rising
// glide tells it apart from the reveal crunch and the flag thunk
export function playFreeCellSound(): void {
  const context = getContext();
  if (!context) return;
  playTone(context, "sine", 500, 900, 150, 0.18);
}

export function playLossSound(): void {
  const context = getContext();
  if (!context) return;
  playNoiseBurst(context, "lowpass", 3000, 80, 1200, 0.7);
  playTone(context, "sine", 150, 30, 600, 0.5);
}
