const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.opensubtitles.com/api/v1';

// In-memory token cache
let loginToken = null;
let tokenExpires = null;

// Get configured settings
function getCredentials() {
  return {
    apiKey: process.env.OPENSUBTITLES_API_KEY || '',
    username: process.env.OPENSUBTITLES_USERNAME || '',
    password: process.env.OPENSUBTITLES_PASSWORD || '',
    userAgent: process.env.OPENSUBTITLES_USER_AGENT || 'DTV Media Server v1.0'
  };
}

// Check if credentials are set
function isConfigured() {
  const creds = getCredentials();
  return !!(creds.apiKey);
}

// Authenticate with OpenSubtitles
async function login() {
  const creds = getCredentials();
  if (!creds.apiKey || !creds.username || !creds.password) {
    throw new Error('OpenSubtitles API key, username, or password is not configured');
  }

  // If already logged in and token is fresh (approx 23 hours lifetime)
  if (loginToken && tokenExpires && tokenExpires > Date.now()) {
    return loginToken;
  }

  console.log('Logging in to OpenSubtitles...');
  const response = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': creds.apiKey,
      'User-Agent': creds.userAgent,
      'X-User-Agent': creds.userAgent
    },
    body: JSON.stringify({
      username: creds.username,
      password: creds.password
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenSubtitles login failed: ${response.statusText}. Details: ${errorText}`);
  }

  const data = await response.json();
  loginToken = data.token;
  // Expire token in 23 hours
  tokenExpires = Date.now() + 23 * 60 * 60 * 1000;
  return loginToken;
}

// Search subtitles
async function searchSubtitles(query, languages = 'en') {
  const creds = getCredentials();
  if (!creds.apiKey) {
    throw new Error('OpenSubtitles API key is not configured');
  }

  const url = new URL(`${API_BASE}/subtitles`);
  url.searchParams.append('query', query);
  url.searchParams.append('languages', languages);

  console.log(`Searching OpenSubtitles for query: "${query}", languages: "${languages}"`);
  
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Api-Key': creds.apiKey,
      'User-Agent': creds.userAgent,
      'X-User-Agent': creds.userAgent
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenSubtitles search failed: ${response.statusText}. Details: ${errorText}`);
  }

  const data = await response.json();
  // Format results for frontend
  return data.data.map(item => ({
    id: item.attributes.files[0].file_id, // file_id needed for download
    language: item.attributes.language,
    fileName: item.attributes.release,
    uploader: item.attributes.uploader.username,
    downloadCount: item.attributes.download_count,
    fps: item.attributes.fps
  }));
}

// Download subtitle file
async function downloadSubtitle(fileId, mediaItemId) {
  const creds = getCredentials();
  if (!creds.apiKey) {
    throw new Error('OpenSubtitles API key is not configured');
  }

  // Login is required to fetch download link
  const token = await login();

  console.log(`Requesting download link for fileId: ${fileId}`);
  const downloadResponse = await fetch(`${API_BASE}/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': creds.apiKey,
      'Authorization': `Bearer ${token}`,
      'User-Agent': creds.userAgent,
      'X-User-Agent': creds.userAgent
    },
    body: JSON.stringify({
      file_id: parseInt(fileId, 10)
    })
  });

  if (!downloadResponse.ok) {
    const errorText = await downloadResponse.text();
    throw new Error(`OpenSubtitles download request failed: ${downloadResponse.statusText}. Details: ${errorText}`);
  }

  const downloadData = await downloadResponse.json();
  const fileUrl = downloadData.link;
  const fileName = downloadData.file_name || `${fileId}.srt`;

  // Fetch the actual subtitle content
  const subtitleFileResponse = await fetch(fileUrl);
  if (!subtitleFileResponse.ok) {
    throw new Error(`Failed to download subtitle file from URL: ${subtitleFileResponse.statusText}`);
  }

  const subtitleContent = await subtitleFileResponse.text();

  // Create subtitles directory if it doesn't exist
  const subtitlesDir = path.join(__dirname, 'data', 'subtitles');
  if (!fs.existsSync(subtitlesDir)) {
    fs.mkdirSync(subtitlesDir, { recursive: true });
  }

  // Save subtitle file locally
  const localFileName = `sub_${mediaItemId}_${Date.now()}_${fileName}`;
  const localFilePath = path.join(subtitlesDir, localFileName);
  fs.writeFileSync(localFilePath, subtitleContent);

  return {
    filePath: localFilePath,
    fileName: localFileName
  };
}

module.exports = {
  isConfigured,
  searchSubtitles,
  downloadSubtitle
};
