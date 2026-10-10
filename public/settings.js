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
      showHousehold(me);
    });
  }

  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(redirectToLogin);
  });

  function renderHousehold(h) {
    document.getElementById('householdName').textContent = h.name;
    document.getElementById('inviteCode').textContent = h.inviteCode;
    document.getElementById('householdMembers').textContent = 'Members: ' + h.members.join(', ');
    document.getElementById('householdSection').classList.remove('hidden');
  }

  function showHousehold(me) {
    if (me.isAdmin) document.getElementById('adminSection').classList.remove('hidden');
    if (!me.household) return;
    apiFetch('/household').then(renderHousehold).catch(function (err) { alert(err.message); });
  }

  document.getElementById('regenerateCodeBtn').addEventListener('click', function () {
    if (!confirm('Make a new invite code? The current one will stop working.')) return;
    apiFetch('/household/invite-code', { method: 'POST' })
      .then(renderHousehold)
      .catch(function (err) { alert(err.message); });
  });

  // Per-browser preference (localStorage, not synced across devices) - the
  // same key the inline no-flash snippet at the top of every page's <head>
  // reads before the stylesheet loads. "Auto" means no stored value at
  // all, so the prefers-color-scheme rules in styles.css decide.
  var THEME_KEY = 'theme';

  function currentTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return (t === 'light' || t === 'dark') ? t : 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function renderActiveChip(theme) {
    document.querySelectorAll('#themeChips .chip').forEach(function (chip) {
      chip.classList.toggle('active', chip.getAttribute('data-theme') === theme);
    });
  }

  document.querySelectorAll('#themeChips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var theme = chip.getAttribute('data-theme');
      try {
        if (theme === 'auto') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, theme);
      } catch (e) {}
      applyTheme(theme);
      renderActiveChip(theme);
    });
  });

  renderActiveChip(currentTheme());
  loadWhoAmI();
})();
