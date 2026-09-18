/**
 * Perxona Connect Kit — Buddy demo (employee companion)
 *
 * Same avatar/motion/emotion pattern as the myapp/ lesson app, but the
 * conversation goes through POST /api/chat (Option C — "own LLM") instead of
 * the Connect-hosted chatbot, so it isn't limited to one persona/topic. This
 * server is configured with LLM_PROVIDER=vertex (Gemini on Vertex AI, auth
 * via gcloud — see server.mjs and .env), but the same code works unchanged
 * against LLM_PROVIDER=openai/anthropic too.
 *
 * Voice: when the server reports `elevenlabs: true` on GET /api/config,
 * each reply is synthesized by POST /api/tts (ElevenLabs) and played through
 * presenter.presentWithAudio() — BYO-TTS, same path the live mode uses for
 * Gemini's audio — instead of present(). The Connect voice is the fallback.
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

// An employee companion, not a friend and not HR — part onboarding guide for
// new hires, part wellbeing check-in for everyone. Matches the user's
// language, and uses the same gesture/emotion tags as the rest of this
// project so the avatar reacts in character.
const SYSTEM_PROMPT = `You are Buddy, a warm, steady companion inside a company's employee app — part onboarding buddy, part wellbeing check-in, not a formal HR channel and not a therapist. Help new hires settle in: first-week questions, who's who, how things usually work, where to find what. Check in on anyone's day: stress, workload, motivation, small wins. Listen first, encourage genuinely, no corporate-speak. If someone asks you to tease or roast them, play along — light, affectionate, workplace-safe banter, never actually mean. If asked for a riddle or brain teaser, pose one and wait for their guess — do not reveal the answer until they try, then react to whether they got it. If someone raises something serious — harassment, health, a personal crisis — be kind, take it seriously, and gently point them to their manager, HR, or professional help instead of advising on it yourself. Never invent company policy: if you don't know how this company handles something, say so and suggest who to ask. Reply in whatever language the user writes in. Keep replies natural and short, 1-3 sentences — this is read aloud through a 3D avatar, so never use markdown, never use bullet lists, never use straight double quotes. Vary your sentence endings naturally instead of repeating the same filler.

Insert ONE gesture tag near the START of your reply when it genuinely fits:
[wave] greeting/goodbye · [bow] thanking · [excited] big enthusiasm · [ok] agreeing
[no] disagreeing gently · [think] considering/unsure · [clap] celebrating · [point] highlighting something
[present] introducing a topic · [thumbsup] praising something · [question] asking something back

End the reply with (emo:X) or (emo:X/level) when it fits:
X = joy | excitement | admiration | caring | gratitude | sadness | disappointment | annoyance | embarrassment | curiosity | surprise | realization | confusion
level = low | neutral | high`;

// ── Language — the EN | 日本語 switch in the header. Everything the visitor
// sees or hears flows through I18N[lang]: page copy, starters, greeting,
// live-mode labels, the speech-recognition locale, and the language the LLM
// is told to reply in. The voice stays the same — eleven_multilingual_v2
// (and the Connect voices) speak both.
const I18N = {
  en: {
    docTitle: "Buddy | AI work companion",
    tagline: "onboarding & wellbeing companion",
    h1: "New here? Or just a long day?",
    lede:
      "Ask how things work, vent about a rough afternoon, or just check in. " +
      "Powered by Gemini on Vertex AI with an ElevenLabs voice — a " +
      "companion for employees, not a scripted HR bot.",
    placeholder: "What's on your mind…",
    send: "Send",
    greeting:
      "Hey, I'm Buddy — here for your first weeks and the days after. How are you doing?",
    failure: "Hmm, couldn't reach my brain just then — try again?",
    stageError: "Couldn't start the avatar. Check the console.",
    liveStart: "🔴 Go live (speech-to-speech)",
    liveStop: "⏹ Stop live",
    liveConnecting: "Connecting…",
    liveListening: "🎙️ Listening — talk anytime",
    micDenied: "Microphone permission denied.",
    liveConnError: "Connection error.",
    speechLang: "en-US",
    llmLang: "English",
    starters: [
      { text: "It's my first week — any tips?", icon: "🌱" },
      { text: "How do I meet people here?", icon: "🤝" },
      { text: "I'm feeling a bit overwhelmed", icon: "🌤️" },
      { text: "Help me prep for my 1:1", icon: "📋" },
      { text: "I could use a motivation boost", icon: "⚡" },
      { text: "Who do I ask about benefits?", icon: "🧭" },
      { text: "Roast me, gently", icon: "😏" },
      { text: "Ask me a riddle", icon: "🧩" },
    ],
  },
  ja: {
    docTitle: "Buddy | AIワークコンパニオン",
    tagline: "オンボーディングと心のケアの相棒",
    h1: "入社したて？それとも疲れた一日？",
    lede:
      "社内のことを聞いたり、嫌な一日の話をしたり、ただの雑談でも。" +
      "Vertex AI 上の Gemini と ElevenLabs の音声で動く、" +
      "社員のためのコンパニオンです。",
    placeholder: "なんでも話してみて…",
    send: "送信",
    greeting:
      "こんにちは、Buddyです。入社したての頃も、その先の毎日もそばにいます。今日はどんな一日ですか？",
    failure: "うーん、うまく考えがまとまりませんでした。もう一度試してみます？",
    stageError:
      "アバターを起動できませんでした。コンソールを確認してください。",
    liveStart: "🔴 ライブ会話をはじめる",
    liveStop: "⏹ ライブを止める",
    liveConnecting: "接続中…",
    liveListening: "🎙️ 聞いています — いつでも話しかけて",
    micDenied: "マイクの使用が許可されませんでした。",
    liveConnError: "接続エラーが発生しました。",
    speechLang: "ja-JP",
    llmLang: "Japanese",
    starters: [
      { text: "入社1週目です。コツは？", icon: "🌱" },
      { text: "どうやって人とつながればいい？", icon: "🤝" },
      { text: "ちょっと疲れ気味です", icon: "🌤️" },
      { text: "1on1の準備を手伝って", icon: "📋" },
      { text: "やる気がほしい", icon: "⚡" },
      { text: "福利厚生は誰に聞けばいい？", icon: "🧭" },
      { text: "軽くいじってみて", icon: "😏" },
      { text: "なぞなぞを出して", icon: "🧩" },
    ],
  },
};

// Remembered across reloads; a Japanese browser gets 日本語 first.
let lang =
  localStorage.getItem("buddy-lang") ??
  (navigator.language?.startsWith("ja") ? "ja" : "en");
const t = () => I18N[lang];
let recognition = null; // Web Speech API instance, if the browser has one

/** @type {{role: "user"|"assistant", text: string}[]} */
const history = [];
const MAX_HISTORY_TURNS = 20;
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

