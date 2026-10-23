(function () {
  function showError(message) {
    var el = document.getElementById('authError');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearError() {
    document.getElementById('authError').classList.add('hidden');
  }

  // Where to go once logged in: a pending account to the waiting page, the
  // admin account (no household) to the admin page, everyone else to where
  // they were heading.
  function afterAuth(me) {
    if (me.status === 'pending') {
      window.location.href = 'pending.html';
    } else if (me.isAdmin && !me.household) {
      window.location.href = 'admin.html';
    } else {
      var params = new URLSearchParams(window.location.search);
      window.location.href = params.get('next') || 'index.html';
    }
  }

  // As an invite code is typed, say what it does: join a named household,
  // or create a new one (which then needs a name).
  var codeInput = document.getElementById('signup-code');
  var codeInfo = document.getElementById('codeInfo');
  var householdInput = document.getElementById('signup-household');
  var codeKind = null;

  function normalizedCode() {
    return codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function showCodeInfo(text, isError) {
    codeInfo.textContent = text;
    codeInfo.classList.toggle('auth-error', !!isError);
    codeInfo.classList.toggle('hidden', !text);
  }

  function checkCode() {
    var code = normalizedCode();
    document.getElementById('noCodeHint').classList.toggle('hidden', code.length > 0);
    codeKind = null;
    householdInput.classList.add('hidden');
    if (code.length < 8) {
      showCodeInfo(code.length ? 'Invite codes are 8 letters and numbers.' : '', false);
      return;
    }
    fetch('/api/auth/check-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (r) {
      if (code !== normalizedCode()) return; // typed on since
      if (!r.ok) {
        showCodeInfo(r.body.error || 'invite code not recognised', true);
        return;
      }
      codeKind = r.body.type;
      if (codeKind === 'join') {
        showCodeInfo('You\'ll join "' + r.body.householdName + '".', false);
      } else {
        showCodeInfo('This code starts a new household. What should it be called?', false);
        householdInput.classList.remove('hidden');
      }
    });
  }

  codeInput.addEventListener('input', checkCode);

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
        code: normalizedCode(),
        householdName: codeKind === 'new_household' ? householdInput.value : '',
      }),
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (b) { throw new Error(b.error || 'signup failed'); });
      return res.json();
    }).then(afterAuth).catch(function (err) { showError(err.message); });
  });
})();
