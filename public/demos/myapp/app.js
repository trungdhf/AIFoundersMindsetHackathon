/**
 * Perxona Connect Kit — Embed Demo
 *
 * An avatar answering questions on a page that already exists. Everything it
 * needs arrives resolved from GET /api/config; failures go to the console,
 * never the page — except a subscription issue (codes 1003 and 14005), a
 * fixed, non-technical sentence the visitor can act on. See README.md.
 * Zero dependencies — plain ESM, no build step required.
 */

/** @type {HTMLElement & import('@perxona/presenter-types').IPresentationWidget} */
const presenter = document.querySelector("sv-presenter");
/** @type {HTMLFormElement} */
const chatForm = document.querySelector("#chat-form");
/** @type {HTMLInputElement} */
const chatInput = document.querySelector("#chat-input");
/** @type {HTMLButtonElement} */
const sendBtn = document.querySelector("#send-btn");
const chatLog = document.getElementById("chat-log");
const chatPanel = document.getElementById("chat");
const quickTiles = document.getElementById("quick-tiles");
const topicTiles = document.getElementById("topic-tiles");
const dynamicChoices = document.getElementById("dynamic-choices");
const stageEl = document.getElementById("stage");
const stageQuestion = document.getElementById("stage-question");
const vocabCard = document.getElementById("vocab-card");
const vocabEmoji = document.getElementById("vocab-emoji");
const vocabHiragana = document.getElementById("vocab-hiragana");
const vocabWordEl = document.getElementById("vocab-word");
const vocabMeta = document.getElementById("vocab-meta");
const vocabRepeatBtn = document.getElementById("vocab-repeat");
const vocabNextBtn = document.getElementById("vocab-next");

// Serialized at the call site: the Connect chat API takes `parts`, not `content`.
/** @type {{role: "user"|"assistant", text: string}[]} */
const history = [];
const MAX_HISTORY_TURNS = 20; // 10 user + 10 assistant
const GREETING =
  "Hi! I'm your Japanese teacher. Pick a topic above, or use a button below to talk to me — no typing needed.";

// Lesson topics. Every one of these (except the quiz) opens a FIXED local
// card deck — see LESSON_DECKS below — not a chatbot conversation: a model
// picking content freely can't be paired with a known picture, tends to
// repeat itself, and depends on custom_instructions being followed exactly
// (the "[CHOICES: ...]" bug this same fix already solved for the quiz).
// Free-form questions still go to the chatbot via the text input below.
const TOPICS = [
  { jp: "単語", en: "Vocabulary flashcards", icon: "📗" },
  { jp: "練習問題", en: "Practice quiz", icon: "📝" },
  { jp: "あいさつ", en: "Greetings", icon: "👋" },
  { jp: "数字", en: "Numbers", icon: "🔢" },
  { jp: "家族", en: "Family", icon: "👨‍👩‍👧‍👦" },
  { jp: "食べ物", en: "Food", icon: "🍱" },
  { jp: "時間・曜日", en: "Time & days", icon: "🕐" },
  { jp: "買い物", en: "Shopping", icon: "🛍️" },
  { jp: "道案内", en: "Asking directions", icon: "🧭" },
  { jp: "自己紹介", en: "Self-introduction", icon: "🙋" },
];

