(() => {
  const $ = id => document.getElementById(id);

  function b64uToBuf(b64u) {
    const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
    const b64 = (b64u + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function bufToB64u(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.code = data.code;
      throw err;
    }
    return data;
  }

  function randomTempPassword() {
    const words = ['granite', 'merced', 'sequoia', 'elcap', 'halfdome', 'pine', 'falls', 'meadow', 'valley', 'trail'];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    const num = Math.floor(1000 + Math.random() * 9000);
    return `${pick()}-${pick()}-${num}`;
  }

  async function runPasskeyRegistration(label) {
    if (!window.PublicKeyCredential || !navigator.credentials?.create) {
      throw new Error('This browser does not support passkeys. Try Chrome, Safari, or Edge over HTTPS.');
    }
    const { ceremonyId, options } = await api('/api/auth/passkey/register/options', { method: 'POST' });

    const publicKey = {
      ...options,
      challenge: b64uToBuf(options.challenge),
      user: {
        ...options.user,
        id: b64uToBuf(options.user.id)
      },
      excludeCredentials: (options.excludeCredentials || []).map(c => ({
        ...c,
        id: b64uToBuf(c.id)
      }))
    };

    const cred = await navigator.credentials.create({ publicKey });
    if (!cred) throw new Error('Passkey creation was cancelled.');

    const response = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : []
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };

    return api('/api/auth/passkey/register/verify', {
      method: 'POST',
      body: JSON.stringify({ ceremonyId, response, label })
    });
  }

  async function runPasskeyLogin() {
    if (!window.PublicKeyCredential || !navigator.credentials?.get) {
      throw new Error('This browser does not support passkeys.');
    }
    const { ceremonyId, options } = await api('/api/auth/login/passkey/options', { method: 'POST' });

    const publicKey = {
      ...options,
      challenge: b64uToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map(c => ({
        ...c,
        id: b64uToBuf(c.id)
      }))
    };

    const cred = await navigator.credentials.get({ publicKey });
    if (!cred) throw new Error('Passkey sign-in was cancelled.');

    const response = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : null
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {}
    };

    return api('/api/auth/login/passkey/verify', {
      method: 'POST',
      body: JSON.stringify({ ceremonyId, response })
    });
  }

  let currentMember = null;
  let onReadyCallback = null;

  function showGate(panelId) {
    $('appShell').classList.add('hidden');
    $('authGate').classList.remove('hidden');
    ['setupForm', 'loginPanel', 'enrollPanel'].forEach(id => {
      $(id).classList.toggle('hidden', id !== panelId);
    });
  }

  function showApp(member) {
    currentMember = member;
    $('authGate').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    $('currentUserLabel').textContent = member.name;
    if (typeof onReadyCallback === 'function') {
      onReadyCallback(member);
      onReadyCallback = null;
    }
  }

  async function checkAuthStatus() {
    const status = await api('/api/auth/status');
    if (!status.initialized) {
      showGate('setupForm');
      return status;
    }
    if (!status.authenticated) {
      $('passkeyLoginSection').classList.toggle('hidden', !status.hasPasskeys);
      showGate('loginPanel');
      return status;
    }
    if (status.mustEnrollPasskey) {
      currentMember = status.member;
      showGate('enrollPanel');
      return status;
    }
    showApp(status.member);
    return status;
  }

  // Render own passkeys & admin roster inside Accounts modal
  function renderOwnPasskeys(member) {
    currentMember = member;
    $('ownAccountRole').textContent = member.role;
    $('ownPasskeyHint').textContent = member.role === 'Administrator'
      ? 'As Administrator, your password stays active as a backup even after adding passkeys.'
      : 'You sign in with your passkey. Add a backup device anytime.';

    const keys = member.passkeys || [];
    const list = $('ownPasskeysList');
    if (!keys.length) {
      list.innerHTML = `<div class="muted" style="font-size:0.86rem">No passkeys registered yet. Add one below for 1-tap sign-in!</div>`;
      return;
    }
    list.innerHTML = keys.map(k => `
      <div class="passkey-row">
        <div>
          <strong>🔑 ${escapeHtml(k.label)}</strong>
          <div class="muted" style="font-size:0.78rem">Added ${new Date(k.createdAt).toLocaleDateString()}${k.lastUsedAt ? ' · Last used ' + new Date(k.lastUsedAt).toLocaleDateString() : ''}</div>
        </div>
        <button class="btn btn-danger btn-sm" data-remove-own-key="${escapeHtml(k.id)}" type="button">Remove</button>
      </div>
    `).join('');
  }

  function renderRoster(data) {
    const members = data.members || [];
    const list = $('rosterList');
    list.innerHTML = members.map(m => {
      const isSelf = currentMember && m.id === currentMember.id;
      const method = m.passkeyCount > 0
        ? `${m.passkeyCount} passkey${m.passkeyCount === 1 ? '' : 's'}${m.passwordEnabled ? ' + backup password' : ' only'}`
        : (m.passwordResetRequired ? 'Pending 1-time temp password → passkey' : 'Password only');

      return `
        <div class="roster-card">
          <div class="roster-head">
            <strong>${escapeHtml(m.name)}${isSelf ? ' (you)' : ''}</strong>
            <span class="badge">${escapeHtml(m.role)}</span>
            <span class="badge ${m.active ? 'badge-active' : 'badge-paused'}">${m.active ? 'Active' : 'Disabled'}</span>
            ${m.passwordResetRequired ? '<span class="badge badge-paused">Must set up passkey on next login</span>' : ''}
          </div>
          <div class="roster-meta">Sign-in: <strong>${escapeHtml(method)}</strong> · Last sign-in: ${m.lastSignInAt ? new Date(m.lastSignInAt).toLocaleString() : 'Never'}</div>
          <div class="roster-actions">
            <button class="btn btn-secondary btn-sm" data-roster-reset="${escapeHtml(m.id)}" data-roster-name="${escapeHtml(m.name)}" data-roster-role="${escapeHtml(m.role)}" type="button">${m.role === 'Member' ? 'Reset Sign-In (New Temp PW)' : 'Change Password'}</button>
            ${!isSelf ? `<button class="btn btn-ghost btn-sm" data-roster-toggle="${escapeHtml(m.id)}" data-roster-active="${m.active ? '1' : '0'}" type="button">${m.active ? 'Disable' : 'Enable'}</button>` : ''}
            ${!isSelf ? `<button class="btn btn-danger btn-sm" data-roster-delete="${escapeHtml(m.id)}" data-roster-name="${escapeHtml(m.name)}" type="button">Remove</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    const audit = data.audit || [];
    $('auditList').innerHTML = audit.length
      ? audit.map(a => `<div class="audit-row"><strong>${escapeHtml(a.actorName)}</strong> · ${escapeHtml(a.action)}${a.detail ? ' — ' + escapeHtml(a.detail) : ''} <span style="float:right">${new Date(a.timestamp).toLocaleString()}</span></div>`).join('')
      : '<div class="muted" style="font-size:0.82rem">No access events yet.</div>';
  }

  async function openAccountsModal() {
    $('ownPasskeyFeedback').classList.add('hidden');
    $('ownPasskeyError').classList.add('hidden');
    $('amError').classList.add('hidden');
    $('amFeedback').classList.add('hidden');

    const status = await api('/api/auth/status');
    if (status.member) {
      renderOwnPasskeys(status.member);
    }

    const isAdmin = status.member?.role === 'Administrator';
    $('adminRosterSection').classList.toggle('hidden', !isAdmin);
    if (isAdmin) {
      const roster = await api('/api/auth/roster');
      renderRoster(roster);
    }
    $('accountsModal').classList.remove('hidden');
  }

  function bindAuthEvents() {
    // 1. Setup form
    $('setupForm').addEventListener('submit', async e => {
      e.preventDefault();
      $('setupError').classList.add('hidden');
      try {
        const res = await api('/api/auth/setup', {
          method: 'POST',
          body: JSON.stringify({
            name: $('setupName').value.trim(),
            password: $('setupPassword').value,
            confirmPassword: $('setupConfirm').value
          })
        });
        showApp(res.member);
        // Immediately offer to add a passkey
        setTimeout(() => openAccountsModal(), 300);
      } catch (err) {
        $('setupError').textContent = err.message;
        $('setupError').classList.remove('hidden');
      }
    });

    // 2. Password sign-in
    $('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      $('loginError').classList.add('hidden');
      try {
        const res = await api('/api/auth/login/password', {
          method: 'POST',
          body: JSON.stringify({ password: $('loginPassword').value })
        });
        $('loginPassword').value = '';
        if (res.mustEnrollPasskey) {
          currentMember = res.member;
          showGate('enrollPanel');
        } else {
          showApp(res.member);
        }
      } catch (err) {
        $('loginError').textContent = err.message;
        $('loginError').classList.remove('hidden');
      }
    });

    // 3. Passkey sign-in
    $('btnPasskeyLogin').addEventListener('click', async () => {
      $('loginError').classList.add('hidden');
      try {
        const res = await runPasskeyLogin();
        if (res.mustEnrollPasskey) {
          currentMember = res.member;
          showGate('enrollPanel');
        } else {
          showApp(res.member);
        }
      } catch (err) {
        $('loginError').textContent = err.message;
        $('loginError').classList.remove('hidden');
      }
    });

    // 4. Mandatory Passkey enrollment
    $('btnEnrollPasskey').addEventListener('click', async () => {
      $('enrollError').classList.add('hidden');
      try {
        const res = await runPasskeyRegistration($('enrollLabel').value.trim() || 'My Device');
        showApp(res.member);
      } catch (err) {
        $('enrollError').textContent = err.message;
        $('enrollError').classList.remove('hidden');
      }
    });

    $('btnEnrollSignOut').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.reload();
    });

    // Topbar Account & Sign Out
    $('btnAccounts').addEventListener('click', openAccountsModal);
    $('btnSignOut').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.reload();
    });

    // Add own passkey
    $('btnAddOwnPasskey').addEventListener('click', async () => {
      $('ownPasskeyFeedback').classList.add('hidden');
      $('ownPasskeyError').classList.add('hidden');
      try {
        const res = await runPasskeyRegistration($('ownNewKeyLabel').value.trim() || 'My Device');
        $('ownNewKeyLabel').value = '';
        renderOwnPasskeys(res.member);
        $('ownPasskeyFeedback').textContent = res.retiredPassword
          ? 'Passkey added! Your temporary password has been retired.'
          : 'Passkey added! Your admin password remains active as a backup.';
        $('ownPasskeyFeedback').classList.remove('hidden');
        if (res.member.role === 'Administrator') {
          renderRoster(await api('/api/auth/roster'));
        }
      } catch (err) {
        $('ownPasskeyError').textContent = err.message;
        $('ownPasskeyError').classList.remove('hidden');
      }
    });

    // Remove own passkey
    $('ownPasskeysList').addEventListener('click', async e => {
      const btn = e.target.closest('button[data-remove-own-key]');
      if (!btn) return;
      if (!confirm('Remove this passkey?')) return;
      $('ownPasskeyError').classList.add('hidden');
      try {
        const res = await api(`/api/auth/passkey/${encodeURIComponent(btn.getAttribute('data-remove-own-key'))}`, { method: 'DELETE' });
        renderOwnPasskeys(res.member);
      } catch (err) {
        $('ownPasskeyError').textContent = err.message;
        $('ownPasskeyError').classList.remove('hidden');
      }
    });

    // Generate / Copy temp password
    $('btnGenTempPw').addEventListener('click', () => {
      $('amPassword').value = randomTempPassword();
    });
    $('btnCopyTempPw').addEventListener('click', async () => {
      const v = $('amPassword').value.trim();
      if (!v) return;
      await navigator.clipboard?.writeText(v).catch(() => {});
      $('amFeedback').textContent = 'Copied temporary password to clipboard!';
      $('amFeedback').classList.remove('hidden');
    });

    // Create new member
    $('addMemberForm').addEventListener('submit', async e => {
      e.preventDefault();
      $('amError').classList.add('hidden');
      $('amFeedback').classList.add('hidden');
      const pw = $('amPassword').value;
      const role = $('amRole').value;
      try {
        const res = await api('/api/auth/members', {
          method: 'POST',
          body: JSON.stringify({
            name: $('amName').value.trim(),
            role,
            password: pw,
            confirmPassword: pw
          })
        });
        renderRoster(res);
        $('amFeedback').textContent = role === 'Member'
          ? `Created ${res.member.name}! Share their one-time temp password ("${pw}") — it will work once and prompt them to set up a passkey.`
          : `Created Administrator ${res.member.name}!`;
        $('amFeedback').classList.remove('hidden');
        $('amName').value = '';
        $('amPassword').value = '';
      } catch (err) {
        $('amError').textContent = err.message;
        $('amError').classList.remove('hidden');
      }
    });

    // Roster actions (Reset / Disable / Delete)
    $('rosterList').addEventListener('click', async e => {
      const resetBtn = e.target.closest('button[data-roster-reset]');
      if (resetBtn) {
        const id = resetBtn.getAttribute('data-roster-reset');
        const name = resetBtn.getAttribute('data-roster-name');
        const role = resetBtn.getAttribute('data-roster-role');
        const suggested = randomTempPassword();
        const pw = prompt(
          role === 'Member'
            ? `Enter a new one-time temporary password for ${name} (min 12 chars). Their old passkeys will be cleared:`
            : `Enter a new password for Administrator ${name} (min 12 chars):`,
          suggested
        );
        if (!pw) return;
        try {
          const res = await api(`/api/auth/members/${id}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ password: pw, confirmPassword: pw })
          });
          renderRoster(res);
          $('amFeedback').textContent = `Updated sign-in for ${name}. New password: ${pw}`;
          $('amFeedback').classList.remove('hidden');
        } catch (err) {
          alert(err.message);
        }
        return;
      }

      const toggleBtn = e.target.closest('button[data-roster-toggle]');
      if (toggleBtn) {
        const id = toggleBtn.getAttribute('data-roster-toggle');
        const currentlyActive = toggleBtn.getAttribute('data-roster-active') === '1';
        try {
          const res = await api(`/api/auth/members/${id}/active`, {
            method: 'POST',
            body: JSON.stringify({ active: !currentlyActive })
          });
          renderRoster(res);
        } catch (err) {
          alert(err.message);
        }
        return;
      }

      const delBtn = e.target.closest('button[data-roster-delete]');
      if (delBtn) {
        const id = delBtn.getAttribute('data-roster-delete');
        const name = delBtn.getAttribute('data-roster-name');
        if (!confirm(`Remove ${name}? They will no longer be able to sign in.`)) return;
        try {
          const res = await api(`/api/auth/members/${id}`, { method: 'DELETE' });
          renderRoster(res);
        } catch (err) {
          alert(err.message);
        }
      }
    });
  }

  window.YosemiteAuth = {
    boot(onAuthenticated) {
      onReadyCallback = onAuthenticated;
      bindAuthEvents();
      checkAuthStatus().catch(err => {
        console.error('Auth boot error:', err);
      });
    }
  };
})();
