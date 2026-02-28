#!/usr/bin/env node
/**
 * capture-demo-gif.mjs — Two-part demo GIF:
 *   Part 1: Scenario Studio UI tour (builder, settings, wizard)
 *   Part 2: Test execution with real pass/fail results
 *
 * Uses Playwright for all screenshots (including title cards).
 * Target: ~30 seconds.
 */

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const PORT = 4210;
const OUT_DIR = path.resolve("artifacts/demo-gif");
const GIF_PATH = path.resolve("artifacts/demo-gif/audrique-demo.gif");
const WIDTH = 1280;
const HEIGHT = 800;

function findLatestSuiteRun() {
  const root = path.resolve("test-results/e2e-suite");
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("scv-"))
    .sort((a, b) => b.name.localeCompare(a.name));
  return dirs.length > 0 ? path.join(root, dirs[0].name) : null;
}

async function extractVideoFrame(videoPath, timestampSec, outputPng) {
  await runCmd("ffmpeg", [
    "-y", "-ss", String(timestampSec), "-i", videoPath,
    "-frames:v", "1",
    "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=1a1b26`,
    outputPng,
  ]);
}

async function getVideoDuration(videoPath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "quiet", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", () => resolve(parseFloat(out) || 30));
  });
}

// Render a title card using Playwright (no ffmpeg drawtext needed)
async function renderCard(page, title, subtitle, outputPng) {
  await page.setContent(`
    <html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;display:flex;flex-direction:column;
      align-items:center;justify-content:center;background:#1a1b26;font-family:system-ui,sans-serif;">
      <div style="font-size:52px;font-weight:700;color:#fff;letter-spacing:1px">${title}</div>
      <div style="font-size:22px;color:#888899;margin-top:16px">${subtitle}</div>
    </body></html>
  `);
  await page.screenshot({ path: outputPng });
}

