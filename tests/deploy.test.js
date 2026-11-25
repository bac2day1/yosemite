const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// The container only ships browsers for the Playwright version in its base image tag.
// If the lockfile drifts from the image tag, every availability check fails inside Docker.
test('Dockerfile base image matches the locked Playwright version', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const tag = dockerfile.match(/^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-/m);
  assert.ok(tag, 'Dockerfile must start from the official Playwright image');

  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const locked = lock.packages['node_modules/playwright'].version;
  assert.equal(tag[1], locked, `Dockerfile uses Playwright ${tag[1]} but package-lock resolves ${locked}`);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.playwright, locked, 'package.json must pin Playwright to the exact locked version');
});
