// Public by design: the PKCE flow needs no client secret.
// Same Spotify app as /spike/ — just make sure this page's exact URL is
// also registered as a Redirect URI in the dashboard (the spike and the
// real app live at different paths, so each needs its own entry).
export const SPOTIFY_CONFIG = {
  clientId: 'b9dec09d4e9941129e2fab974f2f864b',

  redirectUri: window.location.origin + window.location.pathname,

  scopes: [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    // Without these, every playlist read 403s regardless of who actually
    // owns it — a scope grant is checked before ownership even comes into
    // it. Collaborative is included too since a shared/co-owned playlist
    // needs it in addition to (not instead of) playlist-read-private.
    'playlist-read-private',
    'playlist-read-collaborative',
  ],
};
