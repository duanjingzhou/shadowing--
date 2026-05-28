const STORAGE_KEY = "shadowing-studio-state";
const DB_NAME = "shadowing-studio-recordings";
const DB_VERSION = 1;

const state = {
  videoId: "",
  segmentStart: 0,
  segmentEnd: 10,
  activeSegmentId: null,
  segments: [],
  subtitles: [],
  takes: [],
  lastTakeUrl: null,
  lastTakeDuration: null,
};

let player = null;
let playerReady = false;
let pendingVideoId = "";
let recorder = null;
let audioContext = null;
let analyser = null;
let micStream = null;
let chunks = [];
let recordStartedAt = 0;
let recordTimer = null;
let meterTimer = null;
let loopTimer = null;
let subtitleTimer = null;

const els = {
  videoForm: document.querySelector("#videoForm"),
  youtubeUrl: document.querySelector("#youtubeUrl"),
  playerEmpty: document.querySelector("#playerEmpty"),
  playerNotice: document.querySelector("#playerNotice"),
  playerNoticeTitle: document.querySelector("#playerNoticeTitle"),
  playerNoticeText: document.querySelector("#playerNoticeText"),
  playerNoticeLink: document.querySelector("#playerNoticeLink"),
  playerStatus: document.querySelector("#playerStatus"),
  playBtn: document.querySelector("#playBtn"),
  pauseBtn: document.querySelector("#pauseBtn"),
  backBtn: document.querySelector("#backBtn"),
  forwardBtn: document.querySelector("#forwardBtn"),
  setStartBtn: document.querySelector("#setStartBtn"),
  setEndBtn: document.querySelector("#setEndBtn"),
  speedSelect: document.querySelector("#speedSelect"),
  loopToggle: document.querySelector("#loopToggle"),
  startTime: document.querySelector("#startTime"),
  endTime: document.querySelector("#endTime"),
  segmentLength: document.querySelector("#segmentLength"),
  subtitleLanguage: document.querySelector("#subtitleLanguage"),
  loadSubtitlesBtn: document.querySelector("#loadSubtitlesBtn"),
  subtitleStatus: document.querySelector("#subtitleStatus"),
  subtitleList: document.querySelector("#subtitleList"),
  timingTarget: document.querySelector("#timingTarget"),
  segmentTitle: document.querySelector("#segmentTitle"),
  segmentText: document.querySelector("#segmentText"),
  addSegmentBtn: document.querySelector("#addSegmentBtn"),
  recordBtn: document.querySelector("#recordBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  playTakeBtn: document.querySelector("#playTakeBtn"),
  downloadTakeBtn: document.querySelector("#downloadTakeBtn"),
  recordingState: document.querySelector("#recordingState"),
  recordingTime: document.querySelector("#recordingTime"),
  micHelp: document.querySelector("#micHelp"),
  meterFill: document.querySelector("#meterFill"),
  takeDuration: document.querySelector("#takeDuration"),
  timingDelta: document.querySelector("#timingDelta"),
  practiceNotes: document.querySelector("#practiceNotes"),
  segmentsList: document.querySelector("#segmentsList"),
  takesList: document.querySelector("#takesList"),
  clearSegmentsBtn: document.querySelector("#clearSegmentsBtn"),
  clearTakesBtn: document.querySelector("#clearTakesBtn"),
};

window.onYouTubeIframeAPIReady = () => {
  const id = pendingVideoId || state.videoId;
  if (id) {
    renderEmbedPlayer(id);
    attachPlayerApi();
  }
};

function extractYouTubeId(value) {
  const raw = value.trim();
  if (!raw) return "";

  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.slice(1).split("/")[0];
    }
    if (url.searchParams.get("v")) {
      return url.searchParams.get("v");
    }
    const embedMatch = url.pathname.match(/\/(embed|shorts)\/([a-zA-Z0-9_-]{11})/);
    return embedMatch ? embedMatch[2] : "";
  } catch {
    return "";
  }
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;

  try {
    const parsed = JSON.parse(saved);
    state.videoId = parsed.videoId || "";
    state.segmentStart = Number(parsed.segmentStart) || 0;
    state.segmentEnd = Number(parsed.segmentEnd) || 10;
    state.activeSegmentId = parsed.activeSegmentId || null;
    state.segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    state.subtitles = Array.isArray(parsed.subtitles) ? parsed.subtitles : [];
    state.takes = Array.isArray(parsed.takes) ? parsed.takes : [];
    els.segmentText.value = parsed.segmentText || "";
    els.practiceNotes.value = parsed.practiceNotes || "";
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function hydrateActiveSegment() {
  const active = state.segments.find((segment) => segment.id === state.activeSegmentId);
  if (!active) {
    state.activeSegmentId = null;
    els.segmentTitle.textContent = "Free practice";
    return;
  }

  els.segmentTitle.textContent = active.title;
}

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      videoId: state.videoId,
      segmentStart: state.segmentStart,
      segmentEnd: state.segmentEnd,
      activeSegmentId: state.activeSegmentId,
      segments: state.segments,
      subtitles: state.subtitles,
      takes: state.takes.map(({ blob, url, ...take }) => take),
      segmentText: els.segmentText.value,
      practiceNotes: els.practiceNotes.value,
    }),
  );
}

