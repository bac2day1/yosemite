const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { DATA_DIR } = require('./config');

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_COOKIE = 'yosemite_session';
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;

const pendingChallenges = new Map(); // ceremonyId -> { challenge, type, memberId, rpID, origin, expiresAt }
const failedAttempts = new Map(); // clientKey -> [timestamps]

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyStore() {
  return {
    members: [],
    sessions: [],
    audit: []
  };
}

function loadAuthStore() {
  ensureDir();
  if (!fs.existsSync(AUTH_FILE)) {
    return emptyStore();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return {
      members: Array.isArray(raw.members) ? raw.members : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      audit: Array.isArray(raw.audit) ? raw.audit : []
    };
  } catch {
    return emptyStore();
  }
}

function saveAuthStore(store) {
  ensureDir();
  const now = Date.now();
  store.sessions = store.sessions.filter(s => new Date(s.expiresAt).getTime() > now);
  store.audit = store.audit.slice(0, 150);
  fs.writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !password) return false;
  const parts = String(storedHash).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getRequestOriginAndRpId(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3847').split(',')[0].trim();
  const hostname = hostHeader.split(':')[0].toLowerCase();
  const origin = `${proto}://${hostHeader}`;
  return { origin, rpID: hostname, isHttps: proto === 'https' };
}

function getClientKey(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'local';
}

function checkRateLimit(clientKey) {
  const now = Date.now();
  const list = (failedAttempts.get(clientKey) || []).filter(t => now - t < RATE_WINDOW_MS);
  failedAttempts.set(clientKey, list);
  if (list.length >= MAX_FAILED_ATTEMPTS) {
    return false;
  }
  return true;
}

function recordFailure(clientKey) {
  const now = Date.now();
  const list = (failedAttempts.get(clientKey) || []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  failedAttempts.set(clientKey, list);
}

function recordAudit(store, action, actorName, detail = '') {
  store.audit.unshift({
    id: 'aud-' + crypto.randomBytes(4).toString('hex'),
    timestamp: new Date().toISOString(),
    action,
    actorName: actorName || 'System',
    detail
  });
}

function cleanName(raw) {
  const name = String(raw || '').trim();
  if (name.length < 2 || name.length > 60) {
    throw new Error('Name must be between 2 and 60 characters.');
  }
  return name;
}

function validateNewPassword(password, confirm, store, ignoreMemberId = null) {
  const pw = String(password || '');
  const cf = String(confirm ?? password ?? '');
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Password is too long.');
  }
  if (pw !== cf) {
    throw new Error('The two passwords do not match.');
  }
  for (const m of store.members) {
    if (m.id === ignoreMemberId) continue;
    if (m.passwordEnabled && m.passwordHash && verifyPassword(pw, m.passwordHash)) {
      throw new Error('That password is already in use by another account. Choose a unique password.');
    }
  }
  return pw;
}

