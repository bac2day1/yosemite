const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Isolate auth store into a temp directory for this test run
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yosemite-auth-test-'));
process.env.DATA_DIR = tmpDir;

const { registerAuthRoutes, requireAuth, hashPassword, verifyPassword } = require('../src/auth');

function createTestServer() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  app.get('/api/protected', requireAuth, (req, res) => {
    res.json({ ok: true, user: req.auth.member.name, role: req.auth.member.role });
  });
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('scrypt password hashing verifies matching password and rejects wrong password', () => {
  const hash = hashPassword('granite-falls-2027');
  assert.equal(verifyPassword('granite-falls-2027', hash), true);
  assert.equal(verifyPassword('wrong-password-123', hash), false);
});

test('first admin setup, unique passwords, and member mandatory passkey gate', async () => {
  const { server, baseUrl } = await createTestServer();
  try {
    // 1. Uninitialized state blocks protected routes
    const uninit = await fetch(`${baseUrl}/api/protected`);
    assert.equal(uninit.status, 401);

    // 2. First admin setup succeeds and sets session cookie
    const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Greg',
        password: 'admin-super-secret-2027',
        confirmPassword: 'admin-super-secret-2027'
      })
    });
    assert.equal(setupRes.status, 201);
    const adminCookie = setupRes.headers.get('set-cookie').split(';')[0];

    // 3. Admin can access protected routes
    const protAdmin = await fetch(`${baseUrl}/api/protected`, {
      headers: { Cookie: adminCookie }
    });
    assert.equal(protAdmin.status, 200);
    const protAdminBody = await protAdmin.json();
    assert.equal(protAdminBody.user, 'Greg');
    assert.equal(protAdminBody.role, 'Administrator');

    // 4. Duplicate password is rejected when creating a member
    const dupRes = await fetch(`${baseUrl}/api/auth/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        name: 'Sarah',
        role: 'Member',
        password: 'admin-super-secret-2027',
        confirmPassword: 'admin-super-secret-2027'
      })
    });
    assert.equal(dupRes.status, 400);

    // 5. Admin creates Member with unique one-time temporary password
    const addMemberRes = await fetch(`${baseUrl}/api/auth/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        name: 'Sarah',
        role: 'Member',
        password: 'merced-trail-temp-9999',
        confirmPassword: 'merced-trail-temp-9999'
      })
    });
    assert.equal(addMemberRes.status, 201);

    // 6. Member signs in with temp password -> flagged mustEnrollPasskey and blocked from app routes until passkey setup
    const memberLogin = await fetch(`${baseUrl}/api/auth/login/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'merced-trail-temp-9999' })
    });
    assert.equal(memberLogin.status, 200);
    const memberLoginData = await memberLogin.json();
    assert.equal(memberLoginData.mustEnrollPasskey, true);
    const memberCookie = memberLogin.headers.get('set-cookie').split(';')[0];

    const blockedRes = await fetch(`${baseUrl}/api/protected`, {
      headers: { Cookie: memberCookie }
    });
    assert.equal(blockedRes.status, 403);
    const blockedBody = await blockedRes.json();
    assert.equal(blockedBody.code, 'PASSKEY_SETUP_REQUIRED');

    // 7. Member CAN start passkey registration ceremony while in mustEnrollPasskey state
    const regOpts = await fetch(`${baseUrl}/api/auth/passkey/register/options`, {
      method: 'POST',
      headers: { Cookie: memberCookie }
    });
    assert.equal(regOpts.status, 200);
    const regData = await regOpts.json();
    assert.ok(regData.ceremonyId);
    assert.ok(regData.options.challenge);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