function setStatus(text) {
  els.playerStatus.textContent = text;
}

function showPlayerNotice(title, text, videoId) {
  els.playerNoticeTitle.textContent = title;
  els.playerNoticeText.textContent = text;
  els.playerNoticeLink.href = `https://www.youtube.com/watch?v=${videoId}`;
  els.playerEmpty.classList.add("hidden");
  els.playerNotice.classList.remove("hidden");
}

function hidePlayerNotice() {
  els.playerNotice.classList.add("hidden");
}

function loadVideo(id, autoplay = false) {
  pendingVideoId = id;
  hidePlayerNotice();
  els.playerEmpty.classList.add("hidden");
  renderEmbedPlayer(id);
  attachPlayerApi();

  if (!playerReady || !player) {
    setStatus("Video loaded");
    enablePlayerCaptions();
    els.subtitleStatus.textContent =
      "Video is loaded. A-B controls activate after the YouTube player API connects.";
    return;
  }

  if (autoplay && player.loadVideoById) {
    player.loadVideoById({ videoId: id, startSeconds: 0 });
  } else if (player.cueVideoById) {
    player.cueVideoById({ videoId: id, startSeconds: 0 });
  }
  setStatus(autoplay ? "Loading video" : "Video cued");
  window.setTimeout(enablePlayerCaptions, 900);
  els.subtitleStatus.textContent = "Click Load subtitles to fetch YouTube captions.";
}

function renderEmbedPlayer(id) {
  const playerRoot = document.querySelector("#player");
  if (!playerRoot) return;
  const currentFrame = document.querySelector("#youtubeFrame");
  const currentSrc = currentFrame?.getAttribute("src") || "";
  if (currentSrc.includes(`/embed/${id}`)) return;

  playerReady = false;
  player = null;
  const originParam = window.location.protocol.startsWith("http")
    ? `&origin=${encodeURIComponent(window.location.origin)}`
    : "";
  playerRoot.innerHTML = `
    <iframe
      id="youtubeFrame"
      width="100%"
      height="100%"
      src="https://www.youtube.com/embed/${id}?rel=0&modestbranding=1&playsinline=1&cc_load_policy=1&enablejsapi=1${originParam}"
      title="YouTube video player"
      frameborder="0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen
    ></iframe>
  `;
  els.playerEmpty.classList.add("hidden");
}

function attachPlayerApi() {
  if (player || !window.YT?.Player || !document.querySelector("#youtubeFrame")) return;
  player = new YT.Player("youtubeFrame", {
    events: {
      onReady: () => {
        playerReady = true;
        setStatus("Video ready");
        enablePlayerCaptions();
      },
      onStateChange: () => syncPlayerStatus(),
      onError: (event) => handlePlayerError(event.data),
    },
  });
}

