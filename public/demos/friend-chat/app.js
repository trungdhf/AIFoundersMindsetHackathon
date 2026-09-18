/**
 * Perxona Connect Kit — Friend Chat demo
 *
 * Same avatar/motion/emotion pattern as the myapp/ lesson app, but the
 * conversation goes through POST /api/chat (Option C — "own LLM") instead of
 * the Connect-hosted chatbot, so it isn't limited to one persona/topic. This
 * server is configured with LLM_PROVIDER=vertex (Gemini on Vertex AI, auth
 * via gcloud — see server.mjs and .env), but the same code works unchanged
 * against LLM_PROVIDER=openai/anthropic too.
 */

const presenter = document.querySelector("sv-presenter");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const sendBtn = document.querySelector("#send-btn");
const chatLog = document.getElementById("chat-log");
const chatPanel = document.getElementById("chat");
const starterTiles = document.getElementById("starter-tiles");
const stageCaption = document.getElementById("stage-caption");
const micBtn = document.getElementById("mic-btn");
const liveBtn = document.getElementById("live-btn");
const liveStatus = document.getElementById("live-status");

// ── Gesture + emotion tags — same map as myapp/app.js, same avatar (pinned
// in .env as DEMO_FIXED_AVATAR_ID: cc085a01_female_xr_01, skeleton f_cc). ──
const MOTION_TAGS = {
  "[wave]": "01KZD8C3PH4YGK56WKYEA3CFXH",
  "[bow]": "01KZD89FZHTMFERT1G1KZYY3GC",
  "[excited]": "01KZD8DC4MXM491S0J5GM8C05K",
  "[ok]": "01K4M9ABYK571VXG84BACSKK1T",
  "[thumbsup]": "01K4M9AQJEPKVX3HDKWWY4BH43",
  "[no]": "01K4M966TXRHH1GD1019WK8J0N",
  "[think]": "01KZD8BA45JPF4SVF5M1A3F3J8",
  "[clap]": "01KZD87C8R63BPD4555KWD2S75",
  "[point]": "01KZD8E8P8F0BV6QABJVQV8Y86",
  "[present]": "01KZD86YJ04KR4A7PZ5A0NRW5P",
  "[question]": "01M2838R2DBQM1RXVW8SWM7HE0",
};
const EMOTIONS = new Set([
  "joy", "excitement", "admiration", "caring", "gratitude", "sadness",
  "disappointment", "annoyance", "embarrassment", "curiosity", "surprise",
  "realization", "confusion",
]);
const INTENSITIES = new Set(["low", "neutral", "high"]);

function extractEmotion(text) {
  const options = {};
  const cleaned = text
    .replace(/\(emo:\s*([a-z]+)(?:\s*\/\s*([a-z]+))?\s*\)/gi, (m, emo, inten) => {
      emo = emo.toLowerCase();
      if (EMOTIONS.has(emo)) {
        options.emotion = emo;
        if (inten && INTENSITIES.has(inten.toLowerCase()))
          options.intensity = inten.toLowerCase();
      }
      return "";
    })
    .trim();
  return { text: cleaned, options };
}
function expandMotionTags(text) {
  let motionId = null;
  const stripped = text
    .replace(/\[[a-z]+\]/g, (tag) => {
      if (motionId === null && MOTION_TAGS[tag]) motionId = MOTION_TAGS[tag];
      return "";
    })
    .trim();
  return motionId ? `[MOTION ${motionId}:1] ${stripped}` : stripped;
}
const forDisplay = (text) =>
  text.replace(/\[[a-z]+\]/g, "").replace(/\(emo:[^)]*\)/gi, "").trim();