// Practice quiz — a FIXED local deck, same reasoning as LESSON_DECKS: a chatbot
// asked to always append "[CHOICES: ...]" forgets sometimes (that's the bug
// this replaces), and this way scoring/feedback is instant and guaranteed
// correct instead of parsed from free-form model text.
const QUIZ_DECK = [
  { jp: "猫", hiragana: "ねこ", prompt: "What does this word mean?", choices: ["Dog", "Cat", "Bird", "Fish"], correct: "Cat" },
  { jp: "犬", hiragana: "いぬ", prompt: "What does this word mean?", choices: ["Cat", "Dog", "Fish", "Water"], correct: "Dog" },
  { jp: "水", hiragana: "みず", prompt: "What does this word mean?", choices: ["Fire", "Water", "Mountain", "Flower"], correct: "Water" },
  { jp: "火", hiragana: "ひ", prompt: "What does this word mean?", choices: ["Water", "Fire", "Family", "Friend"], correct: "Fire" },
  { jp: "山", hiragana: "やま", prompt: "What does this word mean?", choices: ["River", "Mountain", "Sea", "Sky"], correct: "Mountain" },
  { jp: "家族", hiragana: "かぞく", prompt: "What does this word mean?", choices: ["Friend", "Family", "Teacher", "School"], correct: "Family" },
  { jp: "先生", hiragana: "せんせい", prompt: "What does this word mean?", choices: ["Student", "Teacher", "Friend", "Family"], correct: "Teacher" },
  { jp: "りんご", hiragana: "りんご", prompt: "What does this word mean?", choices: ["Fish", "Apple", "Flower", "Mountain"], correct: "Apple" },
  { jp: null, hiragana: null, prompt: "How do you say hello in Japanese?", choices: ["さようなら", "ありがとう", "こんにちは", "すみません"], correct: "こんにちは" },
  { jp: null, hiragana: null, prompt: "How do you say thank you in Japanese?", choices: ["こんにちは", "ありがとう", "さようなら", "すみません"], correct: "ありがとう" },
  { jp: null, hiragana: null, prompt: "How do you say goodbye in Japanese?", choices: ["こんにちは", "ありがとう", "さようなら", "すみません"], correct: "さようなら" },
  { jp: "一", hiragana: "いち", prompt: "What number is this?", choices: ["Two", "Three", "One", "Four"], correct: "One" },
  { jp: "二", hiragana: "に", prompt: "What number is this?", choices: ["One", "Two", "Three", "Four"], correct: "Two" },
  { jp: "三", hiragana: "さん", prompt: "What number is this?", choices: ["One", "Two", "Three", "Four"], correct: "Three" },
];
let quizIndex = 0;