function enablePlayerCaptions() {
  if (!playerReady || !player) return;
  const languageCode = els.subtitleLanguage.value || "en";
  try {
    if (player.loadModule) player.loadModule("captions");
    if (player.setOption) {
      player.setOption("captions", "track", { languageCode });
      player.setOption("captions", "fontSize", 1);
    }
  } catch (error) {
    console.debug("Could not enable embedded captions", error);
  }
}

function handlePlayerError(code) {
  const messages = {
    2: "The video ID was rejected by YouTube.",
    5: "This video cannot play in the HTML player.",
    100: "This video is unavailable or private.",
    101: "The owner does not allow this video to be embedded.",
    150: "The owner does not allow this video to be embedded.",
  };
  const text = messages[code] || "YouTube could not load this video.";
  setStatus("Video unavailable");
  showPlayerNotice("YouTube playback issue", text, state.videoId);
}

function syncPlayerStatus() {
  if (!playerReady || !player) return;
  const labels = {
    [-1]: "Video ready",
    0: "Ended",
    1: "Playing",
    2: "Paused",
    3: "Buffering",
    5: "Video cued",
  };
  setStatus(labels[player.getPlayerState()] || "Video ready");
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const secs = safe - mins * 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

function formatSeconds(seconds) {
  return `${Math.max(0, seconds).toFixed(1)}s`;
}

function getSegmentDuration() {
  return Math.max(0, state.segmentEnd - state.segmentStart);
}

function updateSegmentDisplay() {
  const duration = getSegmentDuration();
  els.startTime.textContent = formatTime(state.segmentStart);
  els.endTime.textContent = formatTime(state.segmentEnd);
  els.segmentLength.textContent = formatSeconds(duration);
  els.timingTarget.value = formatSeconds(duration);

  if (state.lastTakeDuration !== null) {
    updateTimingReadout(state.lastTakeDuration);
  }
}

function setSubtitleStatus(text) {
  els.subtitleStatus.textContent = text;
}

function updateTimingReadout(takeSeconds) {
  const target = getSegmentDuration();
  const delta = takeSeconds - target;
  els.takeDuration.value = formatSeconds(takeSeconds);
  els.timingDelta.value = `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}s`;
}

function getCurrentTime() {
  if (!playerReady || !player || !player.getCurrentTime) return 0;
  return player.getCurrentTime();
}

function seekTo(seconds) {
  if (!playerReady || !player || !player.seekTo) return;
  player.seekTo(Math.max(0, seconds), true);
}

function playSegment() {
  if (!playerReady || !player) return;
  seekTo(state.segmentStart);
  player.playVideo();
}

function startLoopWatcher() {
  clearInterval(loopTimer);
  loopTimer = setInterval(() => {
    if (!els.loopToggle.checked || !playerReady || !player) return;
    if (player.getPlayerState && player.getPlayerState() !== YT.PlayerState.PLAYING) return;
    if (getCurrentTime() >= state.segmentEnd) {
      seekTo(state.segmentStart);
    }
  }, 140);
}

function startSubtitleWatcher() {
  clearInterval(subtitleTimer);
  subtitleTimer = setInterval(() => {
    if (!state.subtitles.length || !playerReady || !player) return;
    const current = getCurrentTime();
    const active = state.subtitles.findIndex(
      (cue) => current >= cue.start && current <= cue.end,
    );
    document.querySelectorAll(".subtitle-cue.active").forEach((item) => {
      item.classList.remove("active");
    });
    if (active >= 0) {
      const cue = document.querySelector(`[data-cue-index="${active}"]`);
      cue?.classList.add("active");
    }
  }, 300);
}

function renderSubtitles() {
  if (!state.subtitles.length) {
    els.subtitleList.innerHTML = "";
    return;
  }

  els.subtitleList.innerHTML = state.subtitles
    .map((cue, index) => {
      return `
        <button type="button" class="subtitle-cue" data-cue-index="${index}">
          <span>${formatTime(cue.start)}</span>
          <strong>${escapeHtml(cue.text)}</strong>
        </button>
      `;
    })
    .join("");
}

function renderSegments() {
  if (!state.segments.length) {
    els.segmentsList.innerHTML = '<div class="empty-state">No saved segments yet.</div>';
    return;
  }

  els.segmentsList.innerHTML = state.segments
    .map((segment) => {
      const isActive = segment.id === state.activeSegmentId ? " active" : "";
      return `
        <article class="segment-card${isActive}" data-id="${segment.id}">
          <div class="timecode">${formatTime(segment.start)} - ${formatTime(segment.end)}</div>
          <div class="segment-copy">
            <strong>${escapeHtml(segment.title)}</strong>
            <p>${escapeHtml(segment.text || "Untitled line")}</p>
          </div>
          <button type="button" data-action="load-segment" data-id="${segment.id}">Load</button>
        </article>
      `;
    })
    .join("");
}

function renderTakes() {
  if (!state.takes.length) {
    els.takesList.innerHTML = '<div class="empty-state">Your recordings will appear here.</div>';
    return;
  }

  els.takesList.innerHTML = state.takes
    .map((take) => {
      return `
        <article class="take-card">
          <div class="timecode">${formatSeconds(take.duration)}</div>
          <div class="take-copy">
            <strong>${escapeHtml(take.segmentTitle)}</strong>
            <p>${escapeHtml(take.notes || "No notes")}</p>
          </div>
          <button type="button" data-action="play-take" data-url="${take.url}">Play</button>
          <a class="button-link" href="${take.url}" download="${escapeHtml(take.filename)}">Save</a>
        </article>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeSegmentTitle() {
  const index = state.segments.length + 1;
  return `Segment ${index}`;
}

function loadSegment(segment) {
  state.segmentStart = segment.start;
  state.segmentEnd = segment.end;
  state.activeSegmentId = segment.id;
  els.segmentText.value = segment.text || "";
  els.segmentTitle.textContent = segment.title;
  updateSegmentDisplay();
  renderSegments();
  saveState();
  seekTo(state.segmentStart);
}

function loadCueAsSegment(cue, index) {
  state.segmentStart = cue.start;
  state.segmentEnd = cue.end;
  state.activeSegmentId = null;
  els.segmentTitle.textContent = `Subtitle ${index + 1}`;
  els.segmentText.value = cue.text;
  updateSegmentDisplay();
  renderSegments();
  saveState();
  seekTo(cue.start);
}

async function loadSubtitles() {
  if (window.location.protocol === "file:") {
    setSubtitleStatus(
      "双击 index.html 打开时不能抓取字幕文字列表；可以使用 YouTube 播放器里的 CC 字幕。需要字幕列表时再用 server.py 启动。",
    );
    return;
  }

  if (!state.videoId) {
    setSubtitleStatus("Load a YouTube video first.");
    return;
  }

  setSubtitleStatus("Fetching captions from YouTube...");
  els.loadSubtitlesBtn.disabled = true;

  try {
    const params = new URLSearchParams({
      video_id: state.videoId,
      lang: els.subtitleLanguage.value,
    });
    const response = await fetch(`/api/subtitles?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not load subtitles.");
    }
    state.subtitles = payload.cues || [];
    renderSubtitles();
    setSubtitleStatus(
      `${state.subtitles.length} cues loaded (${payload.languageName || payload.language || "captions"}). Click a line to shadow it.`,
    );
    saveState();
  } catch (error) {
    state.subtitles = [];
    renderSubtitles();
    setSubtitleStatus(`${error.message} Some videos do not publish captions.`);
  } finally {
    els.loadSubtitlesBtn.disabled = false;
  }
}

function openRecordingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRecordingBlob(id, blob) {
  const db = await openRecordingDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("recordings", "readwrite");
    transaction.objectStore("recordings").put(blob, id);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function getRecordingBlob(id) {
  const db = await openRecordingDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("recordings", "readonly");
    const request = transaction.objectStore("recordings").get(id);
    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

async function deleteRecordingBlob(id) {
  const db = await openRecordingDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("recordings", "readwrite");
    transaction.objectStore("recordings").delete(id);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function hydrateTakes() {
  const hydrated = [];
  for (const take of state.takes) {
    const blob = await getRecordingBlob(take.id);
    if (!blob) continue;
    hydrated.push({
      ...take,
      url: URL.createObjectURL(blob),
    });
  }
  state.takes = hydrated;
  if (state.takes.length) {
    setLatestTake(state.takes[0]);
  }
  renderTakes();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    els.recordingState.textContent = "Recording is not supported in this browser";
    return;
  }

  els.recordingState.textContent = "Requesting microphone...";
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  els.micHelp.textContent = "Microphone connected.";
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioContext.createMediaStreamSource(micStream).connect(analyser);

  chunks = [];
  recorder = new MediaRecorder(micStream);
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = finishRecording;
  recorder.start();

  recordStartedAt = performance.now();
  els.recordBtn.disabled = true;
  els.stopBtn.disabled = false;
  els.playTakeBtn.disabled = true;
  els.recordingState.textContent = "Recording";

  recordTimer = setInterval(() => {
    const elapsed = (performance.now() - recordStartedAt) / 1000;
    els.recordingTime.textContent = formatTime(elapsed);
  }, 100);

  meterTimer = setInterval(updateMeter, 80);
  playSegment();
}

function describeMicError(error) {
  const name = error?.name || "Error";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Microphone permission was denied. Allow microphone access for localhost, then try again. If you are using the in-app browser, open the app in Chrome or Safari because this browser may block mic capture.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Connect or enable an input device, then try again.";
  }
  if (name === "NotReadableError") {
    return "The microphone is being used by another app. Close the other app and try again.";
  }
  if (!window.isSecureContext) {
    return "Recording needs a secure browser context. Use http://localhost:5173 or HTTPS.";
  }
  return `Microphone could not start: ${name}`;
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

async function finishRecording() {
  clearInterval(recordTimer);
  clearInterval(meterTimer);

  const duration = (performance.now() - recordStartedAt) / 1000;
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const url = URL.createObjectURL(blob);
  const id = crypto.randomUUID();
  const filename = makeRecordingFilename(id);

  const segmentTitle = els.segmentTitle.textContent || "Free practice";
  const take = {
    id,
    url,
    duration,
    filename,
    segmentTitle,
    notes: els.practiceNotes.value.trim(),
    createdAt: new Date().toISOString(),
  };
  saveRecordingBlob(id, blob).catch((error) => {
    console.error(error);
    els.micHelp.textContent =
      "The recording can be downloaded now, but browser storage did not save it for reload.";
  });
  state.takes.unshift(take);
  setLatestTake(take);

  els.recordBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.recordingState.textContent = "Take saved";
  els.recordingTime.textContent = formatTime(duration);
  els.meterFill.style.width = "0%";

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
  }
  if (audioContext) {
    audioContext.close();
  }

  renderTakes();
  saveState();
}

function makeRecordingFilename(id) {
  const date = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  return `shadowing-take-${date}-${id.slice(0, 8)}.webm`;
}

function setLatestTake(take) {
  state.lastTakeUrl = take.url;
  state.lastTakeDuration = take.duration;
  els.playTakeBtn.disabled = false;
  els.downloadTakeBtn.classList.remove("disabled");
  els.downloadTakeBtn.href = take.url;
  els.downloadTakeBtn.download = take.filename;
  updateTimingReadout(take.duration);
}

function updateMeter() {
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const average = data.reduce((sum, value) => sum + value, 0) / data.length;
  const width = Math.min(100, Math.max(5, average * 1.15));
  els.meterFill.style.width = `${width}%`;
}

function playAudioUrl(url) {
  const audio = new Audio(url);
  audio.play();
}

els.videoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = extractYouTubeId(els.youtubeUrl.value);
  if (!id) {
    setStatus("Invalid YouTube URL");
    return;
  }

  state.videoId = id;
  state.subtitles = [];
  renderSubtitles();
  loadVideo(id, true);
  saveState();
});