// A friend, not an assistant or a teacher — talks about anything, matches
// the user's language, and uses the same gesture/emotion tags as the rest
// of this project so the avatar reacts in character.
const SYSTEM_PROMPT = `You are a warm, easygoing, curious friend having a casual conversation — not an assistant, not a teacher, no disclaimers. Talk about anything: daily life, hobbies, opinions, random musings, jokes, advice. Reply in whatever language the user writes in. Keep replies natural and short, 1-3 sentences — this is read aloud through a 3D avatar, so never use markdown, never use bullet lists, never use straight double quotes. Vary your sentence endings naturally instead of repeating the same filler.

Insert ONE gesture tag near the START of your reply when it genuinely fits:
[wave] greeting/goodbye · [bow] thanking · [excited] big enthusiasm · [ok] agreeing
[no] disagreeing gently · [think] considering/unsure · [clap] celebrating · [point] highlighting something
[present] introducing a topic · [thumbsup] praising something · [question] asking something back

End the reply with (emo:X) or (emo:X/level) when it fits:
X = joy | excitement | admiration | caring | gratitude | sadness | disappointment | annoyance | embarrassment | curiosity | surprise | realization | confusion
level = low | neutral | high`;

const STARTERS = [
  { en: "How's your day going?", icon: "☀️" },
  { en: "Tell me something interesting", icon: "💡" },
  { en: "Got a joke for me?", icon: "😄" },
  { en: "What do you think about AI?", icon: "🤖" },
  { en: "Give me some advice", icon: "🧭" },
  { en: "What's your favorite thing?", icon: "❤️" },
];

/** @type {{role: "user"|"assistant", text: string}[]} */
const history = [];
const MAX_HISTORY_TURNS = 20;
const GREETING = "Hey! What's up? Ask me anything, or just say hi.";
const FAILURE_REPLY = "Hmm, couldn't reach my brain just then — try again?";
let audioUnlocked = false;
let config = null;

async function request(path, body) {
  const res = await fetch(
    path,
    body && {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || data.details || res.statusText;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data;
}

function appendMessage(role, text) {
  const li = document.createElement("li");
  li.className = `msg msg--${role}`;
  li.textContent = text;
  chatLog.append(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadPresenterEngine(url) {
  await new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement("script"), {
      type: "module",
      src: url,
      onload: resolve,
      onerror: () => reject(new Error(`Presenter failed to load: ${url}`)),
    });
    document.head.append(script);
  });
}

presenter.addEventListener("PRESENTER_STATUS", (event) => {
  if (event.detail?.status !== "Ready") return;
  document.getElementById("stage-loading")?.remove();
  chatPanel.hidden = false;
  for (const btn of starterTiles.querySelectorAll("button")) btn.disabled = false;
  if (!micBtn.hidden) micBtn.disabled = false;
  liveBtn.disabled = false;
  appendMessage("assistant", GREETING);
});
presenter.addEventListener("PLAYING_SPEECH_TEXT", (event) => {
  const text = event.detail?.text;
  if (!text) return;
  stageCaption.textContent = text;
  stageCaption.hidden = false;
});
presenter.addEventListener("ALL_PERFORMANCE_FINISHED", () => {
  stageCaption.hidden = true;
  stageCaption.textContent = "";
});

function setBusy(busy) {
  sendBtn.disabled = busy;
  chatInput.disabled = busy;
  for (const btn of starterTiles.querySelectorAll("button")) btn.disabled = busy;
  if (!micBtn.hidden) micBtn.disabled = busy;
}

async function sendMessage(text) {
  if (!text) return;

  appendMessage("user", text);
  history.push({ role: "user", text });
  setBusy(true);
  presenter.setThinking?.(true);

  try {
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }

    // POST /api/chat — Option C "own LLM", plain OpenAI-shaped messages
    // (role/content strings), unlike the Connect chatbot's parts format.
    const turns = history.slice(-MAX_HISTORY_TURNS);
    const { choices } = await request("/api/chat", {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...turns.map(({ role, text }) => ({ role, content: text })),
      ],
    });
    const reply = choices?.[0]?.message?.content;
    if (!reply) throw new Error("empty reply from LLM");

    const { text: withoutEmo, options } = extractEmotion(reply);
    appendMessage("assistant", forDisplay(withoutEmo));
    history.push({ role: "assistant", text: reply });
    presenter.setThinking?.(false);
    const result = await presenter.present(expandMotionTags(withoutEmo), options);
    if (!result?.success)
      console.error(`FriendChat: present() failed (${result?.code}): ${result?.message ?? ""}`);
  } catch (err) {
    if (history.at(-1)?.role === "user") history.pop();
    presenter.setThinking?.(false);
    appendMessage("error", FAILURE_REPLY);
    console.error(`FriendChat: ${err.message}`);
  } finally {
    setBusy(false);
    chatInput.focus();
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  chatInput.value = "";
  sendMessage(text);
});