// Every lesson topic's cards — FIXED content, not chatbot-generated, so each
// word/phrase always carries a matching emoji "picture" (no image download —
// no network dependency, no licensing to check) and the avatar reads the
// exact text a fixed number of times. `jp` is what's shown; `hiragana` is
// what's actually spoken (see speakDeckCard — kanji alone can be misread as
// Chinese); when a card has no kanji, jp === hiragana and the card hides the
// redundant line.
const WORD_REPEATS = 3;
const LESSON_DECKS = {
  単語: [
    { jp: "猫", hiragana: "ねこ", romaji: "neko", en: "cat", emoji: "🐱" },
    { jp: "犬", hiragana: "いぬ", romaji: "inu", en: "dog", emoji: "🐶" },
    { jp: "魚", hiragana: "さかな", romaji: "sakana", en: "fish", emoji: "🐟" },
    { jp: "花", hiragana: "はな", romaji: "hana", en: "flower", emoji: "🌸" },
    { jp: "学校", hiragana: "がっこう", romaji: "gakkou", en: "school", emoji: "🏫" },
    { jp: "友達", hiragana: "ともだち", romaji: "tomodachi", en: "friend", emoji: "🧑‍🤝‍🧑" },
  ],
  あいさつ: [
    { jp: "こんにちは", hiragana: "こんにちは", romaji: "konnichiwa", en: "hello", emoji: "👋" },
    { jp: "おはよう", hiragana: "おはよう", romaji: "ohayou", en: "good morning", emoji: "🌅" },
    { jp: "こんばんは", hiragana: "こんばんは", romaji: "konbanwa", en: "good evening", emoji: "🌆" },
    { jp: "さようなら", hiragana: "さようなら", romaji: "sayounara", en: "goodbye", emoji: "🙋" },
    { jp: "ありがとう", hiragana: "ありがとう", romaji: "arigatou", en: "thank you", emoji: "🙏" },
  ],
  数字: [
    { jp: "一", hiragana: "いち", romaji: "ichi", en: "one", emoji: "1️⃣" },
    { jp: "二", hiragana: "に", romaji: "ni", en: "two", emoji: "2️⃣" },
    { jp: "三", hiragana: "さん", romaji: "san", en: "three", emoji: "3️⃣" },
    { jp: "四", hiragana: "よん", romaji: "yon", en: "four", emoji: "4️⃣" },
    { jp: "五", hiragana: "ご", romaji: "go", en: "five", emoji: "5️⃣" },
  ],
  家族: [
    { jp: "家族", hiragana: "かぞく", romaji: "kazoku", en: "family", emoji: "👨‍👩‍👧‍👦" },
    { jp: "母", hiragana: "はは", romaji: "haha", en: "mother", emoji: "👩" },
    { jp: "父", hiragana: "ちち", romaji: "chichi", en: "father", emoji: "👨" },
    { jp: "兄弟", hiragana: "きょうだい", romaji: "kyoudai", en: "siblings", emoji: "👫" },
  ],
  食べ物: [
    { jp: "ご飯", hiragana: "ごはん", romaji: "gohan", en: "rice / a meal", emoji: "🍚" },
    { jp: "寿司", hiragana: "すし", romaji: "sushi", en: "sushi", emoji: "🍣" },
    { jp: "水", hiragana: "みず", romaji: "mizu", en: "water", emoji: "💧" },
    { jp: "りんご", hiragana: "りんご", romaji: "ringo", en: "apple", emoji: "🍎" },
  ],
  "時間・曜日": [
    { jp: "今日", hiragana: "きょう", romaji: "kyou", en: "today", emoji: "📅" },
    { jp: "明日", hiragana: "あした", romaji: "ashita", en: "tomorrow", emoji: "🌄" },
    { jp: "月曜日", hiragana: "げつようび", romaji: "getsuyoubi", en: "Monday", emoji: "🗓️" },
    { jp: "時間", hiragana: "じかん", romaji: "jikan", en: "time", emoji: "⏰" },
  ],
  買い物: [
    { jp: "いくらですか", hiragana: "いくらですか", romaji: "ikura desu ka", en: "how much is it?", emoji: "💰" },
    { jp: "高い", hiragana: "たかい", romaji: "takai", en: "expensive", emoji: "💸" },
    { jp: "安い", hiragana: "やすい", romaji: "yasui", en: "cheap", emoji: "🏷️" },
    { jp: "お店", hiragana: "おみせ", romaji: "omise", en: "shop", emoji: "🏪" },
  ],
  道案内: [
    { jp: "駅", hiragana: "えき", romaji: "eki", en: "station", emoji: "🚉" },
    { jp: "右", hiragana: "みぎ", romaji: "migi", en: "right", emoji: "➡️" },
    { jp: "左", hiragana: "ひだり", romaji: "hidari", en: "left", emoji: "⬅️" },
    { jp: "まっすぐ", hiragana: "まっすぐ", romaji: "massugu", en: "straight ahead", emoji: "⬆️" },
  ],
  自己紹介: [
    { jp: "名前", hiragana: "なまえ", romaji: "namae", en: "name", emoji: "📛" },
    { jp: "はじめまして", hiragana: "はじめまして", romaji: "hajimemashite", en: "nice to meet you", emoji: "🤝" },
    { jp: "私は〜です", hiragana: "わたしは〜です", romaji: "watashi wa ~ desu", en: "I am ~", emoji: "🙋" },
  ],
};
let currentDeck = [];
let deckIndex = 0;

// Quick replies — common learner responses, sent as-is so no typing is needed.
// The Japanese phrase is what actually gets sent; the label just glosses it.
const QUICK_REPLIES = [
  { jp: "はい", en: "Yes", icon: "✅" },
  { jp: "いいえ", en: "No", icon: "❌" },
  { jp: "もう一度お願いします", en: "Please say it again", icon: "🔁" },
  { jp: "分かりました", en: "I understand", icon: "👍" },
  { jp: "分かりません", en: "I don't understand", icon: "🤔" },
  { jp: "ゆっくり話してください", en: "Please speak slowly", icon: "🐢" },
  { jp: "次へ進んでください", en: "Let's move on", icon: "➡️" },
  { jp: "覚えました。次の単語をお願いします", en: "Got it — next word please", icon: "✨" },
  { jp: "例文をもう一つください", en: "Give me another example sentence", icon: "💬" },
  { jp: "ありがとうございます", en: "Thank you", icon: "🙏" },
];
const FAILURE_REPLY = "Sorry — I couldn't reach the assistant just then.";
// Shown in #stage-error when start() rejects, whatever the cause — the
// actual reason (bad config, unreachable presenter engine, no chatbot yet)
// only ever reaches console.error. See README.md "Where the errors went".
const PRESENTER_UNAVAILABLE_REPLY =
  "This assistant isn't available right now. Please check back soon.";