function createSession(store, member, req, res) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  store.sessions.push({
    tokenHash: hashToken(rawToken),
    memberId: member.id,
    createdAt: new Date(now).toISOString(),
    expiresAt
  });
  member.lastSignInAt = new Date(now).toISOString();

  const { isHttps } = getRequestOriginAndRpId(req);
  const cookieParts = [
    `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (isHttps) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
  return rawToken;
}

function clearSessionCookie(req, res) {
  const { isHttps } = getRequestOriginAndRpId(req);
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function revokeMemberSessions(store, memberId) {
  store.sessions = store.sessions.filter(s => s.memberId !== memberId);
}

function getAuthenticatedMember(req, store = null) {
  const s = store || loadAuthStore();
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const th = hashToken(token);
  const now = Date.now();
  const session = s.sessions.find(sess => sess.tokenHash === th && new Date(sess.expiresAt).getTime() > now);
  if (!session) return null;
  const member = s.members.find(m => m.id === session.memberId && m.active);
  if (!member) return null;
  return { member, session, store: s };
}

function sanitizeMember(m) {
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    active: m.active,
    passwordEnabled: Boolean(m.passwordEnabled && m.passwordHash),
    passwordResetRequired: Boolean(m.passwordResetRequired),
    passkeyCount: (m.passkeys || []).length,
    passkeys: (m.passkeys || []).map(p => ({
      id: p.id,
      label: p.label,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt || null
    })),
    createdAt: m.createdAt,
    lastSignInAt: m.lastSignInAt || null
  };
}

function pruneChallenges() {
  const now = Date.now();
  for (const [k, v] of pendingChallenges.entries()) {
    if (v.expiresAt <= now) pendingChallenges.delete(k);
  }
}

/**
 * Auth middleware: protects all app routes when at least one account exists,
 * and blocks accounts that still need to finish mandatory passkey enrollment.
 */
function requireAuth(req, res, next) {
  const store = loadAuthStore();
  if (store.members.length === 0) {
    return res.status(401).json({ error: 'Admin account setup required.', code: 'SETUP_REQUIRED' });
  }
  const auth = getAuthenticatedMember(req, store);
  if (!auth) {
    return res.status(401).json({ error: 'Please sign in to continue.', code: 'UNAUTHORIZED' });
  }
  if (auth.member.passwordResetRequired) {
    return res.status(403).json({
      error: 'Please finish setting up your passkey before continuing.',
      code: 'PASSKEY_SETUP_REQUIRED'
    });
  }
  req.auth = auth;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.auth.member.role !== 'Administrator') {
      return res.status(403).json({ error: 'Administrator access required.' });
    }
    next();
  });
}

function registerAuthRoutes(app) {
  // Public status check for frontend boot
  app.get('/api/auth/status', (req, res) => {
    const store = loadAuthStore();
    const initialized = store.members.length > 0;
    const hasPasskeys = store.members.some(m => m.active && (m.passkeys || []).length > 0);
    const auth = initialized ? getAuthenticatedMember(req, store) : null;
    res.json({
      initialized,
      hasPasskeys,
      authenticated: Boolean(auth),
      mustEnrollPasskey: Boolean(auth?.member?.passwordResetRequired),
      member: auth ? sanitizeMember(auth.member) : null,
      minPasswordLength: MIN_PASSWORD_LENGTH
    });
  });

  // First-time Admin setup (only works when zero members exist)
  app.post('/api/auth/setup', (req, res) => {
    const store = loadAuthStore();
    if (store.members.length > 0) {
      return res.status(409).json({ error: 'An admin account has already been set up.' });
    }
    try {
      const name = cleanName(req.body?.name);
      const password = validateNewPassword(req.body?.password, req.body?.confirmPassword, store);
      const member = {
        id: 'usr-' + crypto.randomBytes(6).toString('hex'),
        name,
        role: 'Administrator',
        active: true,
        passwordHash: hashPassword(password),
        passwordEnabled: true,
        passwordResetRequired: false,
        passkeys: [],
        createdAt: new Date().toISOString(),
        lastSignInAt: null
      };
      store.members.push(member);
      createSession(store, member, req, res);
      recordAudit(store, 'first-admin-created', member.name, 'Initial administrator created');
      saveAuthStore(store);
      res.status(201).json({ member: sanitizeMember(member) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Sign in with Password (password-only, unique across accounts, matching cs-watch)
  app.post('/api/auth/login/password', (req, res) => {
    const clientKey = getClientKey(req);
    if (!checkRateLimit(clientKey)) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Wait 15 minutes and try again.' });
    }
    const password = String(req.body?.password || '');
    if (!password || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: 'Enter your password.' });
    }

    const store = loadAuthStore();
    const matches = store.members.filter(m => m.active && m.passwordEnabled && m.passwordHash && verifyPassword(password, m.passwordHash));
    if (matches.length !== 1) {
      recordFailure(clientKey);
      recordAudit(store, 'sign-in-failed', 'Unknown', 'Password rejected');
      saveAuthStore(store);
      return res.status(401).json({ error: 'That password was not accepted.' });
    }

    const member = matches[0];
    createSession(store, member, req, res);
    recordAudit(
      store,
      'signed-in',
      member.name,
      member.passwordResetRequired ? 'Signed in with one-time temporary password (passkey setup required)' : 'Signed in with password'
    );
    saveAuthStore(store);
    res.json({
      member: sanitizeMember(member),
      mustEnrollPasskey: Boolean(member.passwordResetRequired)
    });
  });

  // Begin Passkey sign-in
  app.post('/api/auth/login/passkey/options', async (req, res) => {
    pruneChallenges();
    const { origin, rpID } = getRequestOriginAndRpId(req);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred'
    });
    const ceremonyId = crypto.randomBytes(16).toString('hex');
    pendingChallenges.set(ceremonyId, {
      challenge: options.challenge,
      type: 'authentication',
      rpID,
      origin,
      expiresAt: Date.now() + CHALLENGE_TTL_MS
    });
    res.json({ ceremonyId, options });
  });

  // Finish Passkey sign-in
  app.post('/api/auth/login/passkey/verify', async (req, res) => {
    const clientKey = getClientKey(req);
    if (!checkRateLimit(clientKey)) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Wait 15 minutes and try again.' });
    }
    pruneChallenges();
    const { ceremonyId, response } = req.body || {};
    const pending = pendingChallenges.get(ceremonyId);
    if (!pending || pending.type !== 'authentication') {
      return res.status(400).json({ error: 'Passkey sign-in timed out. Please try again.' });
    }
    pendingChallenges.delete(ceremonyId);

    const store = loadAuthStore();
    const credId = response?.id;
    let matchedMember = null;
    let matchedKey = null;
    for (const m of store.members) {
      if (!m.active) continue;
      const pk = (m.passkeys || []).find(k => k.id === credId);
      if (pk) {
        matchedMember = m;
        matchedKey = pk;
        break;
      }
    }

    if (!matchedMember || !matchedKey) {
      recordFailure(clientKey);
      recordAudit(store, 'sign-in-failed', 'Unknown', 'Passkey not recognized');
      saveAuthStore(store);
      return res.status(401).json({ error: 'That passkey was not accepted.' });
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        credential: {
          id: matchedKey.id,
          publicKey: Buffer.from(matchedKey.publicKey, 'base64url'),
          counter: matchedKey.counter || 0,
          transports: matchedKey.transports || []
        },
        requireUserVerification: false
      });

      if (!verification.verified) {
        throw new Error('Verification failed');
      }

      matchedKey.counter = verification.authenticationInfo.newCounter;
      matchedKey.lastUsedAt = new Date().toISOString();
      createSession(store, matchedMember, req, res);
      recordAudit(store, 'signed-in', matchedMember.name, `Signed in with passkey (${matchedKey.label})`);
      saveAuthStore(store);

      res.json({
        member: sanitizeMember(matchedMember),
        mustEnrollPasskey: Boolean(matchedMember.passwordResetRequired)
      });
    } catch {
      recordFailure(clientKey);
      recordAudit(store, 'sign-in-failed', matchedMember.name, 'Passkey verification failed');
      saveAuthStore(store);
      res.status(401).json({ error: 'That passkey was not accepted.' });
    }
  });

  // Sign out
  app.post('/api/auth/logout', (req, res) => {
    const store = loadAuthStore();
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const th = hashToken(token);
      const auth = getAuthenticatedMember(req, store);
      store.sessions = store.sessions.filter(s => s.tokenHash !== th);
      if (auth) {
        recordAudit(store, 'signed-out', auth.member.name);
      }
      saveAuthStore(store);
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // Begin Passkey registration (allowed for any signed-in user, including mustEnrollPasskey!)
  app.post('/api/auth/passkey/register/options', async (req, res) => {
    const auth = getAuthenticatedMember(req);
    if (!auth) {
      return res.status(401).json({ error: 'Sign in first to register a passkey.' });
    }
    pruneChallenges();
    const { origin, rpID } = getRequestOriginAndRpId(req);
    const member = auth.member;
    const options = await generateRegistrationOptions({
      rpName: 'Yosemite Valley Lodging Watcher',
      rpID,
      userID: Buffer.from(member.id, 'utf8'),
      userName: member.name,
      userDisplayName: member.name,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'preferred'
      },
      excludeCredentials: (member.passkeys || []).map(k => ({
        id: k.id,
        transports: k.transports || []
      }))
    });

    const ceremonyId = crypto.randomBytes(16).toString('hex');
    pendingChallenges.set(ceremonyId, {
      challenge: options.challenge,
      type: 'registration',
      memberId: member.id,
      rpID,
      origin,
      expiresAt: Date.now() + CHALLENGE_TTL_MS
    });
    res.json({ ceremonyId, options });
  });

  // Complete Passkey registration (automatically retires temporary password for Members!)
  app.post('/api/auth/passkey/register/verify', async (req, res) => {
    const auth = getAuthenticatedMember(req);
    if (!auth) {
      return res.status(401).json({ error: 'Sign in first to register a passkey.' });
    }
    pruneChallenges();
    const { ceremonyId, response, label } = req.body || {};
    const pending = pendingChallenges.get(ceremonyId);
    if (!pending || pending.type !== 'registration' || pending.memberId !== auth.member.id) {
      return res.status(400).json({ error: 'Passkey setup timed out. Please start again.' });
    }
    pendingChallenges.delete(ceremonyId);

    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
        requireUserVerification: false
      });

      if (!verification.verified || !verification.registrationInfo) {
        throw new Error('Could not verify passkey.');
      }

      const { credential } = verification.registrationInfo;
      const store = auth.store;
      const member = store.members.find(m => m.id === auth.member.id);
      if (!member) {
        return res.status(404).json({ error: 'Account not found.' });
      }

      // Ensure credential isn't already registered
      const duplicate = store.members.some(m => (m.passkeys || []).some(k => k.id === credential.id));
      if (duplicate) {
        return res.status(409).json({ error: 'That passkey is already registered.' });
      }

      const keyLabel = String(label || '').trim().slice(0, 60) || `Passkey ${(member.passkeys || []).length + 1}`;
      member.passkeys = member.passkeys || [];
      member.passkeys.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter || 0,
        transports: credential.transports || [],
        label: keyLabel,
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      });

      // Retire one-time temporary password for Members (or anyone flagged passwordResetRequired)
      // Administrators keep their password as a backup!
      const retiredPassword = member.role !== 'Administrator' || member.passwordResetRequired;
      if (retiredPassword) {
        member.passwordHash = null;
        member.passwordEnabled = false;
        member.passwordResetRequired = false;
      }

      recordAudit(
        store,
        'passkey-added',
        member.name,
        retiredPassword
          ? `Passkey "${keyLabel}" added; temporary password retired`
          : `Passkey "${keyLabel}" added; admin password kept as backup`
      );
      saveAuthStore(store);
      res.json({
        ok: true,
        retiredPassword,
        member: sanitizeMember(member)
      });
    } catch (err) {
      res.status(400).json({ error: err.message || 'That passkey could not be verified. Please try again.' });
    }
  });

  // Remove own passkey (prevent removing last way to sign in)
  app.delete('/api/auth/passkey/:credentialId', requireAuth, (req, res) => {
    const store = req.auth.store;
    const member = store.members.find(m => m.id === req.auth.member.id);
    const credId = req.params.credentialId;
    const existing = (member.passkeys || []).find(k => k.id === credId);
    if (!existing) {
      return res.status(404).json({ error: 'Passkey not found.' });
    }
    const remainingKeys = member.passkeys.length - 1;
    if (remainingKeys === 0 && !(member.passwordEnabled && member.passwordHash)) {
      return res.status(409).json({ error: 'That is your only way to sign in. Add another passkey first.' });
    }
    member.passkeys = member.passkeys.filter(k => k.id !== credId);
    recordAudit(store, 'passkey-removed', member.name, `Removed passkey "${existing.label}"`);
    saveAuthStore(store);
    res.json({ member: sanitizeMember(member) });
  });

  // --- Admin Roster Management ---
  app.get('/api/auth/roster', requireAdmin, (req, res) => {
    const store = req.auth.store;
    res.json({
      members: store.members.map(sanitizeMember),
      audit: store.audit.slice(0, 40),
      minPasswordLength: MIN_PASSWORD_LENGTH
    });
  });

  // Create new account (Member gets one-time temp password -> mandatory passkey; Admin keeps password + passkey)
  app.post('/api/auth/members', requireAdmin, (req, res) => {
    const store = req.auth.store;
    try {
      const name = cleanName(req.body?.name);
      const role = req.body?.role === 'Administrator' ? 'Administrator' : 'Member';
      const password = validateNewPassword(req.body?.password, req.body?.confirmPassword, store);
      const requirePasskey = role === 'Member' ? true : Boolean(req.body?.requirePasskey);

      const member = {
        id: 'usr-' + crypto.randomBytes(6).toString('hex'),
        name,
        role,
        active: true,
        passwordHash: hashPassword(password),
        passwordEnabled: true,
        passwordResetRequired: requirePasskey,
        passkeys: [],
        createdAt: new Date().toISOString(),
        lastSignInAt: null
      };
      store.members.push(member);
      recordAudit(
        store,
        'member-added',
        req.auth.member.name,
        `Added ${member.name} (${member.role}${requirePasskey ? ', one-time temp password → passkey' : ''})`
      );
      saveAuthStore(store);
      res.status(201).json({
        member: sanitizeMember(member),
        members: store.members.map(sanitizeMember),
        audit: store.audit.slice(0, 40)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Reset a member's sign-in (new one-time temp password, wipes old passkeys for Member) or change Admin password
  app.post('/api/auth/members/:id/reset-password', requireAdmin, (req, res) => {
    const store = req.auth.store;
    const target = store.members.find(m => m.id === req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    try {
      const password = validateNewPassword(req.body?.password, req.body?.confirmPassword, store, target.id);
      target.passwordHash = hashPassword(password);
      target.passwordEnabled = true;
      if (target.role === 'Member' || req.body?.requirePasskey) {
        target.passkeys = [];
        target.passwordResetRequired = true;
      }
      revokeMemberSessions(store, target.id);
      recordAudit(
        store,
        'password-changed',
        req.auth.member.name,
        target.passwordResetRequired
          ? `Reset ${target.name} with one-time temp password (old passkeys cleared)`
          : `Updated password for ${target.name}`
      );
      saveAuthStore(store);
      res.json({
        members: store.members.map(sanitizeMember),
        audit: store.audit.slice(0, 40)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Enable / disable member
  app.post('/api/auth/members/:id/active', requireAdmin, (req, res) => {
    const store = req.auth.store;
    const target = store.members.find(m => m.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    const nextActive = Boolean(req.body?.active);
    if (!nextActive && target.role === 'Administrator') {
      const otherActiveAdmins = store.members.filter(m => m.id !== target.id && m.role === 'Administrator' && m.active);
      if (otherActiveAdmins.length === 0) {
        return res.status(409).json({ error: 'You cannot disable the last active Administrator.' });
      }
    }
    target.active = nextActive;
    if (!nextActive) revokeMemberSessions(store, target.id);
    recordAudit(store, nextActive ? 'member-enabled' : 'member-disabled', req.auth.member.name, target.name);
    saveAuthStore(store);
    res.json({
      members: store.members.map(sanitizeMember),
      audit: store.audit.slice(0, 40)
    });
  });

  // Delete member
  app.delete('/api/auth/members/:id', requireAdmin, (req, res) => {
    const store = req.auth.store;
    const target = store.members.find(m => m.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    if (target.role === 'Administrator') {
      const otherAdmins = store.members.filter(m => m.id !== target.id && m.role === 'Administrator' && m.active);
      if (otherAdmins.length === 0) {
        return res.status(409).json({ error: 'You cannot remove the last active Administrator.' });
      }
    }
    store.members = store.members.filter(m => m.id !== target.id);
    revokeMemberSessions(store, target.id);
    recordAudit(store, 'member-removed', req.auth.member.name, target.name);
    saveAuthStore(store);
    res.json({
      members: store.members.map(sanitizeMember),
      audit: store.audit.slice(0, 40)
    });
  });
}

module.exports = {
  registerAuthRoutes,
  requireAuth,
  requireAdmin,
  loadAuthStore,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH
};
