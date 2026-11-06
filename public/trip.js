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

  // --- One trip, read back (features.md, "Trips": a past trip). Opened
  // from the Lists page as trip.html?id=<trip id>. What wasn't found can
  // go back on the shopping list; a row bought under a name close to one
  // the household already uses asks "Same as your ...?".

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var tripId = new URLSearchParams(window.location.search).get('id');
  var trip = null;
  var carried = null; // after "Put them on the shopping list": the button's new text

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  function serverTime(s) { return s ? new Date(s.replace(' ', 'T') + 'Z') : null; }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function clock(d) {
    var h = d.getHours();
    return (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (h < 12 ? ' am' : ' pm');
  }
  function dayName(d) {
    var today = new Date();
    return WEEKDAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate()
      + (d.getFullYear() !== today.getFullYear() ? ', ' + d.getFullYear() : '');
  }
  function shortDate(iso) {
    var d = new Date(iso + 'T00:00:00');
    return WEEKDAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }
  function qty(e) { return e.quantity != null ? '×' + e.quantity + (e.unit ? ' ' + e.unit : '') : (e.unit || ''); }

  // "No" to a "Same as your ...?" is remembered on this phone.
  function dismissed() {
    try { return JSON.parse(localStorage.getItem('sameAsNo') || '[]'); } catch (e) { return []; }
  }
  function dismiss(itemId) {
    var d = dismissed();
    d.push(itemId);
    try { localStorage.setItem('sameAsNo', JSON.stringify(d.slice(-200))); } catch (e) {}
  }

  function render() {
    var start = serverTime(trip.started_at || trip.created_at);
    var end = serverTime(trip.ended_at);
    document.getElementById('tripTitle').textContent = dayName(start);
    document.title = 'BackOfFridge - ' + dayName(start);
    var people = [];
    trip.entries.forEach(function (e) { if (e.bought_at && e.added_by && people.indexOf(e.added_by) === -1) people.push(e.added_by); });
    document.getElementById('tripMeta').textContent = [
      clock(start) + (end && sameDay(start, end) && end - start > 60000 ? '–' + clock(end) : ''),
      trip.status === 'active' ? 'still going' : '',
      people.join(', '),
    ].filter(Boolean).join(' · ');

    var missed = trip.entries.filter(function (e) { return !e.bought_at; });
    var box = document.getElementById('missedBox');
    box.hidden = !missed.length;
    if (missed.length) {
      document.getElementById('missedHeading').textContent = 'Not found (' + missed.length + ')';
      document.getElementById('missedNames').textContent = missed.map(function (e) {
        return e.name + (qty(e) ? ' ' + qty(e) : '');
      }).join(' · ');
      var btn = document.getElementById('carryBtn');
      btn.disabled = !!carried;
      btn.textContent = carried || (missed.length === 1 ? 'Put it on the shopping list'
        : missed.length === 2 ? 'Put both on the shopping list' : 'Put them on the shopping list');
    }

    var got = trip.entries.filter(function (e) { return e.bought_at; });
    document.getElementById('gotHeading').textContent = 'Got (' + got.length + ')';
    var people2 = people.length > 1;
    var no = dismissed();
    var list = document.getElementById('gotList');
    list.textContent = '';
    got.forEach(function (e, i) {
      var li = el('li');
      li.value = got.length - i;
      var card = el('div', 'trip-row static past-got');
      // Tapping the name/detail edits the item, on the main page.
      var main = el(e.item_id != null && !e.deleted ? 'a' : 'div', 'past-got-main');
      if (main.tagName === 'A') main.href = 'index.html#edit=' + e.item_id;
      main.appendChild(el('span', 'trip-name', e.name));
      var detail;
      if (e.item_id == null) detail = 'ticked off by hand';
      else if (e.deleted) detail = 'Deleted';
      else {
        detail = [qty(e) || '×1', e.location || 'no location',
          e.expiration_date ? 'expires ' + shortDate(e.expiration_date) : 'no expiry'].join(' · ');
        if (e.source) detail += ' · ✓ from the list';
        if (people2 && e.added_by) detail += ' · ' + e.added_by;
      }
      main.appendChild(el('span', 'trip-detail', detail));
      card.appendChild(main);
      if (e.same_as && no.indexOf(e.item_id) === -1) card.appendChild(sameAsBox(e));
      li.appendChild(card);
      list.appendChild(li);
    });
  }

  function sameAsBox(e) {
    var box = el('div', 'same-as');
    var q = el('span', 'same-as-q');
    q.appendChild(document.createTextNode('Same as your '));
    q.appendChild(el('strong', null, '"' + e.same_as + '"'));
    q.appendChild(document.createTextNode('?'));
    var yes = el('button', 'same-as-yes', 'Yes, rename');
    yes.type = 'button';
    yes.addEventListener('click', function () {
      yes.disabled = true;
      apiFetch('/items/' + e.item_id + '/same-as', { method: 'POST', body: JSON.stringify({ name: e.same_as }) })
        .then(load).catch(function (err) { yes.disabled = false; alert(err.message); });
    });
    var no = el('button', 'same-as-no', 'No');
    no.type = 'button';
    no.setAttribute('aria-label', 'No, it\'s different');
    no.addEventListener('click', function () { dismiss(e.item_id); render(); });
    box.appendChild(q);
    box.appendChild(yes);
    box.appendChild(no);
    return box;
  }

  document.getElementById('carryBtn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    apiFetch('/trips/' + encodeURIComponent(tripId) + '/carry-over', { method: 'POST' }).then(function (r) {
      carried = r.added ? '✓ On the shopping list' : '✓ Already on the shopping list';
      btn.textContent = carried;
    }).catch(function (err) { btn.disabled = false; alert(err.message); });
  });

  function load() {
    return apiFetch('/trips/' + encodeURIComponent(tripId)).then(function (r) {
      trip = r.trip;
      render();
    }).catch(function (err) {
      document.getElementById('tripMeta').textContent = err.message === 'not found' ? 'That trip isn\'t there any more.' : err.message;
    });
  }

  loadWhoAmI();
  if (tripId) load();
  else document.getElementById('tripMeta').textContent = 'No trip chosen.';
})();