const toConnectMessages = (turns) =>
  turns.map(({ role, text }) => ({ role, parts: [{ type: "text", text }] }));

// ── Gesture + emotion tags ──────────────────────────────────────────────────
// The chatbot's custom_instructions ask it to emit these short tags; see
// samples/express/public/demos/studio/app.js for the matching instructions
// text. IDs are for avatar cc085a01_female_xr_01 (01KVQ50VW08HWWZNWPKAX9DVBQ,
// skeleton f_cc) — re-fetch GET /api/avatars/:id/motions and rebuild this map
// if you change avatars.
const MOTION_TAGS = {
  "[wave]": "01KZD8C3PH4YGK56WKYEA3CFXH", // Right Hand Wave Greeting
  "[bow]": "01KZD89FZHTMFERT1G1KZYY3GC", // Formal Bow
  "[excited]": "01KZD8DC4MXM491S0J5GM8C05K", // Sudden Excited Reaction
  "[ok]": "01K4M9ABYK571VXG84BACSKK1T", // Female Talking OK — confirming
  "[thumbsup]": "01K4M9AQJEPKVX3HDKWWY4BH43", // Female Thumbup Stand — correct answer
  "[no]": "01K4M966TXRHH1GD1019WK8J0N", // Female Shaking Head No — wrong answer
  "[think]": "01KZD8BA45JPF4SVF5M1A3F3J8", // Casual Head Scratch — unsure
  "[clap]": "01KZD87C8R63BPD4555KWD2S75", // Clap and Rub Hands
  "[point]": "01KZD8E8P8F0BV6QABJVQV8Y86", // Right Hand Pointing Gesture
  "[present]": "01KZD86YJ04KR4A7PZ5A0NRW5P", // Bilateral Presentation Gesture
  "[question]": "01M2838R2DBQM1RXVW8SWM7HE0", // Questioning Gesture — asking a quiz question
};
const EMOTIONS = new Set([
  "joy", "excitement", "admiration", "caring", "gratitude", "sadness",
  "disappointment", "annoyance", "embarrassment", "curiosity", "surprise",
  "realization", "confusion",
]);
const INTENSITIES = new Set(["low", "neutral", "high"]);

/** Pull "(emo:x)" / "(emo:x/level)" out of text. Returns { text, options }. */
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

/** Rewrite the first known "[wave]" style tag into "[MOTION <id>:1]" at the
 * front of the text (a motion cued near the end of a short reply doesn't have
 * time to play); strips every "[x]" tag either way. */
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

/** Strip both tag kinds for what the chat log displays to the visitor. */
const forDisplay = (text) =>
  text.replace(/\[[a-z]+\]/g, "").replace(/\(emo:[^)]*\)/gi, "").trim();

/**
 * Pull "[CHOICES: option 1 | option 2 | option 3]" out of a quiz question.
 * Returns the cleaned text plus the option strings (empty array if none) —
 * these become one-tap answer buttons instead of the student typing them.
 */
function extractChoices(text) {
  let choices = [];
  const cleaned = text
    .replace(/\[CHOICES:\s*([^\]]+)\]/gi, (m, list) => {
      choices = list
        .split(/[|｜]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return "";
    })
    .trim();
  return { text: cleaned, choices };
}

const CHOICE_LETTERS = ["A", "B", "C", "D", "E", "F"];

/**
 * Show the current quiz question (top of stage) and its answer buttons
 * (bottom of stage) together; clears/hides both when choices is empty.
 * @param {string[]} choices
 * @param {string} [questionText] The question, already stripped of tags —
 *   only shown when there are choices to go with it.
 */
