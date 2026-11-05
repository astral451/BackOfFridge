// Shared by every signed-in page. Load it before the page's own script, so
// it wraps fetch before anything uses it.
//
// 1. Heartbeat. While the page is visible, POST /api/ping every 60 s so the
//    server knows the app is open (server/src/activity.js). That's what
//    scripts/activity.js and restart.sh check before an update.
//
// 2. "Being updated" screen. If an API call can't reach the server (network
//    error, a 502/503/504, or Cloudflare's 52x/530 while the server is
//    stopped), show a notice and check back every 5 s.
//    - The failed call never settles, so the page doesn't flash an error,
//      and an open form keeps what was typed.
//    - When the server answers again, the page reloads to pick up the new
//      code. If a change didn't get through, or a form is open, it says so
//      and leaves the reload to you. It never resends a change by itself,
//      since that could save it twice.
(function () {
  var realFetch = window.fetch.bind(window);
  var HEARTBEAT_MS = 60 * 1000;
  var RETRY_MS = 5 * 1000;
  var SLOW_MS = 3 * 60 * 1000;

  var down = false;
  var downSince = 0;
  var lostWrite = false;
  var ui = null;
  var clock = null;

  function isDownStatus(status) {
    return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
  }

  function apiPath(input) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf(location.origin) === 0) url = url.slice(location.origin.length);
    return url.indexOf('/api/') === 0 ? url : null;
  }

  window.fetch = function (input, init) {
    var p = apiPath(input);
    if (!p) return realFetch(input, init);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var isWrite = method !== 'GET' && method !== 'HEAD' && p !== '/api/ping';
    return realFetch(input, init).then(function (res) {
      if (!isDownStatus(res.status)) return res;
      serverDown(isWrite);
      return new Promise(function () {});
    }, function (err) {
      if (err && err.name === 'AbortError') throw err;
      serverDown(isWrite);
      return new Promise(function () {});
    });
  };

  // --- Heartbeat ----------------------------------------------------------

  function ping() {
    if (down || document.visibilityState !== 'visible') return;
    window.fetch('/api/ping', { method: 'POST' }).catch(function () {});
  }
  setInterval(ping, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', ping);
  ping();

  // --- Down / back ----------------------------------------------------------

  function serverDown(isWrite) {
    if (isWrite) lostWrite = true;
    if (down) return;
    down = true;
    downSince = Date.now();
    showDown();
    setTimeout(check, RETRY_MS);
  }

  function check() {
    realFetch('/api/auth/me', { cache: 'no-store' }).then(function (res) {
      if (isDownStatus(res.status)) return setTimeout(check, RETRY_MS);
      serverBack();
    }, function () {
      setTimeout(check, RETRY_MS);
    });
  }

  function formOpen() {
    return !!document.querySelector('.sheet:not([hidden]), dialog[open]');
  }

  function serverBack() {
    clearInterval(clock);
    if (!lostWrite && !formOpen()) {
      location.reload();
      return;
    }
    render('Back online',
      lostWrite
        ? 'Your last change didn\'t reach the server. It\'s still on screen: save it again.'
        : 'Your entry is still here.',
      'Reload when you\'re done, to get the updated app.',
      [
        { label: 'Continue', primary: true, onClick: function () { hide(); down = false; lostWrite = false; } },
        { label: 'Reload now', onClick: function () { location.reload(); } },
      ]);
  }

  // --- The notice -----------------------------------------------------------

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render(title, body, detail, buttons) {
    if (!ui) {
      ui = el('div', 'conn-overlay');
      ui.setAttribute('role', 'alertdialog');
      ui.setAttribute('aria-modal', 'true');
      ui.setAttribute('aria-live', 'assertive');
      document.body.appendChild(ui);
    }
    ui.textContent = '';
    var card = el('div', 'conn-card');
    card.appendChild(el('h2', null, title));
    card.appendChild(el('p', null, body));
    var d = el('p', 'conn-detail', detail);
    card.appendChild(d);
    if (buttons && buttons.length) {
      var row = el('div', 'conn-actions');
      buttons.forEach(function (b) {
        var btn = el('button', b.primary ? 'conn-primary' : 'small', b.label);
        btn.type = 'button';
        btn.addEventListener('click', b.onClick);
        row.appendChild(btn);
      });
      card.appendChild(row);
    }
    ui.appendChild(card);
    ui.hidden = false;
    return d;
  }

  function hide() {
    if (ui) ui.hidden = true;
  }

  function elapsed() {
    var s = Math.round((Date.now() - downSince) / 1000);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function showDown() {
    var offline = navigator.onLine === false;
    var detail = render(
      offline ? 'You\'re offline' : 'Server is being updated',
      offline ? 'Waiting for a connection.' : 'Expected back in about a minute.',
      '');
    var update = function () {
      var slow = !offline && Date.now() - downSince > SLOW_MS;
      detail.textContent = (slow ? 'Taking longer than usual. ' : '')
        + 'Unreachable for ' + elapsed() + ' · checking every few seconds.';
    };
    update();
    clearInterval(clock);
    clock = setInterval(update, 1000);
  }
})();
