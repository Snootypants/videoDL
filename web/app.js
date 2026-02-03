const API_BASE = 'http://127.0.0.1:5050';
const DEFAULT_SAVE_PATH = '~/Downloads';
let videoInfoMode = 'auto'; // auto -> try API first, then fall back to mock
const downloadMode = 'live'; // live -> hit backend endpoint

const selectors = {
  url: document.getElementById('video-url'),
  location: document.getElementById('save-location'),
  advancedToggle: document.getElementById('advanced-toggle'),
  advancedPanel: document.getElementById('advanced-panel'),
  authStatus: document.getElementById('auth-status'),
  ytdlpVersion: document.getElementById('ytdlp-version'),
  authGet: document.getElementById('auth-get'),
  authError: document.getElementById('auth-error'),
  language: document.getElementById('language'),
  quality: document.getElementById('quality'),
  downloadBtn: document.getElementById('download-btn'),
  statusPill: document.getElementById('status-pill'),
  percentLabel: document.getElementById('percent-label'),
  progressFill: document.getElementById('progress-fill'),
  progressSubline: document.getElementById('progress-subline'),
  title: document.getElementById('video-title'),
  duration: document.getElementById('video-duration'),
  host: document.getElementById('video-host'),
  description: document.getElementById('video-description'),
  thumbnail: document.getElementById('video-image'),
  downloadNote: document.getElementById('download-note'),
  form: document.getElementById('download-form')
};

const ADVANCED_PROMPT = 'Open Advanced to choose';
const NO_VIDEO_PROMPT = 'Select a video first';
const AUTH_SOURCE_LABEL = 'Auth source: Chrome';
let fetchTimeout = null;
let cachedFormats = [];
let availableLanguages = [];
let selectedLanguage = '';
let selectedQuality = '';
let currentSavePath = DEFAULT_SAVE_PATH;
setDefaultSaveLocation();
fetchDefaultPathFromApi();
fetchDiagnosticsFromApi();
setAdvancedAvailability(false);
setAdvancedPrompt(NO_VIDEO_PROMPT);
setAuthStatus({ ok: false });
setAuthError(false);
refreshAuthStatus();

selectors.url.addEventListener('input', () => {
  selectors.downloadBtn.disabled = true;

  clearTimeout(fetchTimeout);
  const url = selectors.url.value.trim();
  setAdvancedAvailability(false);
  setAdvancedPrompt(url ? ADVANCED_PROMPT : NO_VIDEO_PROMPT);
  if (!url) {
    cachedFormats = [];
    availableLanguages = [];
    selectedLanguage = '';
    selectedQuality = '';
    resetVideoMeta();
    setAuthError(false);
    return;
  }

  fetchTimeout = setTimeout(() => fetchVideoInfo(url), 450);
});

selectors.advancedToggle.addEventListener('click', () => {
  if (selectors.advancedToggle.disabled) {
    return;
  }
  if (selectors.advancedPanel.classList.contains('is-collapsed')) {
    expandAdvancedPanel();
  } else {
    collapseAdvancedPanel();
  }
});

selectors.authGet.addEventListener('click', () => {
  requestAuthGet();
});

selectors.language.addEventListener('change', () => {
  selectedLanguage = selectors.language.value;
  populateQualityDropdown(cachedFormats, selectedLanguage, '');
});

