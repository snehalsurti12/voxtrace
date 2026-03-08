/**
 * audioCodec.mjs — Audio format conversion for NL Caller
 *
 * Handles conversion between:
 *  - Twilio Stream: mulaw 8kHz (base64-encoded)
 *  - Gemini Live API: PCM 16-bit 16kHz mono (input), PCM 16-bit 24kHz mono (output)
 *  - Local STT (Whisper): PCM 16-bit 16kHz mono
 *  - Local TTS (Piper): PCM 16-bit 22050Hz mono
 *
 * All conversions are pure math — no FFmpeg or external deps needed.
 */

// ── mulaw codec tables ──────────────────────────────────────────────

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Precomputed mulaw-to-linear lookup (256 entries). */
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  mantissa = ((mantissa << 1) + 33) << (exponent + 2);
  mantissa -= MULAW_BIAS;
  MULAW_DECODE_TABLE[i] = sign ? -mantissa : mantissa;
}

/**
 * Encode a single 16-bit PCM sample to mulaw byte.
 * @param {number} sample — signed 16-bit integer (-32768..32767)
 * @returns {number} mulaw byte (0..255)
 */
export function encodeMulaw(sample) {
  const sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  const mask = 0x4000;
  for (; exponent > 0; exponent--) {
    if (sample & (mask >> (7 - exponent))) break;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Decode a single mulaw byte to 16-bit PCM sample.
 * @param {number} byte — mulaw byte (0..255)
 * @returns {number} signed 16-bit integer
 */
export function decodeMulaw(byte) {
  return MULAW_DECODE_TABLE[byte & 0xff];
}

// ── Buffer conversions ──────────────────────────────────────────────

/**
 * Decode mulaw buffer to PCM 16-bit buffer (same sample rate).
 * @param {Buffer} mulawBuf — mulaw audio bytes
 * @returns {Buffer} PCM 16-bit LE buffer
 */
export function mulawToPcm(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulawBuf[i]], i * 2);
  }
  return pcm;
}

/**
 * Encode PCM 16-bit buffer to mulaw buffer (same sample rate).
 * @param {Buffer} pcmBuf — PCM 16-bit LE buffer
 * @returns {Buffer} mulaw audio bytes
 */
export function pcmToMulaw(pcmBuf) {
  const numSamples = Math.floor(pcmBuf.length / 2);
  const mulaw = Buffer.alloc(numSamples);
  for (let i = 0; i < numSamples; i++) {
    mulaw[i] = encodeMulaw(pcmBuf.readInt16LE(i * 2));
  }
  return mulaw;
}

// ── Sample rate conversion (linear interpolation) ───────────────────

/**
 * Resample PCM 16-bit buffer from one rate to another.
 * Uses linear interpolation — sufficient for speech audio.
 *
 * @param {Buffer} pcmBuf — PCM 16-bit LE input buffer
 * @param {number} fromRate — source sample rate (e.g. 8000)
 * @param {number} toRate — target sample rate (e.g. 16000)
 * @returns {Buffer} resampled PCM 16-bit LE buffer
 */
export function resamplePcm(pcmBuf, fromRate, toRate) {
  if (fromRate === toRate) return pcmBuf;

  const numInputSamples = Math.floor(pcmBuf.length / 2);
  const ratio = fromRate / toRate;
  const numOutputSamples = Math.ceil(numInputSamples / ratio);
  const out = Buffer.alloc(numOutputSamples * 2);

  for (let i = 0; i < numOutputSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = pcmBuf.readInt16LE(Math.min(srcIdx, numInputSamples - 1) * 2);
    const s1 = pcmBuf.readInt16LE(Math.min(srcIdx + 1, numInputSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));

    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

// ── High-level conversion helpers ───────────────────────────────────

/**
 * Convert Twilio mulaw 8kHz base64 → PCM 16kHz buffer (for Gemini/Whisper input).
 * @param {string} base64Mulaw — base64-encoded mulaw audio from Twilio Stream
 * @returns {Buffer} PCM 16-bit 16kHz mono buffer
 */
export function twilioToGeminiInput(base64Mulaw) {
  const mulawBuf = Buffer.from(base64Mulaw, "base64");
  const pcm8k = mulawToPcm(mulawBuf);
  return resamplePcm(pcm8k, 8000, 16000);
}

/**
 * Convert Gemini output PCM 24kHz → Twilio mulaw 8kHz base64.
 * @param {Buffer} pcm24k — PCM 16-bit 24kHz buffer from Gemini Live API
 * @returns {string} base64-encoded mulaw audio for Twilio Stream
 */
export function geminiOutputToTwilio(pcm24k) {
  const pcm8k = resamplePcm(pcm24k, 24000, 8000);
  const mulaw = pcmToMulaw(pcm8k);
  return mulaw.toString("base64");
}

/**
 * Convert local TTS output (various rates) → Twilio mulaw 8kHz base64.
 * @param {Buffer} pcmBuf — PCM 16-bit buffer from TTS
 * @param {number} sampleRate — TTS output sample rate (e.g. 22050 for Piper)
 * @returns {string} base64-encoded mulaw audio for Twilio Stream
 */
export function ttsOutputToTwilio(pcmBuf, sampleRate) {
  const pcm8k = resamplePcm(pcmBuf, sampleRate, 8000);
  const mulaw = pcmToMulaw(pcm8k);
  return mulaw.toString("base64");
}

/**
 * Convert Twilio mulaw 8kHz base64 → PCM 16kHz base64 (for Gemini).
 * Gemini Live API expects base64-encoded PCM.
 * @param {string} base64Mulaw — base64-encoded mulaw from Twilio
 * @returns {string} base64-encoded PCM 16kHz for Gemini
 */
export function twilioToGeminiBase64(base64Mulaw) {
  const pcm16k = twilioToGeminiInput(base64Mulaw);
  return pcm16k.toString("base64");
}

/**
 * Convert Gemini output base64 PCM 24kHz → Twilio mulaw 8kHz base64.
 * @param {string} base64Pcm24k — base64-encoded PCM 24kHz from Gemini
 * @returns {string} base64-encoded mulaw for Twilio Stream
 */
export function geminiBase64ToTwilio(base64Pcm24k) {
  const pcm24k = Buffer.from(base64Pcm24k, "base64");
  return geminiOutputToTwilio(pcm24k);
}