function renderChoices(choices, questionText = "") {
  const hasChoices = choices.length > 0;
  dynamicChoices.innerHTML = "";
  dynamicChoices.hidden = !hasChoices;
  stageQuestion.hidden = !hasChoices;
  stageQuestion.textContent = hasChoices ? questionText : "";
  stageEl.classList.toggle("has-choices", hasChoices);
  // A/B/C/D badge is purely a display label — data-text (what actually gets
  // sent when tapped) stays the real answer text, so the chatbot always sees
  // the full answer rather than having to remember what "A" referred to.
  choices.forEach((choice, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.text = choice;
    const letter = document.createElement("span");
    letter.className = "choice-letter";
    letter.textContent = CHOICE_LETTERS[i] ?? "";
    btn.append(letter, document.createTextNode(choice));
    dynamicChoices.append(btn);
  });
}
dynamicChoices.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-text]");
  if (btn) sendMessage(btn.dataset.text);
});

let audioUnlocked = false;
// Assigned by start(), which runs last — the chat can open before it resolves.
let config = null;

/**
 * GET without `body`, POST as JSON with it. Throws on non-2xx with a message
 * picked from whichever error shape actually reached the browser: a FastAPI
 * validation `detail`, the real Connect API's `details` (passed through
 * unchanged by server.mjs's route()), this server's own hand-rolled `error`,
 * or the HTTP status text as a last resort.
 */
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
    const message =
      (Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail) ??
      data.details ??
      data.error ??
      res.statusText;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data;
}

const CREDIT_EXHAUSTED_CODE = 1003;
const NO_SUBSCRIPTION_CODE = 14005;
// 1003 fires for two distinct backend conditions — credits run out, or the
// subscription's own status is no longer usable — and 400 either way. 14005
// is a third, separate condition with the same remedy (Console) but its own
// HTTP status (403): no subscription record exists for the org at all. All
// three share this one fixed, non-technical reply rather than naming one.
const isSubscriptionIssue = (code) =>
  code === CREDIT_EXHAUSTED_CODE || code === NO_SUBSCRIPTION_CODE;
const subscriptionIssueReply = () =>
  "Your organization's credits are used up or its subscription needs " +
  `attention. Check your usage at ${config?.subscriptionUrl}`;