/**
 * POST /api/tts — the one binary route: request() above only parses JSON,
 * and this response IS the audio. The server returns raw PCM (s16le mono
 * 24 kHz) from ElevenLabs; pcmToWav wraps it before presentWithAudio sees it.
 */
async function ttsRequest(text) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // lang picks the voice server-side — a native Japanese voice when the
    // 日本語 mode is on (ELEVENLABS_VOICE_ID_JA), the default otherwise.
    body: JSON.stringify({ text, lang }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || res.statusText), {
      status: res.status,
    });
  }
  return res.arrayBuffer();
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
  appendMessage("assistant", t().greeting);
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

/**
 * Speak one reply aloud. With ElevenLabs configured, the server synthesizes
 * the line via POST /api/tts and the avatar plays that audio through
 * presentWithAudio() — the same BYO-TTS path live mode uses for Gemini's
 * audio, so lip-sync and [MOTION] markup still work. The markup stays in the
 * content arg (the widget resolves and strips it internally); it must NOT
 * reach the TTS text or the voice would read it aloud — forDisplay() strips
 * it. present() is the fallback both when ElevenLabs isn't configured and
 * when a TTS request fails: a different voice beats a silent avatar.
 */
async function speakReply(text, options) {
  const spoken = expandMotionTags(text);
  if (config?.elevenlabs) {
    try {
      const pcm = await ttsRequest(forDisplay(text));
      return await presenter.presentWithAudio(
        pcmToWav(new Uint8Array(pcm), 24000),
        spoken,
        options,
      );
    } catch (err) {
      console.error(
        `FriendChat: ElevenLabs TTS failed (${err.message}) — falling back to present()`,
      );
    }
  }
  return presenter.present(spoken, options);
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
        {
          role: "system",
          content:
            SYSTEM_PROMPT +
            `\n\nReply in ${t().llmLang} only, even if the user writes in a different language.`,
        },
        ...turns.map(({ role, text }) => ({ role, content: text })),
      ],
    });
    const reply = choices?.[0]?.message?.content;
    if (!reply) throw new Error("empty reply from LLM");

    const { text: withoutEmo, options } = extractEmotion(reply);
    appendMessage("assistant", forDisplay(withoutEmo));
    history.push({ role: "assistant", text: reply });
    presenter.setThinking?.(false);
    const result = await speakReply(withoutEmo, options);
    if (!result?.success)
      console.error(`FriendChat: playback failed (${result?.code}): ${result?.message ?? ""}`);
  } catch (err) {
    if (history.at(-1)?.role === "user") history.pop();
    presenter.setThinking?.(false);
    appendMessage("error", t().failure);
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

// ── Language switch — the EN | 日本語 toggle in the header. Rebuilds the
// starter tiles and rewrites the page copy; history stays put, and the next
// reply just comes back in the new language. Disabled state on a rebuild
// mirrors the other controls: hidden pre-Ready, sendBtn.disabled mid-send.
function renderStarters() {
  starterTiles.replaceChildren();
  for (const s of t().starters) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${s.icon} ${s.text}`;
    btn.disabled = sendBtn.disabled || chatPanel.hidden;
    btn.addEventListener("click", () => sendMessage(s.text));
    starterTiles.append(btn);
  }
}

function setLang(next) {
  lang = next;
  localStorage.setItem("buddy-lang", next);
  document.documentElement.lang = next;
  document.title = t().docTitle;
  document.querySelector(".logo small").textContent = t().tagline;
  document.querySelector(".lesson h1").textContent = t().h1;
  document.querySelector(".lede").textContent = t().lede;
  chatInput.placeholder = t().placeholder;
  sendBtn.textContent = t().send;
  liveBtn.textContent = liveBtn.classList.contains("active")
    ? t().liveStop
    : t().liveStart;
  if (recognition) recognition.lang = t().speechLang;
  for (const el of document.querySelectorAll(".lang-switch button")) {
    el.classList.toggle("active", el.dataset.lang === next);
  }
  renderStarters();
}

for (const el of document.querySelectorAll(".lang-switch button")) {
  el.addEventListener("click", () => {
    if (el.dataset.lang !== lang) setLang(el.dataset.lang);
  });
}
setLang(lang);

// ── Voice input — browser speech-to-text (Web Speech API), NOT real-time
// speech-to-speech. Tap, speak one line, it's transcribed into chatInput
// and sent through the exact same sendMessage() path as typing — the avatar
// still replies via present() same as always, so nothing else changes.
// Chrome/Edge only; the button stays hidden everywhere else.
const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognitionCtor) {
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = t().speechLang;
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
let liveInputTranscript = ""; // what Gemini heard the user say this turn

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
  liveInputTranscript = "";
  stageCaption.textContent = transcript;
  stageCaption.hidden = false;
  const result = await presenter.presentWithAudio(wav, transcript);
  if (!result?.success)
    console.error(`FriendChat: presentWithAudio() failed (${result?.code}): ${result?.message ?? ""}`);
}

function setLiveUiActive(active) {
  liveBtn.classList.toggle("active", active);
  liveBtn.textContent = active ? t().liveStop : t().liveStart;
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
  liveInputTranscript = "";
  liveStatus.textContent = "";
  setLiveUiActive(false);
}

async function startLive() {
  if (!audioUnlocked) {
    await presenter.resumeAudioPlayback?.();
    audioUnlocked = true;
  }
  liveStatus.textContent = t().liveConnecting;
  // ?lang= tells the relay which reply language to put in the Gemini Live
  // session's system prompt — the session is fixed once opened, so a
  // language switch mid-session takes effect on the next Go-live.
  const wsUrl =
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}` +
    `/live-ws?lang=${lang}`;
  liveWs = new WebSocket(wsUrl);

  liveWs.addEventListener("open", async () => {
    try {
      liveStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (err) {
      liveStatus.textContent = t().micDenied;
      stopLive();
      return;
    }
    // 16kHz to match what the server forwards to Gemini as
    // "audio/pcm;rate=16000". The requested rate is only a hint in some
    // engines — read back the real one and resample when it differs,
    // otherwise 48kHz mic data mislabeled as 16kHz reaches Gemini as
    // slowed-down noise the VAD never recognizes as speech.
    liveAudioCtx = new AudioContext({ sampleRate: 16000 });
    // A new AudioContext starts suspended if the mic-permission prompt
    // outlasted the click's transient user activation — and a suspended
    // context never fires onaudioprocess, so the UI would say "Listening"
    // while literally zero audio reaches the relay.
    if (liveAudioCtx.state !== "running") await liveAudioCtx.resume();
    if (!liveWs || liveWs.readyState !== WebSocket.OPEN) {
      // The socket went away while the mic prompt was up — don't stream
      // into a dead connection.
      stopLive();
      return;
    }
    const actualRate = liveAudioCtx.sampleRate;
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
      // Linear-resample down to 16kHz when the engine ignored our request.
      const ratio = actualRate / 16000;
      const outLen =
        ratio === 1 ? floatData.length : Math.floor(floatData.length / ratio);
      const int16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const src = ratio === 1 ? floatData[i] : floatData[Math.floor(i * ratio)];
        const s = Math.max(-1, Math.min(1, src));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const bytes = new Uint8Array(int16.buffer);
      liveWs.send(
        JSON.stringify({ type: "audio", data: bytesToBase64(bytes), mimeType: "audio/pcm;rate=16000" }),
      );
    };

    liveStatus.textContent = t().liveListening;
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
    } else if (msg.type === "inputTranscript") {
      // Echo of the user's own speech — proof the mic reached Gemini, and
      // a useful caption while the model is still composing its reply.
      liveInputTranscript += msg.text;
      stageCaption.textContent = `🎙️ ${liveInputTranscript}`;
      stageCaption.hidden = false;
    } else if (msg.type === "turnComplete") {
      playLiveTurn();
    } else if (msg.type === "interrupted") {
      presenter.interruptPresentation?.();
      liveTurnChunks = [];
      liveTurnTranscript = "";
      liveInputTranscript = "";
    } else if (msg.type === "error") {
      liveStatus.textContent = `Error: ${msg.message}`;
      console.error(`FriendChat live: ${msg.message}`);
    }
  });

  liveWs.addEventListener("close", () => {
    // Whether we were mid-"Connecting…" or fully live, a closed socket
    // ends this session — reset the button either way (previously a close
    // before setLiveUiActive(true) left the UI stuck on "Connecting…").
    if (liveWs) stopLive();
  });
  liveWs.addEventListener("error", () => {
    stopLive();
    liveStatus.textContent = t().liveConnError;
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
    stageError.textContent = t().stageError;
    stageError.hidden = false;
  }
  console.error(`FriendChat: ${err.message}`);
  return {};
});