els.playBtn.addEventListener("click", () => {
  if (playerReady && player) player.playVideo();
});

els.pauseBtn.addEventListener("click", () => {
  if (playerReady && player) player.pauseVideo();
});

els.backBtn.addEventListener("click", () => seekTo(getCurrentTime() - 3));
els.forwardBtn.addEventListener("click", () => seekTo(getCurrentTime() + 3));

els.setStartBtn.addEventListener("click", () => {
  state.segmentStart = getCurrentTime();
  if (state.segmentEnd <= state.segmentStart) {
    state.segmentEnd = state.segmentStart + 5;
  }
  updateSegmentDisplay();
  saveState();
});

els.setEndBtn.addEventListener("click", () => {
  state.segmentEnd = Math.max(state.segmentStart + 1, getCurrentTime());
  updateSegmentDisplay();
  saveState();
});

els.speedSelect.addEventListener("change", () => {
  if (playerReady && player && player.setPlaybackRate) {
    player.setPlaybackRate(Number(els.speedSelect.value));
  }
});

els.loopToggle.addEventListener("change", () => {
  if (els.loopToggle.checked) {
    playSegment();
  }
});

els.addSegmentBtn.addEventListener("click", () => {
  const title = makeSegmentTitle();
  const segment = {
    id: crypto.randomUUID(),
    title,
    start: state.segmentStart,
    end: state.segmentEnd,
    text: els.segmentText.value.trim(),
  };
  state.segments.unshift(segment);
  state.activeSegmentId = segment.id;
  els.segmentTitle.textContent = title;
  renderSegments();
  saveState();
});

