/**
 * IVR Transcriber — Post-hoc Whisper transcription of IVR audio recordings.
 *
 * Uses @xenova/transformers (Whisper ONNX) for fully local transcription.
 * No API calls, no cloud dependency.
 *
 * Usage:
 *   node scripts/ivr-transcriber.mjs <ivr-audio.webm> [--output <dir>]
 *
 * Or import as a module:
 *   import { transcribeIvrAudio, generateAuditTrail } from "./scripts/ivr-transcriber.mjs";
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ── FFmpeg path resolution (reused from other scripts) ─────────────────────

function resolveFFmpeg() {
  const sys = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  for (const p of sys) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const mod = await import("ffmpeg-static");
    const staticPath = mod.default ?? mod;
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch {
    // ffmpeg-static not installed
  }
  return null;
}

// ── Audio conversion ───────────────────────────────────────────────────────

/**
 * Convert WebM audio to WAV (16 kHz mono) for Whisper.
 * Returns the path to the WAV file.
 */
export function convertToWav(inputPath, outputDir) {
  const ffmpeg = resolveFFmpeg();
  if (!ffmpeg) {
    throw new Error(
      "FFmpeg is required for audio conversion but was not found. " +
        "Install FFmpeg or add ffmpeg-static to your dependencies."
    );
  }

  const wavPath = path.join(
    outputDir || path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)) + ".wav"
  );

  execFileSync(ffmpeg, [
    "-y",
    "-i", inputPath,
    "-ar", "16000",    // 16 kHz sample rate (Whisper expects this)
    "-ac", "1",        // Mono
    "-f", "wav",
    wavPath,
  ], { stdio: "pipe" });

  return wavPath;
}

// ── Whisper transcription ──────────────────────────────────────────────────

let _pipeline = null;

async function getTranscriber() {
  if (_pipeline) return _pipeline;

  let transformers;
  try {
    transformers = await import("@xenova/transformers");
  } catch {
    throw new Error(
      "@xenova/transformers is not installed. Install it to enable IVR transcription:\n" +
        "  npm install @xenova/transformers\n" +
        "The first run will download the Whisper model (~40 MB for tiny)."
    );
  }

  const { pipeline } = transformers;
  _pipeline = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
    // Use quantized model for smaller download + faster inference
    quantized: true,
  });
  return _pipeline;
}

/**
 * Transcribe IVR audio using Whisper.
 *
 * @param {string} audioPath - Path to audio file (WebM or WAV).
 * @returns {{ text: string, chunks: Array<{ text: string, timestamp: [number, number] }> }}
 */
export async function transcribeIvrAudio(audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  // Convert to WAV if not already
  let wavPath = audioPath;
  if (!audioPath.endsWith(".wav")) {
    wavPath = convertToWav(audioPath, path.dirname(audioPath));
  }

  const transcriber = await getTranscriber();
  const result = await transcriber(wavPath, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  // Clean up temp WAV if we converted
  if (wavPath !== audioPath) {
    fs.rmSync(wavPath, { force: true });
  }

  return {
    text: result.text?.trim() ?? "",
    chunks: result.chunks ?? [],
  };
}

// ── Audit trail generation ─────────────────────────────────────────────────

/**
 * Generate an IVR audit trail by correlating DTMF navigation results
 * with Whisper transcript chunks.
 *
 * @param {object} ivrResult - IvrNavigationResult from ivrSpeechDetector.
 * @param {{ text: string, chunks: Array<{ text: string, timestamp: [number, number] }> }} transcript
 * @returns {object} Audit trail with matched expectations.
 */
export function generateAuditTrail(ivrResult, transcript) {
  if (!ivrResult || !transcript) return null;

  const trail = {
    mode: ivrResult.mode,
    fullTranscript: transcript.text,
    totalDurationMs: ivrResult.totalDurationMs,
    steps: [],
  };

  for (const step of ivrResult.steps) {
    // Find transcript chunks that overlap with this step's speech window
    const stepStartSec = step.speechDetectedMs / 1000;
    const stepEndSec = step.silenceDetectedMs / 1000;

    const overlapping = (transcript.chunks || []).filter((chunk) => {
      const [chunkStart, chunkEnd] = chunk.timestamp;
      return chunkStart < stepEndSec && chunkEnd > stepStartSec;
    });

    const stepTranscript = overlapping.map((c) => c.text).join(" ").trim();

    // Check expect keyword match
    let expectMatch = undefined;
    if (step.expect) {
      const pattern = new RegExp(step.expect, "i");
      expectMatch = pattern.test(stepTranscript);
    }

    trail.steps.push({
      dtmf: step.dtmf,
      label: step.label,
      promptDurationMs: step.promptDurationMs,
      dtmfSentAtMs: step.dtmfSentMs,
      transcript: stepTranscript || "(no speech detected)",
      expect: step.expect,
      expectMatch,
    });
  }

  return trail;
}

/**
 * Save transcript and audit trail as JSON artifacts.
 */
export function saveTranscriptArtifacts(outputDir, transcript, auditTrail) {
  fs.mkdirSync(outputDir, { recursive: true });

  if (transcript) {
    const transcriptPath = path.join(outputDir, "ivr-transcript.json");
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
  }

  if (auditTrail) {
    const auditPath = path.join(outputDir, "ivr-audit-trail.json");
    fs.writeFileSync(auditPath, JSON.stringify(auditTrail, null, 2));
  }
}

// ── CLI entry point ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log("Usage: node scripts/ivr-transcriber.mjs <audio-file> [--output <dir>] [--ivr-result <json-file>]");
    console.log("");
    console.log("Transcribes IVR audio using local Whisper model.");
    console.log("Requires: npm install @xenova/transformers");
    process.exit(args.includes("--help") ? 0 : 1);
  }

  const audioPath = args[0];
  const outputIdx = args.indexOf("--output");
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : path.dirname(audioPath);
  const ivrResultIdx = args.indexOf("--ivr-result");
  const ivrResultPath = ivrResultIdx >= 0 ? args[ivrResultIdx + 1] : null;

  console.log(`Transcribing: ${audioPath}`);
  const transcript = await transcribeIvrAudio(audioPath);
  console.log(`Transcript: ${transcript.text}`);
  console.log(`Chunks: ${transcript.chunks.length}`);

  let auditTrail = null;
  if (ivrResultPath && fs.existsSync(ivrResultPath)) {
    const ivrResult = JSON.parse(fs.readFileSync(ivrResultPath, "utf-8"));
    auditTrail = generateAuditTrail(ivrResult, transcript);
    console.log("\nAudit Trail:");
    for (const step of auditTrail.steps) {
      const match = step.expectMatch === true ? "PASS" : step.expectMatch === false ? "FAIL" : "";
      console.log(
        `  DTMF ${step.dtmf}: "${step.transcript}" ` +
          `(${step.promptDurationMs}ms)` +
          (step.expect ? ` [expect="${step.expect}" ${match}]` : "")
      );
    }
  }

  saveTranscriptArtifacts(outputDir, transcript, auditTrail);
  console.log(`\nSaved to: ${outputDir}`);
}

// Run CLI if invoked directly
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("ivr-transcriber.mjs") ||
    process.argv[1].includes("ivr-transcriber"));
if (isMainModule) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
