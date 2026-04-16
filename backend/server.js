// server.js — Guitar Tab MVP backend
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const app = express();
const PORT = 3000;

// Python venv for the transcription engine
const PYTHON_BIN = path.resolve(
  os.homedir(),
  "Desktop/AiGuitartab/.venv/bin/python"
);
const TRANSCRIBE_SCRIPT = path.resolve(
  os.homedir(),
  "Desktop/AiGuitartab/transcribe.py"
);

app.use(express.json({ limit: "100mb" }));
app.use(cors());

// Serve the frontend
app.use(express.static(path.resolve(__dirname, "../frontend")));

// Multer for audio file uploads (store in temp dir)
const upload = multer({ dest: os.tmpdir() });

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", python: PYTHON_BIN, script: TRANSCRIBE_SCRIPT });
});

// POST /api/transcribe
// Accepts multipart form with `audio` file field.
// Runs the Python transcription engine and returns the transcription JSON.
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided" });
  }

  const audioPath = req.file.path;
  const outputPath = path.join(os.tmpdir(), `tab_${Date.now()}.json`);

  // Profile mode from request body (default: chord_melody_posts)
  const profileMode = req.body.profileMode || "chord_melody_posts";

  console.log(`[transcribe] audio=${audioPath} profile=${profileMode}`);

  const args = [
    TRANSCRIBE_SCRIPT,
    "--audio", audioPath,
    "--video", audioPath, // same file — hand tracking disabled anyway
    "--output", outputPath,
    "--profile-mode", profileMode,
    "--disable-hand-tracking",
    // basic_twopass is the new default for chord_melody_posts via auto
  ];

  try {
    const result = await runPython(args);
    console.log(`[transcribe] python stdout: ${result.stdout.slice(0, 200)}`);
    if (result.exitCode !== 0) {
      console.error(`[transcribe] python stderr: ${result.stderr}`);
      cleanup(audioPath, outputPath);
      return res.status(500).json({
        error: "Transcription failed",
        detail: result.stderr.slice(0, 500),
      });
    }

    // Read the output JSON
    if (!fs.existsSync(outputPath)) {
      cleanup(audioPath, outputPath);
      return res.status(500).json({ error: "Transcription produced no output" });
    }

    const transcription = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    cleanup(audioPath, outputPath);
    res.json(transcription);
  } catch (err) {
    console.error("[transcribe] error:", err);
    cleanup(audioPath, outputPath);
    res.status(500).json({ error: err.message });
  }
});

// Legacy endpoint (kept for backwards compat)
app.post("/generate-tab", (req, res) => {
  res.json({ tab: "(use /api/transcribe instead)" });
});

function runPython(args) {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      timeout: 300_000, // 5 minute timeout
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    proc.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
  }
}

app.listen(PORT, () => {
  console.log(`Guitar Tab MVP backend on http://localhost:${PORT}`);
});