// Render a results summary card
async function renderResultsCard(page, scenarios, outputPng) {
  const rows = scenarios.map((s) => {
    const color = s.status === "passed" ? "#50fa7b" : s.status === "allowed_failure" ? "#ffb86c" : "#ff5555";
    const icon = s.status === "passed" ? "&#x2714;" : s.status === "allowed_failure" ? "&#x26A0;" : "&#x2718;";
    const dur = `${Math.round(s.durationSec)}s`;
    return `<div style="display:flex;align-items:center;gap:14px;font-size:22px;color:${color};font-family:monospace;margin:8px 0">
      <span style="font-size:26px">${icon}</span>
      <span style="min-width:360px">${s.id}</span>
      <span style="color:#666;font-size:18px">${dur}</span>
      <span style="font-size:16px;color:${color};text-transform:uppercase">${s.status.replace("_", " ")}</span>
    </div>`;
  }).join("");

  const passed = scenarios.filter((s) => s.status === "passed").length;
  const failed = scenarios.filter((s) => s.status === "failed").length;
  const allowed = scenarios.filter((s) => s.status === "allowed_failure").length;
  let summaryText = `${passed} passed`;
  if (allowed) summaryText += `, ${allowed} allowed failure`;
  if (failed) summaryText += `, ${failed} failed`;

  await page.setContent(`
    <html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;display:flex;flex-direction:column;
      align-items:center;justify-content:center;background:#1a1b26;font-family:system-ui,sans-serif;">
      <div style="font-size:38px;font-weight:700;color:#fff;margin-bottom:30px">Suite Results</div>
      <div style="padding:0 100px">${rows}</div>
      <div style="font-size:20px;color:#888899;margin-top:24px">${summaryText} &bull; Speech IVR Detection Mode</div>
    </body></html>
  `);
  await page.screenshot({ path: outputPng });
}

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(); });
        req.on("error", reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Server not ready at ${url}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const frames = [];
  let frameIndex = 0;

  function addFrame(file, duration, label) {
    frames.push({ file, duration });
    frameIndex++;
    console.log(`  [${frameIndex}] ${label} (${duration}s)`);
  }

  const browser = await chromium.launch({ headless: true });
  const cardContext = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const cardPage = await cardContext.newPage();

  // ═══════════════════════════════════════════════════════════════════════
  // Title Card
  // ═══════════════════════════════════════════════════════════════════════
  console.log("Title card...");
  const titlePng = path.join(OUT_DIR, "title-card.png");
  await renderCard(cardPage, "&#x25C9; Audrique", "Contact Center E2E Test Framework", titlePng);
  addFrame(titlePng, 2.5, "Title card");

  // ═══════════════════════════════════════════════════════════════════════
  // PART 1: Scenario Studio UI Tour
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\nPart 1: UI Tour...");

  const part1Card = path.join(OUT_DIR, "part1-card.png");
  await renderCard(cardPage, "Scenario Studio", "Visual Test Builder &bull; No-Code Configuration", part1Card);
  addFrame(part1Card, 2, "Part 1 title");

  const server = spawn(process.execPath, ["webapp/server.mjs", "--port", String(PORT)], {
    stdio: "pipe", detached: false,
  });
  server.stderr.on("data", () => {});
  server.stdout.on("data", () => {});

  try {
    await waitForServer(`http://localhost:${PORT}`);
    const uiContext = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    const page = await uiContext.newPage();

    async function screenshot(label, duration = 2) {
      const file = path.join(OUT_DIR, `frame-${String(frameIndex).padStart(2, "0")}.png`);
      await page.screenshot({ path: file, fullPage: false });
      addFrame(file, duration, label);
    }

    // Suite with scenarios
    await page.goto(`http://localhost:${PORT}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const suiteSelector = page.locator("#suite-selector");
    const options = await suiteSelector.locator("option").all();
    if (options.length > 1) {
      await suiteSelector.selectOption(await options[1].getAttribute("value") || "");
      await page.waitForTimeout(800);
    }
    await screenshot("Suite with scenarios", 2.5);

    // Setup dropdown
    await page.locator("#btn-setup").click();
    await page.waitForTimeout(400);
    await screenshot("Setup dropdown", 1.5);

    // Advanced Settings — Call Handling
    await page.locator("#btn-advanced-settings").click();
    await page.waitForTimeout(500);
    await page.locator(".settings-section-header").first().click();
    await page.waitForTimeout(300);
    await screenshot("Advanced Settings — Call Handling", 2.5);

    // Behavior Flags
    await page.locator(".settings-section-header").nth(3).click();
    await page.waitForTimeout(300);
    await page.locator(".modal").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(200);
    await screenshot("Advanced Settings — Behavior Flags", 2);

    // Suite Settings
    await page.locator(".modal-close").click();
    await page.waitForTimeout(300);
    await page.locator("#btn-suite-settings").click();
    await page.waitForTimeout(600);
    await screenshot("Suite Settings — Org & IVR", 2.5);

    // Scenario Builder
    await page.locator(".modal-close").click();
    await page.waitForTimeout(300);
    if ((await page.locator(".scenario-card").count()) > 0) {
      await page.locator(".scenario-card").first().click();
      await page.waitForTimeout(600);
      await screenshot("Scenario Builder", 2);
    }

    await uiContext.close();
  } finally {
    server.kill("SIGTERM");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 2: Test Execution Frames
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\nPart 2: Test Execution...");

  const part2Card = path.join(OUT_DIR, "part2-card.png");
  await renderCard(cardPage, "Test Execution", "3 Scenarios &bull; Speech IVR &bull; Supervisor Verification", part2Card);
  addFrame(part2Card, 2, "Part 2 title");

  const suiteDir = findLatestSuiteRun();
  if (suiteDir) {
    console.log(`  Using: ${path.basename(suiteDir)}`);

    const scenarioDirs = fs.readdirSync(suiteDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{2}-/.test(d.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const sd of scenarioDirs) {
      const sdPath = path.join(suiteDir, sd.name);
      const videos = [];
      const findVideos = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) findVideos(path.join(dir, entry.name));
          else if (entry.name === "merged-e2e.webm") videos.unshift(path.join(dir, entry.name));
          else if (entry.name === "video.webm") videos.push(path.join(dir, entry.name));
        }
      };
      findVideos(sdPath);

      if (videos.length > 0) {
        const video = videos[0];
        const label = sd.name.replace(/^\d{2}-/, "");
        const dur = await getVideoDuration(video);

        // 3 frames per scenario: early, mid, late
        const timestamps = [dur * 0.15, dur * 0.5, dur * 0.85];
        const labels = ["preflight", "call active", "verification"];

        for (let i = 0; i < timestamps.length; i++) {
          const png = path.join(OUT_DIR, `test-${sd.name}-${i}.png`);
          try {
            await extractVideoFrame(video, timestamps[i], png);
            addFrame(png, i === 1 ? 2 : 1.5, `${label} — ${labels[i]}`);
          } catch (err) {
            console.warn(`    Skipped ${label} ${labels[i]}: ${err.message.slice(0, 80)}`);
          }
        }
      }
    }

    // Results summary
    const summaryPath = path.join(suiteDir, "suite-summary.json");
    if (fs.existsSync(summaryPath)) {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      const resultsCard = path.join(OUT_DIR, "results-card.png");
      await renderResultsCard(cardPage, summary.scenarios, resultsCard);
      addFrame(resultsCard, 3, "Suite results");
    }
  }

  // Outro
  const outroPng = path.join(OUT_DIR, "outro-card.png");
  await renderCard(cardPage, "Audrique", "Open-Source &bull; Declarative &bull; Org-Agnostic", outroPng);
  addFrame(outroPng, 2.5, "Outro");

  await browser.close();

  // ═══════════════════════════════════════════════════════════════════════
  // Build GIF
  // ═══════════════════════════════════════════════════════════════════════
  const totalDuration = frames.reduce((s, f) => s + f.duration, 0);
  console.log(`\nBuilding GIF: ${frames.length} frames, ~${totalDuration.toFixed(0)}s...`);

  const concatFile = path.join(OUT_DIR, "frames.txt");
  const lines = frames.map((f) => `file '${f.file}'\nduration ${f.duration}`);
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(concatFile, lines.join("\n"));

  const palettePath = path.join(OUT_DIR, "palette.png");
  await runCmd("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
    "-vf", "scale=960:600:flags=lanczos,palettegen=max_colors=128:stats_mode=diff",
    palettePath,
  ]);

  await runCmd("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
    "-i", palettePath,
    "-lavfi", "scale=960:600:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3",
    GIF_PATH,
  ]);

  const stat = fs.statSync(GIF_PATH);
  console.log(`\nDone! ${GIF_PATH}`);
  console.log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB | Frames: ${frames.length} | Duration: ~${totalDuration.toFixed(0)}s`);
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (${code}): ${stderr.slice(-300)}`));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
