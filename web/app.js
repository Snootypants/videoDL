const API_BASE = 'http://127.0.0.1:5050';
const DEFAULT_SAVE_PATH = '~/Downloads';
let videoInfoMode = 'auto'; // auto -> try API first, then fall back to mock
const downloadMode = 'live'; // live -> hit backend endpoint

const selectors = {
  url: document.getElementById('video-url'),
  location: document.getElementById('save-location'),
  language: document.getElementById('language'),
  quality: document.getElementById('quality'),
  downloadBtn: document.getElementById('download-btn'),
  statusPill: document.getElementById('status-pill'),
  percentLabel: document.getElementById('percent-label'),
  progressFill: document.getElementById('progress-fill'),
  title: document.getElementById('video-title'),
  description: document.getElementById('video-description'),
  thumbnail: document.getElementById('video-image'),
  downloadNote: document.getElementById('download-note'),
  form: document.getElementById('download-form')
};

let fetchTimeout = null;
let cachedFormats = [];
let availableLanguages = [];
let selectedLanguage = '';
let currentSavePath = DEFAULT_SAVE_PATH;
setDefaultSaveLocation();
fetchDefaultPathFromApi();

selectors.url.addEventListener('input', () => {
  selectors.downloadBtn.disabled = true;
  selectors.quality.disabled = true;
  selectors.quality.innerHTML = '<option value="">Fetching formats…</option>';
  selectors.language.disabled = true;
  selectors.language.innerHTML = '<option value="">Fetching languages…</option>';

  clearTimeout(fetchTimeout);
  const url = selectors.url.value.trim();
  if (!url) {
    resetVideoMeta();
    resetLanguageSelect();
    return;
  }

  fetchTimeout = setTimeout(() => fetchVideoInfo(url), 450);
});

selectors.language.addEventListener('change', () => {
  selectedLanguage = selectors.language.value;
  populateQualityDropdown(cachedFormats, selectedLanguage);
});

selectors.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectors.url.value || !selectors.location.value || !selectors.quality.value) {
    return;
  }

  selectors.downloadBtn.disabled = true;
  updateProgress(0, 'Starting download…');

  let stopProgress = null;
  try {
    stopProgress = beginPseudoProgress();
    const result = await requestDownload({
      url: selectors.url.value.trim(),
      quality: selectors.quality.value,
      path: selectors.location.value.trim(),
      language: selectors.language.value
    });
    updateProgress(100, 'Download complete');
    updateDownloadNote(result?.filepath);
  } catch (error) {
    console.error(error);
    selectors.statusPill.textContent = 'Failed';
    selectors.statusPill.style.background = 'rgba(248,81,73,0.15)';
    selectors.statusPill.style.borderColor = 'rgba(248,81,73,0.4)';
    selectors.percentLabel.textContent = '0%';
    selectors.progressFill.style.width = '0%';
  } finally {
    if (typeof stopProgress === 'function') {
      stopProgress();
    }
    selectors.downloadBtn.disabled = false;
  }
});

async function fetchVideoInfo(url) {
  updateVideoMeta({
    title: 'Fetching video details…',
    description: 'Hang tight while we look up this video.',
    thumbnail: null,
    label: 'Fetching preview…'
  });

  try {
    const data = videoInfoMode === 'mock'
      ? await mockVideoInfo(url)
      : await realVideoInfo(url);

    cachedFormats = data.formats || [];
    availableLanguages = deriveLanguageOptions(data.languages, cachedFormats);
    selectedLanguage = pickDefaultLanguage(availableLanguages);
    populateLanguageDropdown(availableLanguages, selectedLanguage);
    populateQualityDropdown(cachedFormats, selectedLanguage);
    updateVideoMeta({
      title: data.title || 'Untitled video',
      description: data.description || 'No description provided.',
      thumbnail: data.thumbnail || null,
      label: 'No thumbnail available'
    });
    selectors.downloadBtn.disabled = false;
  } catch (error) {
    console.error(error);
    if (videoInfoMode === 'auto') {
      videoInfoMode = 'mock';
      console.warn('Falling back to mock data. Start web/server.py to hit the real API.');
      return fetchVideoInfo(url);
    }
    resetLanguageSelect();
    updateVideoMeta({
      title: 'No data',
      description: 'We could not retrieve metadata for this URL. Double-check the link and try again.',
      thumbnail: null,
      label: 'Preview unavailable'
    });
  }
}

async function realVideoInfo(url) {
  const response = await fetch(`${API_BASE}/api/video-info?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    throw new Error('Video info request failed');
  }
  return response.json();
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

function populateQualityDropdown(formats = [], languageCode = '') {
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
  }
}

function updateVideoMeta({ title, description, thumbnail, label }) {
  selectors.title.textContent = title;
  selectors.description.textContent = description;

  const resolvedThumbnail = thumbnail || deriveYoutubeThumbnail(selectors.url.value.trim());
  if (resolvedThumbnail) {
    selectors.thumbnail.style.backgroundImage =
      `linear-gradient(rgba(0,0,0,0.15), rgba(0,0,0,0.15)), url('${resolvedThumbnail}')`;
    selectors.thumbnail.dataset.empty = 'false';
    selectors.thumbnail.dataset.label = '';
  } else {
    selectors.thumbnail.style.backgroundImage = '';
    selectors.thumbnail.dataset.empty = 'true';
    selectors.thumbnail.dataset.label = label || 'Preview unavailable';
  }
}

function resetVideoMeta() {
  updateVideoMeta({
    title: 'Paste a URL to preview',
    description: 'The title, description, duration, and available formats will appear here after we fetch details for the provided URL.',
    thumbnail: null,
    label: 'Paste a URL to preview'
  });
}

function updateProgress(percent, label) {
  selectors.percentLabel.textContent = `${percent}%`;
  selectors.progressFill.style.width = `${percent}%`;
  selectors.statusPill.textContent = label;
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

function resetLanguageSelect() {
  selectors.language.innerHTML = '<option value="">Select a video first</option>';
  selectors.language.disabled = true;
  selectedLanguage = '';

  selectors.quality.innerHTML = '<option value="">Select a video first</option>';
  selectors.quality.disabled = true;
}

function friendlyBasename(path = '') {
  if (!path) {
    return 'your video';
  }
  const segments = path.replace(/\\/g, '/').split('/');
  const last = segments.pop() || path;
  return last;
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



function beginPseudoProgress() {
  let percent = 5;
  updateProgress(percent, 'Downloading…');
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
        title: 'Sample Video • ' + hostLabel,
        description: `This is placeholder metadata for ${url}.

Once your API is wired up, disable the mock flag to show the real video title and description.`,
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
