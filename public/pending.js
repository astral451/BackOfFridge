(function () {
  function check(manual) {
    fetch('/api/auth/me').then(function (res) {
      if (!res.ok) {
        window.location.href = 'login.html';
        return null;
      }
      return res.json();
    }).then(function (me) {
      if (!me) return;
      if (me.status !== 'pending') {
        window.location.href = me.isAdmin && !me.household ? 'admin.html' : 'index.html';
        return;
      }
      document.getElementById('pendingName').textContent = ', ' + me.username;
      if (manual) document.getElementById('pendingStatus').textContent = 'Still waiting. Checked at ' + new Date().toLocaleTimeString() + '.';
    });
  }

  document.getElementById('checkBtn').addEventListener('click', function () { check(true); });
  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).then(function () { window.location.href = 'login.html'; });
  });

  check(false);
})();