for (const s of STARTERS) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = `${s.icon} ${s.en}`;
  btn.disabled = true;
  btn.addEventListener("click", () => sendMessage(s.en));
  starterTiles.append(btn);
}

// ── Voice input — browser speech-to-text (Web Speech API), NOT real-time
// speech-to-speech. Tap, speak one line, it's transcribed into chatInput
// and sent through the exact same sendMessage() path as typing — the avatar
// still replies via present() same as always, so nothing else changes.
// Chrome/Edge only; the button stays hidden everywhere else.
const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognitionCtor) {
  const recognition = new SpeechRecognitionCtor();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = navigator.language || "en-US";
  let listening = false;

  recognition.addEventListener("result", (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (transcript) sendMessage(transcript);
  });
  recognition.addEventListener("end", () => {
    listening = false;
    micBtn.classList.remove("listening");
  });
  recognition.addEventListener("error", (event) => {
    console.error(`FriendChat: speech recognition error: ${event.error}`);
    listening = false;
    micBtn.classList.remove("listening");
  });

  micBtn.hidden = false;
  micBtn.disabled = true; // enabled alongside the other controls on Ready
  micBtn.addEventListener("click", async () => {
    if (listening) {
      recognition.stop();
      return;
    }
    // Same autoplay-unlock rule as sendMessage() — a mic tap is a user
    // gesture too, so this is a valid place to do it if it hasn't run yet.
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }
    listening = true;
    micBtn.classList.add("listening");
    recognition.start();
  });
}

// ── Live speech-to-speech (Gemini Live via server.mjs's /live-ws relay) ────
//
// Real streaming: mic audio → server → Gemini Live → synthesized speech back,
// no text step in between. Each full model turn is buffered (audio chunks +
// transcript) until the server says the turn is complete, then played once
// through presenter.presentWithAudio() so the avatar lip-syncs to it — that
// trades a little latency (wait for the whole turn) for the avatar actually
// moving its mouth to Gemini's own voice, not just sound coming from nowhere.
let liveWs = null;
let liveAudioCtx = null;
let liveStream = null;
let liveProcessor = null;
let liveTurnChunks = []; // Uint8Array pieces of this turn's PCM16 audio
let liveTurnTranscript = "";

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function concatBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
/** Wrap raw 16-bit PCM bytes in a minimal WAV (RIFF) header so presentWithAudio can play it. */
function pcmToWav(pcmBytes, sampleRate) {
  const blockAlign = 2; // 16-bit mono
  const buffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcmBytes.length, true);
  new Uint8Array(buffer, 44).set(pcmBytes);
  return buffer;
}

async function playLiveTurn() {
  if (liveTurnChunks.length === 0) return;
  const wav = pcmToWav(concatBytes(liveTurnChunks), 24000);
  const transcript = liveTurnTranscript.trim() || "…";
  liveTurnChunks = [];
  liveTurnTranscript = "";
  stageCaption.textContent = transcript;
  stageCaption.hidden = false;
  const result = await presenter.presentWithAudio(wav, transcript);
  if (!result?.success)
    console.error(`FriendChat: presentWithAudio() failed (${result?.code}): ${result?.message ?? ""}`);
}

function setLiveUiActive(active) {
  liveBtn.classList.toggle("active", active);
  liveBtn.textContent = active ? "⏹ Stop live" : "🔴 Go live (speech-to-speech)";
  // Live mode owns the mic and the avatar's speech queue — the text/tile
  // chat and the Web-Speech mic button would just conflict with it.
  setBusy(active);
  starterTiles.hidden = active;
}

