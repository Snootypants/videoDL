const API_BASE = 'http://127.0.0.1:5050';
const DEFAULT_SAVE_PATH = '~/Downloads';
let videoInfoMode = 'auto'; // auto -> try API first, then fall back to mock
const downloadMode = 'mock'; // keep downloads mocked until the endpoint exists

const selectors = {
  url: document.getElementById('video-url'),
  location: document.getElementById('save-location'),
  quality: document.getElementById('quality'),
  downloadBtn: document.getElementById('download-btn'),
  statusPill: document.getElementById('status-pill'),
  percentLabel: document.getElementById('percent-label'),
  progressFill: document.getElementById('progress-fill'),
  title: document.getElementById('video-title'),
  description: document.getElementById('video-description'),
  thumbnail: document.getElementById('video-image'),
  form: document.getElementById('download-form')
};

let fetchTimeout = null;
setDefaultSaveLocation();
fetchDefaultPathFromApi();

selectors.url.addEventListener('input', () => {
  selectors.downloadBtn.disabled = true;
  selectors.quality.disabled = true;
  selectors.quality.innerHTML = '<option value="">Fetching formats…</option>';

  clearTimeout(fetchTimeout);
  const url = selectors.url.value.trim();
  if (!url) {
    resetVideoMeta();
    selectors.quality.innerHTML = '<option value="">Enter a URL first</option>';
    return;
  }

  fetchTimeout = setTimeout(() => fetchVideoInfo(url), 450);
});

selectors.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectors.url.value || !selectors.location.value || !selectors.quality.value) {
    return;
  }

  selectors.downloadBtn.disabled = true;
  updateProgress(0, 'Starting download…');

  try {
    if (downloadMode === 'mock') {
      await simulateDownload();
    } else {
      await requestDownload({
        url: selectors.url.value.trim(),
        quality: selectors.quality.value,
        path: selectors.location.value.trim()
      });
    }
    updateProgress(100, 'Download complete');
  } catch (error) {
    console.error(error);
    selectors.statusPill.textContent = 'Failed';
    selectors.statusPill.style.background = 'rgba(248,81,73,0.15)';
    selectors.statusPill.style.borderColor = 'rgba(248,81,73,0.4)';
    selectors.percentLabel.textContent = '0%';
    selectors.progressFill.style.width = '0%';
  } finally {
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

    populateQualityDropdown(data.formats);
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
    selectors.quality.innerHTML = '<option value="">Unable to fetch formats</option>';
    selectors.quality.disabled = true;
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

function populateQualityDropdown(formats = []) {
  selectors.quality.disabled = false;
  selectors.quality.innerHTML = '';
  formats.forEach((format) => {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = `${format.label} (${format.ext})`;
    selectors.quality.appendChild(option);
  });

  if (!formats.length) {
    selectors.quality.innerHTML = '<option value="">No formats available</option>';
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
  selectors.location.value = path;
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



// --- Mock helpers below keep the UI interactive until endpoints exist ---
function mockVideoInfo(url) {
  return new Promise((resolve) => {
    setTimeout(() => {
      let mockThumb = 'https://picsum.photos/seed/downloader/800/450';
      let hostLabel = 'video.example';
      try {
        const parsed = new URL(url);
        hostLabel = parsed.hostname;
        const videoId = parsed.searchParams.get('v');
        if (videoId) {
          mockThumb = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        }
      } catch (error) {
        console.warn('Mock video info could not parse URL for thumbnail:', error);
      }

      resolve({
        title: 'Sample Video • ' + hostLabel,
        description: `This is placeholder metadata for ${url}.

Once your API is wired up, disable the mock flag to show the real video title and description.`,
        thumbnail: mockThumb,
        formats: [
          { id: 'bestvideo+bestaudio', label: 'Best Available', ext: 'mkv' },
          { id: '1080p', label: '1080p', ext: 'mp4' },
          { id: '720p', label: '720p', ext: 'mp4' },
          { id: '480p', label: '480p', ext: 'mp4' },
          { id: 'audio', label: 'Audio only', ext: 'm4a' }
        ]
      });
    }, 650);
  });
}

function simulateDownload() {
  return new Promise((resolve) => {
    let percent = 0;
    const timer = setInterval(() => {
      percent += Math.round(Math.random() * 15);
      if (percent >= 100) {
        percent = 100;
        clearInterval(timer);
        resolve();
      }
      updateProgress(percent, percent < 100 ? 'Downloading…' : 'Finishing up…');
    }, 450);
  });
}