els.loadSubtitlesBtn.addEventListener("click", loadSubtitles);
els.subtitleLanguage.addEventListener("change", enablePlayerCaptions);

els.recordBtn.addEventListener("click", () => {
  startRecording().catch((error) => {
    const message = describeMicError(error);
    els.recordingState.textContent = "Recording blocked";
    els.micHelp.textContent = message;
    console.error(error);
  });
});

els.stopBtn.addEventListener("click", stopRecording);

els.playTakeBtn.addEventListener("click", () => {
  if (state.lastTakeUrl) playAudioUrl(state.lastTakeUrl);
});

els.segmentsList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='load-segment']");
  if (!button) return;
  const segment = state.segments.find((item) => item.id === button.dataset.id);
  if (segment) loadSegment(segment);
});

els.takesList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action='play-take']");
  if (button?.dataset.url) playAudioUrl(button.dataset.url);
});

els.subtitleList.addEventListener("click", (event) => {
  const button = event.target.closest(".subtitle-cue");
  if (!button) return;
  const index = Number(button.dataset.cueIndex);
  const cue = state.subtitles[index];
  if (cue) loadCueAsSegment(cue, index);
});

els.clearSegmentsBtn.addEventListener("click", () => {
  state.segments = [];
  state.activeSegmentId = null;
  els.segmentTitle.textContent = "Free practice";
  renderSegments();
  saveState();
});