selectors.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const qualityValue = selectors.quality.value || selectedQuality;
  const languageValue = selectors.language.value || selectedLanguage;
  if (!selectors.url.value || !selectors.location.value || !qualityValue) {
    return;
  }

  selectors.downloadBtn.disabled = true;
  updateProgress(0, 'Starting download…');

  let stopProgress = null;
  try {
    stopProgress = beginPseudoProgress();
    const result = await requestDownload({
      url: selectors.url.value.trim(),
      quality: qualityValue,
      path: selectors.location.value.trim(),
      language: languageValue
    });
    updateProgress(100, 'Download complete');
    updateProgressDetails();
    updateDownloadNote(result?.filepath);
  } catch (error) {
    console.error(error);
    selectors.statusPill.textContent = 'Failed';
    selectors.statusPill.style.background = 'rgba(248,81,73,0.15)';
    selectors.statusPill.style.borderColor = 'rgba(248,81,73,0.4)';
    selectors.percentLabel.textContent = '0%';
    selectors.progressFill.style.width = '0%';
    updateProgressDetails();
  } finally {
    if (typeof stopProgress === 'function') {
      stopProgress();
    }
    selectors.downloadBtn.disabled = false;
  }
});

async function fetchVideoInfo(url) {
  if (!isValidUrl(url)) {
    setAuthStatus({ ok: false, reason: 'Invalid URL' });
    setAuthError(false);
    setAdvancedAvailability(false);
    setAdvancedPrompt(NO_VIDEO_PROMPT);
    updateVideoMeta({
      title: 'Invalid URL',
      description: 'Invalid URL',
      thumbnail: null,
      label: 'Invalid URL',
      host: null,
      duration: null
    });
    return;
  }
  const host = deriveHostLabel(url);
  updateVideoMeta({
    title: 'Fetching video details…',
    description: 'Hang tight while we look up this video.',
    thumbnail: null,
    label: 'Fetching preview…',
    host,
    duration: null
  });
  refreshAuthStatus(url);
  setAuthError(false);

  try {
    const data = videoInfoMode === 'mock'
      ? await mockVideoInfo(url)
      : await realVideoInfo(url);

    cachedFormats = data.formats || [];
    availableLanguages = deriveLanguageOptions(data.languages, cachedFormats);
    selectedLanguage = pickDefaultLanguage(availableLanguages);
    selectedQuality = pickDefaultQuality(cachedFormats, selectedLanguage);
    setAdvancedAvailability(true);
    if (selectors.advancedPanel.classList.contains('is-collapsed')) {
      setAdvancedPrompt(ADVANCED_PROMPT);
    } else {
      hydrateAdvancedOptions();
    }
    updateVideoMeta({
      title: data.title || 'Untitled video',
      description: data.description || 'No description provided.',
      thumbnail: data.thumbnail || null,
      label: 'No thumbnail available',
      host,
      duration: data.duration
    });
    setAuthError(false);
    selectors.downloadBtn.disabled = false;
  } catch (error) {
    console.error(error);
    if (error?.code === 'AUTH_REQUIRED') {
      setAuthStatus({ ok: false, reason: error.detail || 'Auth required' });
      setAuthError(true);
      selectedLanguage = '';
      selectedQuality = '';
      setAdvancedAvailability(false);
      setAdvancedPrompt('Auth required');
      updateVideoMeta({
        title: 'Auth required',
        description: 'Connect browser cookies to load metadata.',
        thumbnail: null,
        label: 'Auth required',
        host,
        duration: null
      });
      return;
    }
    if (videoInfoMode === 'auto') {
      videoInfoMode = 'mock';
      console.warn('Falling back to mock data. Start web/server.py to hit the real API.');
      return fetchVideoInfo(url);
    }
    selectedLanguage = '';
    selectedQuality = '';
    setAdvancedAvailability(false);
    setAdvancedPrompt(NO_VIDEO_PROMPT);
    updateVideoMeta({
      title: 'No data',
      description: 'We could not retrieve metadata for this URL. Double-check the link and try again.',
      thumbnail: null,
      label: 'Preview unavailable',
      host,
      duration: undefined
    });
  }
}

