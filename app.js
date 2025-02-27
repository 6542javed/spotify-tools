const express = require('express');
const request = require('request');
const querystring = require('querystring');
const cookieParser = require('cookie-parser');
const serverless = require('serverless-http');

const app = express();
app.use(express.json()); // For parsing JSON bodies
app.use(cookieParser());
app.use(express.static(__dirname + '/../public')); // Adjust path to public folder

const client_id = 'afa4fce3901e4cf68cc3177f17207fdf';
const client_secret = 'b30f2385d0104de3b57afe1e425c1e5a';
const redirect_uri = 'https://YOUR_VERCEL_DEPLOYMENT_URL/api/callback'; // Update this once deployed

const generateRandomString = length => {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

const stateKey = 'spotify_auth_state';

// Serve landing page at the root (if needed, adjust route)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/../public/landing.html');
});

app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  res.cookie(stateKey, state);

  const scope = 'user-library-read playlist-modify-public';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    })
  );
});

app.get('/callback', (req, res) => {
  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' + querystring.stringify({ error: 'state_mismatch' }));
    return;
  }
  res.clearCookie(stateKey);

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: {
      code: code,
      redirect_uri: redirect_uri,
      grant_type: 'authorization_code'
    },
    headers: {
      'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
    },
    json: true
  };

  request.post(authOptions, (error, response, body) => {
    if (!error && response.statusCode === 200) {
      const access_token = body.access_token;
      // Store access token in a cookie for later API calls
      res.cookie('access_token', access_token);
      res.redirect('/dashboard');
    } else {
      res.redirect('/#' + querystring.stringify({ error: 'invalid_token' }));
    }
  });
});

// API endpoint to search liked songs using an optional query
app.get('/api/search', (req, res) => {
  const access_token = req.cookies.access_token;
  if (!access_token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  
  const searchQuery = req.query.query ? req.query.query.toLowerCase() : '';

  function fetchAllLikedSongs(url, allSongs = [], callback) {
    const options = {
      url: url,
      headers: { 'Authorization': 'Bearer ' + access_token },
      json: true
    };
    
    request.get(options, (err, resp, data) => {
      if (err || resp.statusCode !== 200) {
        callback(err || new Error('Error fetching liked songs'));
        return;
      }
      allSongs = allSongs.concat(data.items);
      if (data.next) {
        fetchAllLikedSongs(data.next, allSongs, callback);
      } else {
        callback(null, allSongs);
      }
    });
  }

  // Begin with the first page of liked songs
  fetchAllLikedSongs('https://api.spotify.com/v1/me/tracks?limit=50', [], (err, songs) => {
    if (err) {
      res.status(500).json({ error: 'Error retrieving liked songs.' });
      return;
    }
    // Filter songs based on track name, artist name, or album name
    const filteredSongs = songs.filter(item => {
      const track = item.track;
      const trackName = track.name.toLowerCase();
      const artistNames = track.artists.map(artist => artist.name.toLowerCase()).join(' ');
      const albumName = track.album.name.toLowerCase();
      return trackName.includes(searchQuery) ||
             artistNames.includes(searchQuery) ||
             albumName.includes(searchQuery);
    }).map(item => ({
      name: item.track.name,
      artists: item.track.artists.map(artist => artist.name),
      album: item.track.album.name,
      uri: item.track.uri
    }));
    res.json({ songs: filteredSongs });
  });
});

// API endpoint to create a playlist from filtered songs
app.post('/api/create_playlist', (req, res) => {
  const access_token = req.cookies.access_token;
  if (!access_token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const searchQuery = req.body.query ? req.body.query.toLowerCase() : '';
  const playlistName = req.body.playlistName || 'Filtered Playlist';

  // Retrieve the user profile to get the user ID
  const userOptions = {
    url: 'https://api.spotify.com/v1/me',
    headers: { 'Authorization': 'Bearer ' + access_token },
    json: true
  };

  request.get(userOptions, (err, resp, userData) => {
    if (err || resp.statusCode !== 200) {
      res.status(500).json({ error: 'Error retrieving user profile.' });
      return;
    }
    const userId = userData.id;
    
    // Create a new playlist for the user
    const createPlaylistOptions = {
      url: `https://api.spotify.com/v1/users/${userId}/playlists`,
      headers: {
        'Authorization': 'Bearer ' + access_token,
        'Content-Type': 'application/json'
      },
      body: {
        name: playlistName,
        public: true
      },
      json: true
    };

    request.post(createPlaylistOptions, (err, resp, playlistData) => {
      if (err || (resp && resp.statusCode >= 400)) {
        res.status(500).json({ error: 'Error creating playlist.' });
        return;
      }
      const playlistId = playlistData.id;

      function fetchAllLikedSongs(url, allSongs = [], callback) {
        const options = {
          url: url,
          headers: { 'Authorization': 'Bearer ' + access_token },
          json: true
        };
        
        request.get(options, (err, resp, data) => {
          if (err || resp.statusCode !== 200) {
            callback(err || new Error('Error fetching liked songs'));
            return;
          }
          allSongs = allSongs.concat(data.items);
          if (data.next) {
            fetchAllLikedSongs(data.next, allSongs, callback);
          } else {
            callback(null, allSongs);
          }
        });
      }

      fetchAllLikedSongs('https://api.spotify.com/v1/me/tracks?limit=50', [], (err, songs) => {
        if (err) {
          res.status(500).json({ error: 'Error retrieving liked songs.' });
          return;
        }
        // Filter songs based on the search term
        const filteredSongs = songs.filter(item => {
          const track = item.track;
          const trackName = track.name.toLowerCase();
          const artistNames = track.artists.map(artist => artist.name.toLowerCase()).join(' ');
          const albumName = track.album.name.toLowerCase();
          return trackName.includes(searchQuery) ||
                 artistNames.includes(searchQuery) ||
                 albumName.includes(searchQuery);
        });

        // Extract track URIs
        const trackUris = filteredSongs.map(item => item.track.uri);

        // Add tracks to the newly created playlist in batches of 100
        const addTracks = (uris, callback) => {
          if (uris.length === 0) {
            callback();
            return;
          }
          const batch = uris.splice(0, 100);
          const addOptions = {
            url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
            headers: {
              'Authorization': 'Bearer ' + access_token
            },
            json: { uris: batch }
          };
          request.post(addOptions, (err, resp, body) => {
            if (err || (resp && resp.statusCode >= 400)) {
              console.error('Error adding tracks:', err, body);
              callback(err || new Error('Error adding tracks to playlist'));
            } else {
              addTracks(uris, callback);
            }
          });
        };

        addTracks(trackUris, err => {
          if (err) {
            res.status(500).json({ error: 'Error adding tracks to playlist.' });
          } else {
            res.json({ message: 'Playlist created successfully!', playlistUrl: playlistData.external_urls.spotify });
          }
        });
      });
    });
  });
});

app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/../public/index.html');
});

// Instead of listening on a port, export the serverless handler
module.exports = serverless(app);