els.clearTakesBtn.addEventListener("click", () => {
  state.takes.forEach((take) => {
    deleteRecordingBlob(take.id).catch(console.error);
    if (take.url) URL.revokeObjectURL(take.url);
  });
  state.takes = [];
  state.lastTakeUrl = null;
  state.lastTakeDuration = null;
  els.playTakeBtn.disabled = true;
  els.downloadTakeBtn.classList.add("disabled");
  els.downloadTakeBtn.href = "#";
  els.takeDuration.value = "-";
  els.timingDelta.value = "-";
  renderTakes();
  saveState();
});

els.segmentText.addEventListener("input", saveState);
els.practiceNotes.addEventListener("input", saveState);

loadState();
hydrateActiveSegment();
updateSegmentDisplay();
renderSegments();
renderTakes();
hydrateTakes().catch(console.error);
renderSubtitles();
startLoopWatcher();
startSubtitleWatcher();

if (state.videoId) {
  els.youtubeUrl.value = `https://www.youtube.com/watch?v=${state.videoId}`;
  loadVideo(state.videoId, false);
}

if (window.location.protocol === "file:") {
  setSubtitleStatus(
    "当前是双击本地文件模式：视频、录音和下载可用；字幕文字列表需要本地服务器，播放器自带 CC 字幕仍可用。",
  );
}
