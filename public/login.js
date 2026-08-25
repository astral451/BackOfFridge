(function () {
  function showError(message) {
    var el = document.getElementById('authError');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearError() {
    document.getElementById('authError').classList.add('hidden');
  }

  function afterAuth() {
    var params = new URLSearchParams(window.location.search);
    window.location.href = params.get('next') || 'index.html';
  }

  document.getElementById('showSignup').addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('loginPane').classList.add('hidden');
    document.getElementById('signupPane').classList.remove('hidden');
    clearError();
  });

  document.getElementById('showLogin').addEventListener('click', function (e) {
    e.preventDefault();
    document.getElementById('signupPane').classList.add('hidden');
    document.getElementById('loginPane').classList.remove('hidden');
    clearError();
  });

  document.getElementById('loginBtn').addEventListener('click', function () {
    clearError();
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value,
      }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (b) { throw new Error(b.error || 'login failed'); });
      return res.json();
    }).then(afterAuth).catch(function (err) { showError(err.message); });
  });

  document.getElementById('signupBtn').addEventListener('click', function () {
    clearError();
    fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('signup-username').value,
        password: document.getElementById('signup-password').value,
      }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (b) { throw new Error(b.error || 'signup failed'); });
      return res.json();
    }).then(afterAuth).catch(function (err) { showError(err.message); });
  });
})();
