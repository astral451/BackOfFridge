(function () {
  function redirectToLogin() {
    window.location.href = 'login.html?next=' + encodeURIComponent(window.location.pathname.split('/').pop());
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
      if (me) document.getElementById('whoami').textContent = 'Signed in as ' + me.username;
    });
  }

  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(redirectToLogin);
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
