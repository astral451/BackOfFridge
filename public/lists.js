(function () {
  function redirectToLogin() {
    window.location.href = 'login.html?next=' + encodeURIComponent(window.location.pathname.split('/').pop());
  }

  // Pages here show household data. A pending account goes to the waiting
  // page instead, and the admin account (no household) to the admin page.
  // Takes either /api/auth/me's user or a 403 body's { reason }.
  function redirectIfNoHousehold(info) {
    if (info.status === 'pending' || info.reason === 'pending') {
      window.location.href = 'pending.html';
      return true;
    }
    if ((info.isAdmin && !info.household) || info.reason === 'admin') {
      window.location.href = 'admin.html';
      return true;
    }
    return false;
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
    return fetch('/api' + path, opts).then(function (res) {
      if (res.status === 401) {
        redirectToLogin();
        throw new Error('not logged in');
      }
      if (!res.ok) {
        return res.json().then(function (body) {
          // Leaving the page: settle nothing, so no error alert flashes first.
          if (res.status === 403 && redirectIfNoHousehold(body)) return new Promise(function () {});
          throw new Error(body.error || 'request failed');
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  function loadWhoAmI() {
    fetch('/api/auth/me').then(function (res) {
      if (!res.ok) {
        redirectToLogin();
        return null;
      }
      return res.json();
    }).then(function (me) {
      if (!me || redirectIfNoHousehold(me)) return;
      document.getElementById('whoami').textContent = 'Signed in as ' + me.username;
    });
  }

  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(redirectToLogin);
  });

  // --- The Lists page (features.md, "Trips", the Lists page): the trip
  // going now, the shopping list, and past trips. Everything here is
  // shared by the household, so it re-reads every 15 s while showing.

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var REFRESH_MS = 15000;
  var data = null;      // the last GET /trips answer
  var older = [];       // past trips loaded with "Show older trips"

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  // The server's UTC "YYYY-MM-DD HH:MM:SS".
  function serverTime(s) { return s ? new Date(s.replace(' ', 'T') + 'Z') : null; }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function clock(d) {
    var h = d.getHours();
    var m = String(d.getMinutes()).padStart(2, '0');
    return (h % 12 || 12) + ':' + m + (h < 12 ? ' am' : ' pm');
  }
  function dayName(d) {
    var today = new Date();
    var yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    if (sameDay(d, today)) return 'Today';
    if (sameDay(d, yesterday)) return 'Yesterday';
    return WEEKDAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate()
      + (d.getFullYear() !== today.getFullYear() ? ', ' + d.getFullYear() : '');
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function waitingText(w) {
    return w.name + (w.quantity != null ? ' ×' + w.quantity + (w.unit ? ' ' + w.unit : '') : '');
  }

  function renderNow(t) {
    document.getElementById('nowCard').hidden = !t;
    document.getElementById('nowNone').hidden = !!t;
    if (!t) return;
    var started = serverTime(t.started_at);
    document.getElementById('nowStarted').textContent = 'Started '
      + (sameDay(started, new Date()) ? clock(started) : dayName(started) + ', ' + clock(started));
    document.getElementById('nowPeople').textContent = t.people.join(', ');
    // Progress through the list, when the trip came from one.
    var bar = document.getElementById('nowProgress');
    bar.hidden = !t.listed;
    if (t.listed) {
      var done = t.listed - t.todo;
      document.getElementById('nowBar').style.width = Math.round(100 * done / t.listed) + '%';
      bar.setAttribute('aria-label', done + ' of ' + t.listed + ' from the list');
    }
    var text = document.getElementById('nowSummary');
    text.textContent = t.got + ' saved';
    if (t.todo) {
      text.appendChild(document.createTextNode(' · '));
      text.appendChild(el('strong', null, t.todo + ' still to get: '));
      text.appendChild(document.createTextNode(t.waiting.map(waitingText).join(', ')
        + (t.todo > t.waiting.length ? ', …' : '')));
    }
  }

  function renderList(planned, suggestedCount) {
    var n = planned ? planned.todo : 0;
    document.getElementById('listCount').textContent = n ? plural(n, 'thing', 'things') : 'Nothing on it yet';
    document.getElementById('listSuggested').textContent = suggestedCount ? '+ ' + suggestedCount + ' suggested' : '';
    var chips = document.getElementById('listChips');
    chips.textContent = '';
    (planned ? planned.waiting : []).forEach(function (w) { chips.appendChild(el('span', 'chip-item', waitingText(w))); });
    if (n > 6) chips.appendChild(el('span', 'chip-item muted', '+ ' + (n - 6) + ' more'));
    document.getElementById('startBtn').disabled = !n;
  }

  function pastRow(t) {
    var li = el('li');
    var row = el('div', 'trip-row static past-row');
    var textBox = el('div', 'past-text');
    var start = serverTime(t.started_at || t.created_at);
    var end = serverTime(t.ended_at);
    textBox.appendChild(el('span', 'trip-name', dayName(start)));
    var parts = [plural(t.got, 'got', 'got')];
    if (t.ticked) parts.push(t.ticked + ' ticked');
    parts.push(clock(start) + (end && sameDay(start, end) && end - start > 60000 ? '–' + clock(end) : ''));
    if (t.people.length) parts.push(t.people.join(', '));
    textBox.appendChild(el('span', 'trip-detail', parts.join(' · ')));
    row.appendChild(textBox);
    if (t.todo) row.appendChild(el('span', 'tag-warn', t.todo + ' not found'));
    li.appendChild(row);
    return li;
  }

  function renderPast(past, more) {
    var ul = document.getElementById('pastRows');
    ul.textContent = '';
    past.forEach(function (t) { ul.appendChild(pastRow(t)); });
    document.getElementById('pastNone').hidden = past.length > 0;
    document.getElementById('olderBtn').hidden = !more;
  }

  function load() {
    return Promise.all([apiFetch('/trips'), apiFetch('/trips/list')]).then(function (r) {
      data = r[0];
      var s = r[1].suggestions;
      renderNow(data.active);
      renderList(data.planned, s.used.length + s.low_stock.length + s.expiring.length);
      renderPast(data.past.concat(older), older.length ? olderMore : data.more);
    }).catch(function (err) { console.error(err); });
  }

  var olderMore = false;
  document.getElementById('olderBtn').addEventListener('click', function () {
    var all = data.past.concat(older);
    var last = all[all.length - 1];
    apiFetch('/trips?before=' + encodeURIComponent(last.started_at || last.created_at)).then(function (r) {
      older = older.concat(r.past);
      olderMore = r.more;
      renderPast(data.past.concat(older), olderMore);
    }).catch(function (err) { alert(err.message); });
  });

  // Someone at home remembers something: it goes on the trip going now,
  // under "Still to get" on the shopper's phone.
  document.getElementById('addTripForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('addTripName');
    var name = input.value.trim();
    if (!name || !data || !data.active) return;
    apiFetch('/trips/' + encodeURIComponent(data.active.id) + '/entries', {
      method: 'POST', body: JSON.stringify({ name: name }),
    }).then(function (entry) {
      input.value = '';
      if (!entry.added) alert('"' + name + '" is already on this trip.');
      load();
    }).catch(function (err) { alert(err.message); load(); });
  });

  document.getElementById('endTripBtn').addEventListener('click', function () {
    if (!data || !data.active) return;
    if (!window.confirm('End this trip for everyone? The items stay saved.')) return;
    apiFetch('/trips/' + encodeURIComponent(data.active.id) + '/end', { method: 'POST' }).then(load)
      .catch(function (err) { alert(err.message); });
  });

  document.getElementById('startBtn').addEventListener('click', function () {
    if (!data || !data.planned) return;
    var btn = this;
    btn.disabled = true;
    apiFetch('/trips/' + encodeURIComponent(data.planned.id) + '/start', { method: 'POST' }).then(function (r) {
      // This phone is shopping: it gets the "New item added" notices.
      try { localStorage.setItem('myTrip', r.trip.id); } catch (e) {}
      window.location.href = 'index.html#trip';
    }).catch(function (err) { btn.disabled = false; alert(err.message); });
  });

  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);

  loadWhoAmI();
  load();
})();