function appendMessage(role, text) {
  const li = document.createElement("li");
  li.className = `msg msg--${role}`;
  li.textContent = text;
  chatLog.append(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadPresenterEngine(url) {
  // DEMO-ONLY: url is trusted without host validation. A production
  // integration should verify it against a known CDN allowlist.
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

// Attach before initializing: Ready is only ever an event, never readable state.
presenter.addEventListener("PRESENTER_STATUS", (/** @type {any} */ event) => {
  if (event.detail?.status !== "Ready") return;
  document.getElementById("stage-loading")?.remove();
  chatPanel.hidden = false;
  for (const btn of topicTiles.querySelectorAll("button")) btn.disabled = false;
  appendMessage("assistant", GREETING); // written, not spoken — no gesture yet
});

// Caption overlay on the stage — shows what the avatar is speaking right now,
// so a new word is visible the moment it's read aloud, not just in the chat
// log below. Cleared once the whole performance is done.
const stageCaption = document.getElementById("stage-caption");
presenter.addEventListener("PLAYING_SPEECH_TEXT", (/** @type {any} */ event) => {
  const text = event.detail?.text;
  if (!text) return;
  stageCaption.textContent = text;
  stageCaption.hidden = false;
});
presenter.addEventListener("ALL_PERFORMANCE_FINISHED", () => {
  stageCaption.hidden = true;
  stageCaption.textContent = "";
});

/** Disable the free-text input plus every quick-reply/topic tile while a turn is in flight. */
function setBusy(busy) {
  sendBtn.disabled = busy;
  chatInput.disabled = busy;
  for (const btn of quickTiles.querySelectorAll("button")) btn.disabled = busy;
  for (const btn of topicTiles.querySelectorAll("button")) btn.disabled = busy;
}

/**
 * Read one deck card (any topic's LESSON_DECKS entry) WORD_REPEATS times,
 * then say its meaning once, and show it — kana reading, emoji "picture",
 * romaji, meaning — on the card overlaying the top of the stage. Bypasses
 * the chatbot entirely: nothing here depends on an LLM, so the word/picture
 * pairing is always right and there's no "ですね"-style filler to creep in.
 */
async function speakDeckCard(word) {
  chatPanel.hidden = false; // in case a visitor opens a deck first thing
  renderChoices([]);
  vocabEmoji.textContent = word.emoji;
  vocabHiragana.textContent = word.hiragana;
  vocabWordEl.textContent = word.jp === word.hiragana ? "" : word.jp;
  vocabMeta.textContent = `${word.romaji} — ${word.en}`;
  vocabCard.hidden = false;
  setBusy(true);
  vocabRepeatBtn.disabled = true;
  vocabNextBtn.disabled = true;
  presenter.setThinking?.(false);
  try {
    // present() returns AUDIO_CONTEXT_UNAVAILABLE until this has run, and
    // autoplay policy allows it only from a user action — this click is one.
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }
    // Gesture via playMotion() — independent of the speech queue — so the
    // spoken text is always plain Japanese/English, never markup.
    presenter.playMotion(MOTION_TAGS["[present]"]);
    // Speak the HIRAGANA reading, never the bare kanji: a single kanji with no
    // surrounding Japanese context (e.g. 山 alone) is ambiguous CJK script, and
    // a multi-lingual voice can guess Chinese instead of Japanese. Hiragana is
    // Japanese-only script, so this is never misread. Kanji still shows on the
    // card for reading practice — it just isn't what gets spoken.
    //
    // WORD_REPEATS separate present() calls, each just the bare reading — no
    // joining/punctuation ("。" was suspect for the misread character) — the
    // SDK queues them and plays each in order, so this reads it exactly
    // WORD_REPEATS times with a natural pause between each.
    for (let i = 0; i < WORD_REPEATS; i++) {
      const r = await presenter.present(word.hiragana, {
        emotion: "caring",
        intensity: "neutral",
      });
      if (!r?.success)
        console.error(`Deck: repeat ${i + 1} present() failed (${r?.code}): ${r?.message ?? ""}`);
    }
    // Pure English, no Japanese script mixed into the same call: a multi-
    // lingual voice picks ONE language for the whole utterance from what it
    // sees, so a sentence combining hiragana + romaji + English got the
    // English words read with Japanese pronunciation. Separate calls let the
    // voice detect each language correctly. Romaji is on the card to read,
    // not spoken — saying it here reintroduces the same mixing problem.
    const r2 = await presenter.present(`That means ${word.en}.`);
    if (!r2?.success)
      console.error(`Deck: meaning present() failed (${r2?.code}): ${r2?.message ?? ""}`);
  } catch (err) {
    console.error(`Deck: ${err.message}`);
  } finally {
    setBusy(false);
    vocabRepeatBtn.disabled = false;
    vocabNextBtn.disabled = false;
  }
}

/** Open a topic's fixed card deck (see LESSON_DECKS) and speak its first card. */
function startDeck(topicJp, label) {
  currentDeck = LESSON_DECKS[topicJp];
  deckIndex = 0;
  appendMessage(
    "assistant",
    `${label} — ${currentDeck.length} cards. Tap "Next" when you're ready to continue.`,
  );
  speakDeckCard(currentDeck[deckIndex]);
}

/**
 * Ask one fixed quiz question — speaks the Japanese word (hiragana only, if
 * this question has one) and the English prompt as two separate present()
 * calls, never mixed in one, then shows the question + lettered answer
 * buttons as the stage overlay (question on top, choices on the bottom).
 */
async function speakQuizQuestion(q) {
  vocabCard.hidden = true;
  renderChoices([]); // clear the previous question's buttons first
  presenter.playMotion(MOTION_TAGS["[question]"]);
  setBusy(true);
  try {
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }
    if (q.hiragana) {
      const r0 = await presenter.present(q.hiragana, { emotion: "curiosity", intensity: "neutral" });
      if (!r0?.success)
        console.error(`Quiz: word present() failed (${r0?.code}): ${r0?.message ?? ""}`);
    }
    const r1 = await presenter.present(
      q.prompt,
      q.hiragana ? undefined : { emotion: "curiosity", intensity: "neutral" },
    );
    if (!r1?.success)
      console.error(`Quiz: prompt present() failed (${r1?.code}): ${r1?.message ?? ""}`);
  } catch (err) {
    console.error(`Quiz: ${err.message}`);
  } finally {
    setBusy(false);
  }

  const questionText = q.jp ? `${q.jp} (${q.hiragana}) — ${q.prompt}` : q.prompt;
  stageQuestion.hidden = false;
  stageQuestion.textContent = questionText;
  dynamicChoices.innerHTML = "";
  dynamicChoices.hidden = false;
  stageEl.classList.add("has-choices");
  q.choices.forEach((choice, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const letter = document.createElement("span");
    letter.className = "choice-letter";
    letter.textContent = CHOICE_LETTERS[i] ?? "";
    btn.append(letter, document.createTextNode(choice));
    btn.addEventListener("click", () => answerQuiz(choice, q.correct));
    dynamicChoices.append(btn);
  });
}

/** Score the tapped answer, react with matching motion/emotion, then offer "Next question". */
async function answerQuiz(chosen, correct) {
  for (const btn of dynamicChoices.querySelectorAll("button")) btn.disabled = true;
  const isCorrect = chosen === correct;
  presenter.playMotion(MOTION_TAGS[isCorrect ? "[thumbsup]" : "[no]"]);
  setBusy(true);
  try {
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }
    const feedback = isCorrect ? "Correct! Well done." : `Not quite. The correct answer is ${correct}.`;
    const r = await presenter.present(
      feedback,
      isCorrect ? { emotion: "joy", intensity: "high" } : { emotion: "caring", intensity: "neutral" },
    );
    if (!r?.success)
      console.error(`Quiz: feedback present() failed (${r?.code}): ${r?.message ?? ""}`);
  } catch (err) {
    console.error(`Quiz: ${err.message}`);
  } finally {
    setBusy(false);
  }

  stageQuestion.textContent = isCorrect ? "✅ Correct!" : `❌ Not quite — answer: ${correct}`;
  dynamicChoices.innerHTML = "";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.textContent = "Next question ➡";
  nextBtn.addEventListener("click", () => {
    quizIndex = (quizIndex + 1) % QUIZ_DECK.length;
    speakQuizQuestion(QUIZ_DECK[quizIndex]);
  });
  dynamicChoices.append(nextBtn);
}

