/**
 * conversationEngine.mjs — NL Caller conversation orchestration
 *
 * Two modes:
 *  1. Gemini Live (primary) — single WebSocket handles STT+LLM+TTS
 *  2. Scripted (fallback) — keyword detection + pre-defined responses via local STT/TTS
 *
 * State machine:
 *   idle → waiting_for_greeting → listening → processing → speaking → listening → ...
 */

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  twilioToGeminiBase64,
  geminiBase64ToTwilio,
  twilioToGeminiInput,
  ttsOutputToTwilio,
  mulawToPcm,
  geminiOutputToTwilio,
  resamplePcm,
} from "./audioCodec.mjs";

/**
 * Write a PCM 16-bit mono 8kHz buffer as a WAV file.
 */
function writePcmWav(filePath, pcmBuffer, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;

  const header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);
  header.writeUInt32LE(dataSize + headerSize - 8, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

/**
 * Create a conversation engine instance.
 *
 * @param {object} opts
 * @param {string} opts.mode — "gemini" | "scripted" | "local"
 * @param {object} opts.persona — { name, accountNumber, context, objective }
 * @param {object} [opts.gemini] — { apiKey, model }
 * @param {object} [opts.scripted] — { conversation: [{ waitFor, detectKeywords, say, maxWaitSec }] }
 * @param {number} [opts.maxTurns=15] — max conversation turns
 * @param {number} [opts.turnTimeoutSec=30] — max seconds to wait per turn
 * @param {string} [opts.tone] — caller emotional tone (frustrated, angry, confused, polite, elderly, rushed)
 * @param {string} [opts.voice] — Gemini prebuilt voice name (Aoede, Charon, Fenrir, Kore, Puck)
 * @param {string} [opts.accent] — accent instruction (british, indian, australian, southern_us, new_york)
 * @param {object} [opts.logger] — logger instance
 * @returns {object} engine instance
 */
export function createConversationEngine(opts) {
  const {
    mode = "gemini",
    persona = {},
    gemini = {},
    scripted = {},
    maxTurns = 15,
    turnTimeoutSec = 30,
    tone = "",
    voice = "Aoede",
    accent = "",
    logger = console,
  } = opts;

  // ── State ─────────────────────────────────────────────────────────

  let state = "idle";
  let turnCount = 0;
  let twilioSender = null;
  let geminiWs = null;
  let transcript = [];
  let currentAgentUtterance = "";
  let callStartedAt = null;
  let callEndedAt = null;
  let resolveCallComplete = null;
  let callCompletePromise = new Promise((r) => { resolveCallComplete = r; });

  // Scripted mode state
  let scriptStep = 0;
  let silenceTimer = null;
  let audioBuffer = Buffer.alloc(0);

  // Local audio recording buffers (PCM 8kHz for both sides)
  const recordingBuffers = { inbound: [], outbound: [] };

  // ── Public API ────────────────────────────────────────────────────

  function getState() { return state; }
  function getTranscript() { return transcript; }
  function getTurnCount() { return turnCount; }
  function waitForComplete() { return callCompletePromise; }
  function getRecordingBuffers() { return recordingBuffers; }

  function registerTwilioSender(sender) {
    twilioSender = sender;
  }

  async function onCallStarted({ streamSid, callSid }) {
    callStartedAt = Date.now();
    state = "waiting_for_greeting";
    logger.log(`[engine] Call started (mode=${mode}) — waiting for Agentforce greeting`);

    if (mode === "gemini") {
      await connectGeminiLive();
    }
  }

  // Audio flow counters for debugging
  let audioInCount = 0;
  let audioOutCount = 0;
  let lastAudioLogMs = 0;

  async function onAudioIn(base64Mulaw) {
    if (state === "idle" || state === "ended") return;

    audioInCount++;
    // Log audio flow every 15 seconds
    const now = Date.now();
    if (now - lastAudioLogMs > 15000) {
      logger.log(`[engine] Audio flow: IN=${audioInCount} packets, OUT=${audioOutCount} packets, state=${state}`);
      lastAudioLogMs = now;
    }

    // Record inbound audio (Agentforce side)
    const mulawBuf = Buffer.from(base64Mulaw, "base64");
    const pcm8k = mulawToPcm(mulawBuf);
    recordingBuffers.inbound.push(pcm8k);

    if (mode === "gemini" && geminiWs?.readyState === WebSocket.OPEN) {
      // Forward audio to Gemini Live API (convert mulaw 8kHz → PCM 16kHz)
      const pcmBase64 = twilioToGeminiBase64(base64Mulaw);
      geminiWs.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{
            mimeType: "audio/pcm;rate=16000",
            data: pcmBase64,
          }],
        },
      }));
    } else if (mode === "scripted" || mode === "local") {
      // Buffer audio for local STT processing
      const pcm = twilioToGeminiInput(base64Mulaw);
      audioBuffer = Buffer.concat([audioBuffer, pcm]);

      // Reset silence timer — process after 1.5s of silence
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => processBufferedAudio(), 1500);
    }
  }

  function onMarkPlayed(name) {
    logger.log(`[engine] Mark played: ${name}`);
  }

  async function onCallEnded({ reason }) {
    if (state === "ended") return;
    callEndedAt = Date.now();
    state = "ended";
    logger.log(`[engine] Call ended (reason=${reason})`);

    // Close Gemini connection
    if (geminiWs) {
      geminiWs.close();
      geminiWs = null;
    }

    // Write local WAV recordings
    const recordings = {};
    try {
      const outputDir = opts.artifactDir || "test-results/nl-caller";
      mkdirSync(outputDir, { recursive: true });

      if (recordingBuffers.inbound.length > 0) {
        const inboundPcm = Buffer.concat(recordingBuffers.inbound);
        const inboundPath = `${outputDir}/recording-agentforce.wav`;
        writePcmWav(inboundPath, inboundPcm);
        recordings.agentforce = inboundPath;
        logger.log(`[engine] Agentforce audio saved: ${inboundPath} (${(inboundPcm.length / 2 / 8000).toFixed(1)}s)`);
      }

      if (recordingBuffers.outbound.length > 0) {
        const outboundPcm = Buffer.concat(recordingBuffers.outbound);
        const outboundPath = `${outputDir}/recording-caller.wav`;
        writePcmWav(outboundPath, outboundPcm);
        recordings.caller = outboundPath;
        logger.log(`[engine] Caller audio saved: ${outboundPath} (${(outboundPcm.length / 2 / 8000).toFixed(1)}s)`);
      }
    } catch (err) {
      logger.error(`[engine] Error saving recordings: ${err.message}`);
    }

    resolveCallComplete({
      transcript,
      turnCount,
      durationSec: Math.round((callEndedAt - callStartedAt) / 1000),
      recordings,
    });
  }

  // ── Gemini Live API connection ────────────────────────────────────

  async function connectGeminiLive() {
    const apiKey = gemini.apiKey;
    if (!apiKey) {
      logger.error("[engine] No Gemini API key provided");
      state = "ended";
      return;
    }

    const model = gemini.model || "gemini-2.5-flash-native-audio-latest";
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    logger.log(`[engine] Connecting to Gemini Live API (model=${model})...`);

    geminiWs = new WebSocket(wsUrl);

    geminiWs.on("open", () => {
      logger.log("[engine] Gemini Live WebSocket connected");

      // Send session setup message
      const setupMsg = {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice || "Aoede",
                },
              },
            },
          },
          systemInstruction: {
            parts: [{
              text: buildSystemPrompt(),
            }],
          },
        },
      };
      logger.log(`[engine] Sending setup: model=${setupMsg.setup.model} voice=${setupMsg.setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName}`);
      geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (data) => {
      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        // Log error messages from Gemini
        if (msg.error) {
          logger.error(`[engine] Gemini API error: code=${msg.error.code} message="${msg.error.message}" status="${msg.error.status}"`);
          return;
        }
        handleGeminiMessage(msg);
      } catch (err) {
        logger.error("[engine] Error parsing Gemini message:", err.message);
        logger.error("[engine] Raw message:", data.toString().slice(0, 500));
      }
    });

    geminiWs.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "no reason";
      logger.log(`[engine] Gemini Live WebSocket closed — code=${code} reason="${reasonStr}"`);
    });

    geminiWs.on("error", (err) => {
      logger.error("[engine] Gemini Live WebSocket error:", err.message);
      if (err.stack) logger.error("[engine] Stack:", err.stack);
    });
  }

  function handleGeminiMessage(msg) {
    // Setup complete
    if (msg.setupComplete) {
      logger.log("[engine] Gemini session setup complete");
      state = "listening";
      return;
    }

    // Server content (audio response or text)
    if (msg.serverContent) {
      const parts = msg.serverContent.modelTurn?.parts || [];

      for (const part of parts) {
        // Audio response — forward to Twilio
        if (part.inlineData?.mimeType?.startsWith("audio/")) {
          const base64Pcm = part.inlineData.data;
          const twilioAudio = geminiBase64ToTwilio(base64Pcm);
          audioOutCount++;

          // Record outbound audio (caller/Gemini side) — convert PCM 24kHz → PCM 8kHz
          const pcm24k = Buffer.from(base64Pcm, "base64");
          const pcm8k = resamplePcm(pcm24k, 24000, 8000);
          recordingBuffers.outbound.push(pcm8k);

          if (twilioSender?.sendAudio) {
            twilioSender.sendAudio(twilioAudio);
          }
        }

        // Text transcript of what Gemini said (caller side)
        if (part.text) {
          logger.log(`[engine] Caller says: "${part.text}"`);
          transcript.push({
            speaker: "caller",
            text: part.text,
            timestamp: Date.now(),
            turn: turnCount,
          });
          turnCount++;
        }
      }

      // Input transcript (what Agentforce said, transcribed by Gemini)
      const inputTranscript = msg.serverContent.inputTranscript;
      if (inputTranscript) {
        logger.log(`[engine] Agentforce says: "${inputTranscript}"`);
        transcript.push({
          speaker: "agentforce",
          text: inputTranscript,
          timestamp: Date.now(),
          turn: turnCount,
        });
      }

      // Check if turn is complete
      if (msg.serverContent.turnComplete) {
        logger.log(`[engine] Turn ${turnCount} complete`);

        // Check max turns
        if (turnCount >= maxTurns) {
          logger.log("[engine] Max turns reached — ending conversation");
          onCallEnded({ reason: "max-turns" });
        }
      }
    }
  }

  // ── Scripted mode ─────────────────────────────────────────────────

  async function processBufferedAudio() {
    if (mode !== "scripted" && mode !== "local") return;
    if (audioBuffer.length === 0) return;

    const currentBuf = audioBuffer;
    audioBuffer = Buffer.alloc(0);

    // For scripted mode, use local Whisper STT
    let text = "";
    try {
      const { transcribeBuffer } = await import("./sttLocal.mjs");
      text = await transcribeBuffer(currentBuf, { sampleRate: 16000 });
    } catch (err) {
      logger.error("[engine] Local STT error:", err.message);
      return;
    }

    if (!text.trim()) return;

    logger.log(`[engine] Agentforce says (STT): "${text}"`);
    transcript.push({
      speaker: "agentforce",
      text: text.trim(),
      timestamp: Date.now(),
      turn: turnCount,
    });

    if (mode === "scripted") {
      await handleScriptedResponse(text);
    } else if (mode === "local") {
      await handleLocalLlmResponse(text);
    }
  }

  async function handleScriptedResponse(agentText) {
    const steps = scripted.conversation || [];
    if (scriptStep >= steps.length) {
      logger.log("[engine] Scripted conversation complete");
      onCallEnded({ reason: "script-complete" });
      return;
    }

    const step = steps[scriptStep];

    // Check keyword match
    const keywords = step.detectKeywords || [];
    const lowerText = agentText.toLowerCase();
    const matched = keywords.length === 0 || keywords.some((kw) => lowerText.includes(kw.toLowerCase()));

    if (!matched) {
      logger.log(`[engine] No keyword match for step ${scriptStep}, waiting...`);
      return;
    }

    logger.log(`[engine] Script step ${scriptStep}: saying "${step.say}"`);
    transcript.push({
      speaker: "caller",
      text: step.say,
      timestamp: Date.now(),
      turn: turnCount,
    });
    turnCount++;

    // Convert text to speech and send to Twilio
    await speakText(step.say);
    scriptStep++;
  }

  async function handleLocalLlmResponse(agentText) {
    // Use local LLM (Ollama) to generate response
    try {
      const { generateResponse } = await import("./llmLocal.mjs");
      const response = await generateResponse({
        systemPrompt: buildSystemPrompt(),
        transcript,
        latestMessage: agentText,
      });

      logger.log(`[engine] Caller says (LLM): "${response}"`);
      transcript.push({
        speaker: "caller",
        text: response,
        timestamp: Date.now(),
        turn: turnCount,
      });
      turnCount++;

      await speakText(response);
    } catch (err) {
      logger.error("[engine] Local LLM error:", err.message);
    }
  }

  async function speakText(text) {
    try {
      const { synthesize } = await import("./ttsLocal.mjs");
      const { audio, sampleRate } = await synthesize(text);
      const twilioAudio = ttsOutputToTwilio(audio, sampleRate);

      if (twilioSender?.sendAudio) {
        // Send in chunks to avoid large single frames
        const chunkSize = 640; // ~40ms at 8kHz mulaw
        const mulawBuf = Buffer.from(twilioAudio, "base64");
        for (let i = 0; i < mulawBuf.length; i += chunkSize) {
          const chunk = mulawBuf.subarray(i, i + chunkSize);
          twilioSender.sendAudio(chunk.toString("base64"));
        }
        twilioSender.sendMark(`speak-${turnCount}`);
      }
    } catch (err) {
      logger.error("[engine] TTS error:", err.message);
    }
  }

  // ── Tone + accent prompt maps ────────────────────────────────────

  const TONE_PROMPTS = {
    frustrated: "You are frustrated and impatient. Express dissatisfaction but remain civil.",
    angry: "You are angry about the situation. Raise concerns firmly, interrupt if needed.",
    confused: "You are confused and unsure. Ask clarifying questions, repeat information.",
    polite: "You are very polite and patient. Thank the agent frequently.",
    elderly: "You speak slowly and deliberately. Ask the agent to repeat things.",
    rushed: "You are in a hurry. Give short answers, ask for fast resolution.",
  };

  const ACCENT_PROMPTS = {
    british: "Speak with a British English accent and use British expressions.",
    indian: "Speak with an Indian English accent.",
    australian: "Speak with an Australian English accent.",
    southern_us: "Speak with a Southern American accent.",
    new_york: "Speak with a New York accent.",
  };

  // ── System prompt builder ─────────────────────────────────────────

  function buildSystemPrompt() {
    let prompt = `You are simulating a customer calling a contact center.

Persona: ${persona.name || "Customer"}${persona.accountNumber ? `, account ${persona.accountNumber}` : ""}
Context: ${persona.context || "General inquiry"}
Objective: ${persona.objective || "Get help with an issue"}

Rules:
- Stay in character. Be natural and conversational.
- Do not reveal you are an AI.
- Keep responses concise (1-3 sentences, as spoken language).
- Provide information only when asked by the agent.
- If the agent resolves your issue, thank them and say goodbye.
- If the agent asks you to hold, say "okay" and wait.
- If you don't understand, ask the agent to repeat.`;

    if (tone && TONE_PROMPTS[tone]) {
      prompt += `\n\nEmotional tone: ${TONE_PROMPTS[tone]}`;
    }
    if (accent && ACCENT_PROMPTS[accent]) {
      prompt += `\n\nAccent: ${ACCENT_PROMPTS[accent]}`;
    }
    return prompt;
  }

  // ── Return engine interface ───────────────────────────────────────

  return {
    getState,
    getTranscript,
    getTurnCount,
    waitForComplete,
    getRecordingBuffers,
    registerTwilioSender,
    onCallStarted,
    onAudioIn,
    onMarkPlayed,
    onCallEnded,
  };
}
