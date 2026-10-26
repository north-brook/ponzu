/*
 * What the person sees, measured inside the canvas page: installed before the page's own script
 * (Playwright's init script in WebKit), so it runs the same in headless WebKit and in the app's
 * WKWebView. Kept as a string of plain JavaScript, so either host can inject it.
 *
 * window.__pzPerf:
 *   start() / stop()  frames between them: rAF times, and the frames in which the camera (the
 *                     `.world` transform) actually changed
 *   scan()            what the page holds: boards, elements in every shadow root, images, videos,
 *                     running animations (and how many of them are held)
 *   ready, drawn      when the canvas told the app `ready` and `drawn` (performance.now())
 *   onDrawn           the host's, called once `drawn` comes
 *   messages          every FromCanvas message, with its time
 */
export const PROBE = `(() => {
  if (window.__pzPerf) return;
  const S = (window.__pzPerf = { on: false, t: [], moves: [], messages: [], drawn: null, errors: [] });
  let world = null, last = '', gen = 0;
  const loop = (g) => (t) => {
    if (!S.on || g !== gen) return;
    if (!world || !world.isConnected) world = document.querySelector('.world');
    const c = world ? world.style.transform : '';
    S.t.push(t);
    if (c !== last) S.moves.push(t);
    last = c;
    requestAnimationFrame(loop(g));
  };
  S.start = () => {
    S.t = []; S.moves = [];
    world = document.querySelector('.world');
    last = world ? world.style.transform : '';
    S.on = true;
    requestAnimationFrame(loop(++gen));
  };
  S.stop = () => { S.on = false; return { t: S.t, moves: S.moves }; };
  S.camera = () => {
    const w = document.querySelector('.world');
    const m = w && /translate\\(([-\\d.e]+)px, ([-\\d.e]+)px\\) scale\\(([-\\d.e]+)\\)/.exec(w.style.transform);
    return m ? { x: +m[1], y: +m[2], zoom: +m[3] } : null;
  };
  S.scan = () => {
    const hosts = document.querySelectorAll('[data-artboard-host]');
    let elements = document.querySelectorAll('*').length, imgs = 0, imgsDone = 0, vids = 0, vidsReady = 0;
    let anims = 0, held = 0, visible = 0;
    const vw = innerWidth, vh = innerHeight;
    for (const h of hosts) {
      const r = h.shadowRoot;
      if (!r) continue;
      elements += r.querySelectorAll('*').length;
      for (const im of r.querySelectorAll('img')) { imgs++; if (im.complete) imgsDone++; }
      for (const v of r.querySelectorAll('video')) { vids++; if (v.readyState >= 2) vidsReady++; }
      for (const a of r.getAnimations()) {
        if (a.playState !== 'running') continue;
        anims++;
        if (a.playbackRate === 0) held++;
      }
      const b = h.parentElement && h.parentElement.getBoundingClientRect();
      if (b && b.right > 0 && b.bottom > 0 && b.left < vw && b.top < vh) visible++;
    }
    return { boards: hosts.length, visible, elements, imgs, imgsDone, vids, vidsReady, anims, held,
      chromeAnims: document.getAnimations().filter((a) => a.playState === 'running').length,
      fonts: document.fonts.status };
  };
  const note = (data) => {
    try {
      const m = JSON.parse(data);
      S.messages.push({ ...m, at: performance.now() });
      if (m.t === 'drawn' && S.drawn == null) {
        S.drawn = performance.now();
        if (S.onDrawn) S.onDrawn();
      }
      if (m.t === 'ready' && S.ready == null) S.ready = performance.now();
      if (m.t === 'error') S.errors.push(m.message);
    } catch {}
  };
  // The page talks to the app through ReactNativeWebView in the app; elsewhere it posts to its
  // parent. Either way, every message passes through here first.
  const rn = window.ReactNativeWebView;
  if (rn) {
    const post = rn.postMessage.bind(rn);
    rn.postMessage = (d) => { note(d); post(d); };
  } else {
    window.ReactNativeWebView = { postMessage: (d) => { note(d); if (window.__pzPerfOut) window.__pzPerfOut(d); } };
  }
})();`;
