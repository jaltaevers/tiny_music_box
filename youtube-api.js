// Real metadata for a specific YouTube video — title, channel name,
// thumbnail — via YouTube's public oEmbed endpoint. No API key, no
// quota, no Google Cloud project: oEmbed is a public, unauthenticated
// standard (the same mechanism most sites use to render a link preview),
// and YouTube serves CORS headers on it specifically so third-party
// pages can call it client-side like this.
//
// What this can't do, and what would need the YouTube Data API v3 (and
// therefore an API key) instead:
//   - text search (oEmbed needs a specific video URL, not a query)
//   - fetching a whole playlist's contents in one call
//   - a video's duration (oEmbed's response doesn't include it, which is
//     why tiles added through this always carry durationMs: null — see
//     store.js's tileFromTrack. youtube-player.js's ad-detection
//     heuristic simply doesn't run for a tile with no expected duration
//     to compare against, rather than guessing wrong.)
import { extractVideoId } from './youtube-player.js';

const OEMBED_ENDPOINT = 'https://www.youtube.com/oembed';

export class YouTubeMetadataError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'YouTubeMetadataError';
    this.status = info.status;
  }
}

/**
 * @param {string} urlOrId - A full YouTube URL (any of the shapes
 *   extractVideoId understands) or a bare video ID.
 * @returns {Promise<{videoId, title, channelTitle, thumbnailUrl, durationMs: null}>}
 */
export async function fetchVideoMetadata(urlOrId) {
  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    throw new YouTubeMetadataError('That doesn’t look like a YouTube link or video ID.');
  }

  const params = new URLSearchParams({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    format: 'json',
  });
  let res;
  try {
    res = await fetch(`${OEMBED_ENDPOINT}?${params.toString()}`);
  } catch (e) {
    throw new YouTubeMetadataError('Couldn’t reach YouTube — check your connection and try again.');
  }

  if (!res.ok) {
    // oEmbed returns 401/404 for a video that's private, deleted, or has
    // embedding disabled by its owner — the three cases that also mean
    // it could never have played in the hidden player anyway, so this is
    // the right place to catch it (before it ever becomes a tile) rather
    // than after a kid taps it.
    if (res.status === 401 || res.status === 404) {
      throw new YouTubeMetadataError('That video isn’t available — it may be private, deleted, or have embedding disabled by its owner.', { status: res.status });
    }
    throw new YouTubeMetadataError(`Couldn’t look up that video (error ${res.status}).`, { status: res.status });
  }

  const data = await res.json();
  return {
    videoId,
    title: data.title || '',
    channelTitle: data.author_name || '',
    thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationMs: null,
  };
}
