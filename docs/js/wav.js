// Decode the working audio once and keep the AudioBuffer in memory, for the
// waveform and for the client-side VAD pass over the whole clip.

let _buffer = null;
let _decoding = null;

function audioCtx(sampleRate) {
  const AC = window.AudioContext || window.webkitAudioContext;
  return sampleRate ? new AC({ sampleRate }) : new AC();
}

// `sampleRate` (optional) makes the decode resample to that rate: an hour of 16 kHz speech then
// takes ~230 MB instead of ~700 MB at the usual 48 kHz (library mode passes 16000).
export async function loadAudio(blob, { sampleRate } = {}) {
  _buffer = null;
  const arrayBuf = await blob.arrayBuffer();
  const ctx = audioCtx(sampleRate);
  _decoding = new Promise((resolve, reject) => {
    // callback form for the widest browser support
    ctx.decodeAudioData(arrayBuf.slice(0), (buf) => resolve(buf), (err) => reject(err));
  });
  _buffer = await _decoding;
  try { ctx.close(); } catch {}
  return { duration: _buffer.duration, sampleRate: _buffer.sampleRate };
}

export function hasAudio() {
  return !!_buffer;
}

export function getDuration() {
  return _buffer ? _buffer.duration : 0;
}

function downmixMono(buffer, startSample, endSample) {
  const len = Math.max(0, endSample - startSample);
  const out = new Float32Array(len);
  const chans = buffer.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[startSample + i] / chans;
  }
  return out;
}

// The whole clip, downmixed to mono, at its native sample rate - what the
// client-side VAD library needs (it resamples to 16kHz internally).
export function getMonoSamples() {
  if (!_buffer) return null;
  return { data: downmixMono(_buffer, 0, _buffer.length), sampleRate: _buffer.sampleRate };
}