async function realVideoInfo(url) {
  const response = await fetch(`${API_BASE}/api/video-info?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    const payload = await safeJson(response);
    const error = new Error('Video info request failed');
    error.code = payload?.error;
    error.detail = payload?.detail;
    throw error;
  }
  return response.json();
}

async function refreshAuthStatus(url = '') {
  if (!url) {
    setAuthStatus({ ok: false, reason: 'Needed' });
    return;
  }
  if (!isValidUrl(url)) {
    setAuthStatus({ ok: false, reason: 'Invalid URL' });
    return;
  }
  try {
    const query = url ? `?url=${encodeURIComponent(url)}` : '';
    const response = await fetch(`${API_BASE}/api/auth-status${query}`);
    if (!response.ok) {
      throw new Error('Auth status request failed');
    }
    const data = await response.json();
    setAuthStatus(data);
  } catch (error) {
    setAuthStatus({ ok: false, reason: 'Unavailable' });
  }
}

async function requestAuthGet() {
  const url = selectors.url.value.trim();
  if (!isValidUrl(url)) {
    setAuthStatus({ ok: false, reason: 'Invalid URL' });
    setAuthError(false);
    return;
  }
  selectors.authGet.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/auth-get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await safeJson(response);
    setAuthStatus(data || { ok: false, reason: 'Unavailable' });
    if (data?.ok && url) {
      setAuthError(false);
      videoInfoMode = 'auto';
      fetchVideoInfo(url);
    }
  } catch (error) {
    setAuthStatus({ ok: false, reason: 'Unavailable' });
  } finally {
    selectors.authGet.disabled = false;
  }
}

function setAuthStatus({ ok, reason } = {}) {
  const isOk = Boolean(ok);
  if (isOk) {
    selectors.authStatus.textContent = `${AUTH_SOURCE_LABEL} · Connected`;
  } else {
    const detail = reason || 'Needed';
    selectors.authStatus.textContent = `${AUTH_SOURCE_LABEL} · ${detail}`;
  }
  selectors.authGet.hidden = false;
}

function setAuthError(show) {
  if (!selectors.authError) {
    return;
  }
  selectors.authError.hidden = !show;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function setAdvancedPrompt(message) {
  selectors.language.innerHTML = `<option value="">${message}</option>`;
  selectors.language.disabled = true;
  selectors.quality.innerHTML = `<option value="">${message}</option>`;
  selectors.quality.disabled = true;
}

function setAdvancedAvailability(isAvailable) {
  selectors.advancedToggle.disabled = !isAvailable;
  if (!isAvailable) {
    collapseAdvancedPanel();
  }
}

function collapseAdvancedPanel() {
  selectors.advancedPanel.classList.add('is-collapsed');
  selectors.advancedToggle.setAttribute('aria-expanded', 'false');
}

function expandAdvancedPanel() {
  selectors.advancedPanel.classList.remove('is-collapsed');
  selectors.advancedToggle.setAttribute('aria-expanded', 'true');
  hydrateAdvancedOptions();
}

function hydrateAdvancedOptions() {
  populateLanguageDropdown(availableLanguages, selectedLanguage);
  populateQualityDropdown(cachedFormats, selectedLanguage, selectedQuality);
}

function populateLanguageDropdown(languages = [], defaultCode = '') {
  selectors.language.innerHTML = '';

  if (!languages.length) {
    selectors.language.innerHTML = '<option value="">Language not available</option>';
    selectors.language.disabled = true;
    selectedLanguage = '';
    return;
  }

  languages.forEach((language) => {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.label;
    selectors.language.appendChild(option);
  });

  selectedLanguage = defaultCode || languages[0].code;
  selectors.language.value = selectedLanguage;
  selectors.language.disabled = languages.length <= 1;
}

function populateQualityDropdown(formats = [], languageCode = '', defaultQualityId = '') {
  selectors.quality.disabled = false;
  selectors.quality.innerHTML = '';

  const filtered = formats.filter((format) => {
    const lang = format.language || 'und';
    return !languageCode || lang === languageCode;
  });

  filtered.forEach((format) => {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = `${format.label} (${format.ext})`;
    selectors.quality.appendChild(option);
  });

  if (!filtered.length) {
    selectors.quality.innerHTML = '<option value="">No formats for this language</option>';
    selectors.quality.disabled = true;
    selectedQuality = '';
    return;
  }

  const preferred = defaultQualityId && filtered.some((format) => format.id === defaultQualityId)
    ? defaultQualityId
    : filtered[0].id;
  selectedQuality = preferred;
  selectors.quality.value = selectedQuality;
}

function updateVideoMeta({ title, description, thumbnail, label, host, duration }) {
  selectors.title.textContent = title;
  selectors.description.textContent = description;
  updateMetaRows({ host, duration });

  const resolvedThumbnail = thumbnail || deriveYoutubeThumbnail(selectors.url.value.trim());
  if (resolvedThumbnail) {
    selectors.thumbnail.style.backgroundImage = `url('${resolvedThumbnail}')`;
    selectors.thumbnail.dataset.empty = 'false';
    selectors.thumbnail.dataset.label = '';
  } else {
    selectors.thumbnail.style.backgroundImage = '';
    selectors.thumbnail.dataset.empty = 'true';
    selectors.thumbnail.dataset.label = label || 'Preview unavailable';
  }
}

function updateMetaRows({ host, duration }) {
  const hostLabel = host || '—';
  selectors.host.textContent = `Source: ${hostLabel}`;
  selectors.duration.textContent = `Duration: ${formatDurationLabel(duration)}`;
}

function formatDurationLabel(duration) {
  if (duration === null) {
    return '—';
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return 'unknown';
  }
  const total = Math.round(duration);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function resetVideoMeta() {
  updateVideoMeta({
    title: 'Paste a URL to preview',
    description: 'The title, description, duration, and available formats will appear here after we fetch details for the provided URL.',
    thumbnail: null,
    label: 'Paste a URL to preview',
    host: null,
    duration: null
  });
}

function updateProgress(percent, label) {
  selectors.percentLabel.textContent = `${percent}%`;
  selectors.progressFill.style.width = `${percent}%`;
  selectors.statusPill.textContent = label;
}

function updateProgressDetails(speed = '—', eta = '—') {
  if (!selectors.progressSubline) {
    return;
  }
  selectors.progressSubline.textContent = `Speed: ${speed}   ETA: ${eta}`;
}

function updateDownloadNote(filepath) {
  const note = selectors.downloadNote;
  if (!note) {
    return;
  }

  if (filepath) {
    const filename = friendlyBasename(filepath);
    note.textContent = `Saved to ${currentSavePath || DEFAULT_SAVE_PATH} as ${filename}.`;
    return;
  }

  note.textContent = `Videos save to ${currentSavePath || DEFAULT_SAVE_PATH}.`;
}

function deriveLanguageOptions(apiLanguages = [], formats = []) {
  if (Array.isArray(apiLanguages) && apiLanguages.length) {
    return apiLanguages;
  }

  const map = new Map();
  formats.forEach((format) => {
    const code = format.language || 'und';
    if (map.has(code)) {
      return;
    }
    map.set(code, {
      code,
      label: code === 'und' ? 'Default' : code
    });
  });

  return Array.from(map.values());
}

function pickDefaultLanguage(languages = []) {
  if (!languages.length) {
    return '';
  }
  const english = languages.find((lang) => lang.code && lang.code.toLowerCase().startsWith('en'));
  return english ? english.code : languages[0].code;
}

function pickDefaultQuality(formats = [], languageCode = '') {
  const filtered = formats.filter((format) => {
    const lang = format.language || 'und';
    return !languageCode || lang === languageCode;
  });
  return filtered[0]?.id || '';
}

function friendlyBasename(path = '') {
  if (!path) {
    return 'your video';
  }
  const segments = path.replace(/\\/g, '/').split('/');
  const last = segments.pop() || path;
  return last;
}

function deriveHostLabel(rawUrl) {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl).hostname;
  } catch (error) {
    return null;
  }
}

function isValidUrl(value = '') {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function deriveYoutubeThumbnail(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    let videoId = null;

    if (parsed.hostname.includes('youtu.be')) {
      videoId = parsed.pathname.replace('/', '');
    } else if (parsed.hostname.includes('youtube.com')) {
      videoId = parsed.searchParams.get('v');
    }

    if (!videoId) {
      return null;
    }

    return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  } catch (error) {
    console.warn('Could not derive thumbnail from URL:', error);
    return null;
  }
}

async function requestDownload(payload) {
  const response = await fetch(`${API_BASE}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('Download request failed');
  }

  return response.json();
}