function startQuizDeck() {
  quizIndex = 0;
  speakQuizQuestion(QUIZ_DECK[quizIndex]);
}

vocabRepeatBtn.addEventListener("click", () => speakDeckCard(currentDeck[deckIndex]));
vocabNextBtn.addEventListener("click", () => {
  deckIndex = (deckIndex + 1) % currentDeck.length;
  speakDeckCard(currentDeck[deckIndex]);
});

/**
 * Send `text` as the student's turn — used by the free-text form and by every
 * quick-reply / topic tile, so a tap behaves exactly like typing the same text.
 */
async function sendMessage(text) {
  if (!text || !config?.chatbotId) return;

  renderChoices([]); // the previous question's options no longer apply
  vocabCard.hidden = true; // leaving flashcard mode for a chatbot-driven topic
  appendMessage("user", text);
  history.push({ role: "user", text });
  setBusy(true);
  presenter.setThinking?.(true);

  try {
    // present() returns AUDIO_CONTEXT_UNAVAILABLE until this has run, and
    // autoplay policy allows it only from a user action — this submit is one.
    if (!audioUnlocked) {
      await presenter.resumeAudioPlayback?.();
      audioUnlocked = true;
    }

    const { reply_text: reply, status } = await request(
      `/api/chatbots/${config.chatbotId}/chat`,
      { messages: toConnectMessages(history.slice(-MAX_HISTORY_TURNS)) },
    );
    if (!reply) throw new Error(`chatbot returned status "${status}"`);

    const { text: withoutEmo, options } = extractEmotion(reply);
    const { text: withoutChoices, choices } = extractChoices(withoutEmo);
    // Debug aid: if a quiz question ever arrives with 0 choices, the raw
    // reply below will show whether the chatbot simply left out
    // "[CHOICES: ...]" (a custom_instructions/model problem) or sent it in a
    // shape extractChoices() doesn't recognize (a parsing problem here).
    console.debug(`Chat reply — ${choices.length} choice(s) parsed:`, reply);
    appendMessage("assistant", forDisplay(withoutChoices));
    history.push({ role: "assistant", text: reply }); // raw, tags included — keeps the model's own pattern in context
    presenter.setThinking?.(false);
    // Resolves with { success: false, … } rather than rejecting.
    const result = await presenter.present(expandMotionTags(withoutChoices), options);
    // This turn's quiz question + answers, if the reply had any — shown as
    // an overlay on the stage (question on top, buttons on the bottom).
    renderChoices(choices, forDisplay(withoutChoices));
    if (!result?.success)
      console.error(
        `Embed: present() failed (${result?.code}): ${result?.message ?? ""}`,
      );
  } catch (err) {
    // Drop the unanswered question, not the answer that may already be pushed.
    if (history.at(-1)?.role === "user") history.pop();
    presenter.setThinking?.(false);
    // The page may not show configuration; it may say something went wrong.
    // A subscription issue is the one exception carved out above — its reply
    // is a fixed string, never err.data.details (which echoes the org id
    // back). Requires subscriptionUrl too: config is {} when start() threw
    // (e.g. no chatbot yet), and the reply would otherwise read "Check your
    // usage at undefined" instead of falling back.
    const subscriptionIssue =
      isSubscriptionIssue(err.data?.code) && config?.subscriptionUrl;
    appendMessage(
      "error",
      subscriptionIssue ? subscriptionIssueReply() : FAILURE_REPLY,
    );
    console.error(
      subscriptionIssue
        ? `Embed: subscription issue (code ${err.data?.code}): ${err.data?.details ?? ""}`
        : `Embed: ${err.message}`,
    );
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

// One listener shape for both topic tiles and quick-reply tiles — each button
// just carries the exact text to send in data-text.
function onTileClick(event) {
  const btn = event.target.closest("button[data-text]");
  if (btn) sendMessage(btn.dataset.text);
}
quickTiles.addEventListener("click", onTileClick);
topicTiles.addEventListener("click", onTileClick);

function renderTiles() {
  // Labels are English-only to stay short and pack tightly into the grid; the
  // Japanese is still what's sent for quick replies (title shows it on hover).
  for (const t of TOPICS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${t.icon} ${t.en}`;
    btn.title = t.jp;
    btn.disabled = true; // enabled once PRESENTER_STATUS reports Ready
    // Every topic opens a fixed local deck — no chatbot involved. "練習問題"
    // is the one exception, with its own question+choices flow (startQuizDeck).
    if (t.jp === "練習問題") {
      btn.addEventListener("click", startQuizDeck);
    } else {
      btn.addEventListener("click", () => startDeck(t.jp, `${t.icon} ${t.en}`));
    }
    topicTiles.append(btn);
  }
  for (const r of QUICK_REPLIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${r.icon} ${r.en}`;
    btn.title = r.jp;
    btn.dataset.text = r.jp;
    quickTiles.append(btn);
  }
}
renderTiles();

// Called last: a rejection in top-level await would abort module evaluation
// and leave every handler above unregistered.
async function start() {
  const cfg = await request("/api/config");
  const blocker =
    (cfg.mock && "mock mode cannot drive the presenter") ||
    (!cfg.fixedTarget &&
      "no presenter target — see the server's startup log") ||
    (!cfg.chatbotId &&
      "no chatbot in this account yet. Create one in the Studio demo and " +
        "reload — or set DEMO_FIXED_CHATBOT_ID");
  if (blocker) throw new Error(blocker);
  await loadPresenterEngine(cfg.presenterUrl);
  const { connect_key: connectKey } = await request("/api/connect-key");
  await presenter.initializeWithConnectKey(connectKey, cfg.fixedTarget);
  return cfg;
}

config = await start().catch((err) => {
  document.getElementById("stage-loading")?.remove();
  const stageError = document.getElementById("stage-error");
  if (stageError) {
    stageError.textContent = PRESENTER_UNAVAILABLE_REPLY;
    stageError.hidden = false;
  }
  console.error(`Embed: ${err.message}`);
  return {};
});
