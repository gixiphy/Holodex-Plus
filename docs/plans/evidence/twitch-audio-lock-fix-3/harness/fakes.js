// Fake Twitch embed + YouTube iframe API, served in place of the real scripts.
// Exposes window.__fake = { tw: [], yt: [] } with controls for the harness.
(function () {
  var W = window;
  W.__fake = W.__fake || { tw: [], yt: [], log: [] };
  function now() { return Math.round(performance.now()); }
  function mkIframe(host, src, parent) {
    var f = document.createElement('iframe');
    f.src = src; f.setAttribute('allow', 'autoplay'); f.style.width = '100%'; f.style.height = '100%';
    f.setAttribute('data-fake', host);
    parent.appendChild(f); return f;
  }
  if (SCRIPT_KIND === 'twitch') {
    function TwPlayer(elementId, opts) {
      var el = document.getElementById(elementId), self = this;
      this.opts = opts || {}; this.listeners = {};
      this.state = { muted: this.opts.muted === true, volume: 0.5, playing: false, lagMs: 0, setMutedCalls: [] };
      this.iframe = mkIframe('twitch', 'https://player.twitch.tv/?channel=' + (opts.channel || 'x') + '&parent=holodex.net', el);
      W.__fake.tw.push(this);
      setTimeout(function () { self.emit('ready'); }, 400);
    }
    TwPlayer.prototype.addEventListener = function (n, cb) { (this.listeners[n] = this.listeners[n] || []).push(cb); };
    TwPlayer.prototype.removeEventListener = function () {};
    TwPlayer.prototype.emit = function (n) { (this.listeners[n] || []).forEach(function (cb) { try { cb(); } catch (e) { console.error(e); } }); };
    TwPlayer.prototype.getMuted = function () { return this.state.muted; };
    TwPlayer.prototype.setMuted = function (v) {
      var s = this.state; s.setMutedCalls.push([now(), !!v]);
      if (s.lagMs) setTimeout(function () { s.muted = !!v; }, s.lagMs); else s.muted = !!v;
    };
    TwPlayer.prototype.getVolume = function () { return this.state.volume; };
    TwPlayer.prototype.setVolume = function (v) { this.state.volume = v; };
    TwPlayer.prototype.play = function () { this.state.playing = true; this.emit('play'); };
    TwPlayer.prototype.pause = function () { this.state.playing = false; this.emit('pause'); };
    TwPlayer.prototype.setQuality = function () {}; TwPlayer.prototype.getQualities = function () { return []; };
    TwPlayer.prototype.setChannel = function () {}; TwPlayer.prototype.setVideo = function () {};
    TwPlayer.prototype.getCurrentTime = function () { return 0; };
    TwPlayer.prototype.getPlaybackStats = function () { return {}; };
    // harness controls
    TwPlayer.prototype.__selfUnmute = function () { this.state.muted = false; };
    TwPlayer.prototype.__startPlaying = function () { this.state.playing = true; this.emit('play'); };
    TwPlayer.READY = 'ready'; TwPlayer.PLAY = 'play'; TwPlayer.PAUSE = 'pause'; TwPlayer.ENDED = 'ended';
    W.Twitch = { Player: TwPlayer };
  } else {
    function YtPlayer(elementId, opts) {
      var el = typeof elementId === 'string' ? document.getElementById(elementId) : elementId, self = this;
      this.opts = opts || {}; this.events = this.opts.events || {};
      this.state = { muted: false, volume: 100, ps: -1, lagMs: 0 };
      var parent = el.parentNode, f = document.createElement('iframe');
      f.src = 'https://www.youtube.com/embed/' + (opts.videoId || 'x') + '?enablejsapi=1'; f.id = el.id;
      f.setAttribute('data-fake', 'youtube'); parent.replaceChild(f, el); this.iframe = f;
      W.__fake.yt.push(this);
      setTimeout(function () { self.fire('onReady', {}); }, 300);
    }
    YtPlayer.prototype.fire = function (n, d) { var cb = this.events[n]; d.target = this; if (cb) try { cb(d); } catch (e) { console.error(e); } };
    YtPlayer.prototype.addEventListener = function (n, cb) { this.events[n] = cb; };
    YtPlayer.prototype.removeEventListener = function () {};
    YtPlayer.prototype.isMuted = function () { return this.state.muted; };
    YtPlayer.prototype.mute = function () { this.state.muted = true; };
    YtPlayer.prototype.unMute = function () { this.state.muted = false; };
    YtPlayer.prototype.getIframe = function () { return this.iframe; };
    YtPlayer.prototype.getVideoData = function () { return { isLive: true, allowLiveDvr: false, video_id: this.opts.videoId }; };
    YtPlayer.prototype.getPlayerState = function () { return this.state.ps; };
    YtPlayer.prototype.playVideo = function () { this.state.ps = 1; this.fire('onStateChange', { data: 1 }); };
    YtPlayer.prototype.pauseVideo = function () { this.state.ps = 2; this.fire('onStateChange', { data: 2 }); };
    YtPlayer.prototype.stopVideo = function () { this.state.ps = 0; };
    ['setVolume','setPlaybackRate','seekTo','loadVideoById','cueVideoById','setSize','destroy','setPlaybackQuality','setLoop','setShuffle','nextVideo','previousVideo','playVideoAt','loadPlaylist','cuePlaylist','loadVideoByUrl','cueVideoByUrl','setOption'].forEach(function (m) { YtPlayer.prototype[m] = function (v) { if (m === 'setVolume') this.state.volume = v; }; });
    ['getVolume','getPlaybackRate','getCurrentTime','getDuration','getVideoLoadedFraction','getVideoUrl','getVideoEmbedCode','getAvailablePlaybackRates','getPlaybackQuality','getAvailableQualityLevels','getPlaylist','getPlaylistIndex','getOptions','getOption','getSphericalProperties'].forEach(function (m) { YtPlayer.prototype[m] = function () { return m === 'getVolume' ? this.state.volume : (m === 'getPlaybackRate' ? 1 : 0); }; });
    YtPlayer.prototype.__startPlaying = function () { this.playVideo(); };
    W.YT = { Player: YtPlayer, PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }, loaded: 1 };
    setTimeout(function () { if (typeof W.onYouTubeIframeAPIReady === 'function') W.onYouTubeIframeAPIReady(); }, 0);
  }
})();