function setDefaultSaveLocation(path = DEFAULT_SAVE_PATH) {
  currentSavePath = path || DEFAULT_SAVE_PATH;
  selectors.location.value = currentSavePath;
  updateDownloadNote();
}

async function fetchDefaultPathFromApi() {
  try {
    const response = await fetch(`${API_BASE}/api/default-path`);
    if (!response.ok) {
      throw new Error('Default path request failed');
    }
    const data = await response.json();
    if (data?.path) {
      setDefaultSaveLocation(data.path);
    }
  } catch (error) {
    console.warn('Falling back to default save path:', error);
    setDefaultSaveLocation();
  }
}

async function fetchDiagnosticsFromApi() {
  if (!selectors.ytdlpVersion) {
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/api/diagnostics`);
    if (!response.ok) {
      throw new Error('Diagnostics request failed');
    }
    const data = await response.json();
    const ver = data?.yt_dlp?.version || 'unknown';
    const warning = data?.yt_dlp?.warning || '';
    const extractor = data?.extractor;
    const suffix = warning ? ' (update)' : '';
    selectors.ytdlpVersion.textContent = `yt-dlp: ${ver}${suffix}`;
    const titleParts = [];
    if (warning) {
      titleParts.push(warning);
    }
    if (extractor) {
      if (extractor.ok) {
        titleParts.push(`${extractor.name || 'youtube'} extractor: ok`);
      } else {
        titleParts.push(`${extractor.name || 'youtube'} extractor: ${extractor.error || 'error'}`);
      }
    }
    if (titleParts.length) {
      selectors.ytdlpVersion.title = titleParts.join(' | ');
    }
  } catch (error) {
    selectors.ytdlpVersion.textContent = 'yt-dlp: unavailable';
  }
}



function beginPseudoProgress() {
  let percent = 5;
  updateProgress(percent, 'Downloading…');
  updateProgressDetails();
  const timer = setInterval(() => {
    percent = Math.min(percent + Math.random() * 12, 93);
    updateProgress(Math.round(percent), 'Downloading…');
  }, 600);
  return () => clearInterval(timer);
}

// --- Mock helpers below keep the UI interactive until endpoints exist ---
function mockVideoInfo(url) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const derivedThumb = deriveYoutubeThumbnail(url);
      let mockThumb = derivedThumb || 'https://picsum.photos/seed/downloader/800/450';
      let hostLabel = 'video.example';
      try {
        const parsed = new URL(url);
        hostLabel = parsed.hostname;
      } catch (error) {
        console.warn('Mock video info could not parse URL for thumbnail:', error);
      }

      resolve({
        title: 'Video • ' + hostLabel,
        description: `Metadata preview for ${url}.

If details look generic, the local API may still be starting.`,
        thumbnail: mockThumb,
        languages: [
          { code: 'en', label: 'English' },
          { code: 'es', label: 'Spanish' }
        ],
        formats: [
          { id: 'bestvideo+bestaudio', label: 'Best Available', ext: 'mkv', language: 'en' },
          { id: '1080p', label: '1080p', ext: 'mp4', language: 'en' },
          { id: '720p', label: '720p', ext: 'mp4', language: 'es' },
          { id: '480p', label: '480p', ext: 'mp4', language: 'en' },
          { id: 'audio', label: 'Audio only', ext: 'm4a', language: 'es' }
        ]
      });
    }, 650);
  });
}