async function stopLive() {
  liveWs?.close();
  liveWs = null;
  for (const track of liveStream?.getTracks() ?? []) track.stop();
  liveStream = null;
  liveProcessor?.disconnect();
  liveProcessor = null;
  if (liveAudioCtx) {
    await liveAudioCtx.close().catch(() => {});
    liveAudioCtx = null;
  }
  liveTurnChunks = [];
  liveTurnTranscript = "";
  liveStatus.textContent = "";
  setLiveUiActive(false);
}

async function startLive() {
  if (!audioUnlocked) {
    await presenter.resumeAudioPlayback?.();
    audioUnlocked = true;
  }
  liveStatus.textContent = "Connecting…";
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live-ws`;
  liveWs = new WebSocket(wsUrl);

  liveWs.addEventListener("open", async () => {
    try {
      liveStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (err) {
      liveStatus.textContent = "Microphone permission denied.";
      stopLive();
      return;
    }
    // 16kHz to match what the server forwards to Gemini as
    // "audio/pcm;rate=16000" — this avoids a manual resample step.
    liveAudioCtx = new AudioContext({ sampleRate: 16000 });
    const source = liveAudioCtx.createMediaStreamSource(liveStream);
    // ScriptProcessorNode is deprecated but needs no separate worklet module
    // file for a test page like this; ok for now.
    liveProcessor = liveAudioCtx.createScriptProcessor(4096, 1, 1);
    const silentSink = liveAudioCtx.createGain();
    silentSink.gain.value = 0; // processor must connect to a destination to fire, but must not be heard
    source.connect(liveProcessor);
    liveProcessor.connect(silentSink);
    silentSink.connect(liveAudioCtx.destination);

    liveProcessor.onaudioprocess = (event) => {
      if (liveWs?.readyState !== WebSocket.OPEN) return;
      const floatData = event.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(floatData.length);
      for (let i = 0; i < floatData.length; i++) {
        const s = Math.max(-1, Math.min(1, floatData[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const bytes = new Uint8Array(int16.buffer);
      liveWs.send(
        JSON.stringify({ type: "audio", data: bytesToBase64(bytes), mimeType: "audio/pcm;rate=16000" }),
      );
    };

    liveStatus.textContent = "🎙️ Listening — talk anytime";
    setLiveUiActive(true);
  });

  liveWs.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "audio") {
      liveTurnChunks.push(base64ToBytes(msg.data));
    } else if (msg.type === "transcript") {
      liveTurnTranscript += msg.text;
      stageCaption.textContent = liveTurnTranscript;
      stageCaption.hidden = false;
    } else if (msg.type === "turnComplete") {
      playLiveTurn();
    } else if (msg.type === "interrupted") {
      presenter.interruptPresentation?.();
      liveTurnChunks = [];
      liveTurnTranscript = "";
    } else if (msg.type === "error") {
      liveStatus.textContent = `Error: ${msg.message}`;
      console.error(`FriendChat live: ${msg.message}`);
    }
  });

  liveWs.addEventListener("close", () => {
    if (liveBtn.classList.contains("active")) stopLive();
  });
  liveWs.addEventListener("error", () => {
    liveStatus.textContent = "Connection error.";
  });
}

liveBtn.addEventListener("click", () => {
  if (liveBtn.classList.contains("active")) stopLive();
  else startLive();
});

async function start() {
  const cfg = await request("/api/config");
  if (cfg.mock) throw new Error("mock mode cannot drive the presenter");
  if (!cfg.fixedTarget)
    throw new Error("no presenter target — see the server's startup log");
  await loadPresenterEngine(cfg.presenterUrl);
  const { connect_key: connectKey } = await request("/api/connect-key");
  await presenter.initializeWithConnectKey(connectKey, cfg.fixedTarget);
  return cfg;
}

config = await start().catch((err) => {
  document.getElementById("stage-loading")?.remove();
  const stageError = document.getElementById("stage-error");
  if (stageError) {
    stageError.textContent = "Couldn't start the avatar. Check the console.";
    stageError.hidden = false;
  }
  console.error(`FriendChat: ${err.message}`);
  return {};
});
