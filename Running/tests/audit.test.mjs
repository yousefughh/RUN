import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const cases = [];
const test = (name, run) => cases.push({ name, run });

test('signup delegates profile creation to the auth trigger and sends no role metadata', async () => {
  const app = await read('app.js');
  const signup = app.slice(app.indexOf("$('form-register')"), app.indexOf("/* تسجيل الدخول */"));
  assert.match(signup, /db\.auth\.signUp\(/);
  assert.match(signup, /options:\s*\{\s*data:\s*\{\s*display_name:\s*name,\s*phone\s*\}\s*\}/);
  assert.doesNotMatch(signup, /from\(['"]profiles['"]\)\.(?:insert|upsert)/);
  assert.doesNotMatch(signup, /role\s*:/);
});

test('phone is optional and validated when provided', async () => {
  const app = await read('app.js');
  assert.match(app, /const rawPhone = .*\|\| ''/);
  assert.match(app, /if \(rawPhone && !\/\^\\\+\?\[1-9\]\\d\{6,14\}\$\//);
});

test('migration creates one regular profile from the auth trigger and ignores role metadata', async () => {
  const sql = await read('supabase-migration.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)/i);
  assert.match(sql, /'member'\s*\) ON CONFLICT \(id\) DO NOTHING/i);
  assert.match(sql, /DROP TRIGGER IF EXISTS on_auth_user_created ON auth\.users/i);
  assert.match(sql, /CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth\.users/i);
  assert.doesNotMatch(sql, /raw_user_meta_data\s*->>\s*'role'/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS phone text/i);
  assert.match(sql, /CHECK \(role IN \('member', 'admin'\)\)/i);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE)\b/i);
});

test('regular users cannot set their own admin role through profile policies', async () => {
  const sql = await read('schema.sql');
  assert.match(sql, /WITH CHECK \(auth\.uid\(\) = id AND role = 'member'\)/i);
  assert.match(sql, /protect_profile_role\(\)/i);
  assert.match(sql, /Only an administrator can change account roles/i);
});

test('clip upload, review, and storage access are protected by RLS', async () => {
  const sql = await read('supabase-migration.sql');
  assert.match(sql, /status = 'approved' OR auth\.uid\(\) = user_id/i);
  assert.match(sql, /auth\.uid\(\) = user_id AND .*status = 'pending'/i);
  assert.match(sql, /Admins can review clips/i);
  assert.match(sql, /Users upload their own clips/i);
  assert.match(sql, /Admins manage clip files/i);
  assert.match(sql, /file_size_limit, allowed_mime_types/i);
});

test('clips and moderation controls are present in the page', async () => {
  const html = await read('index.html');
  for (const id of ['clip-upload-form', 'clip-file', 'clips-list', 'admin-pending-clips', 'admin-users', 'resend-confirmation-btn']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-page="clips"/);
  assert.match(html, /data-page="admin"/);
});

test('Vercel routes direct requests to the static application', async () => {
  const config = JSON.parse(await read('vercel.json'));
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', destination: '/index.html' }]);
});

let failures = 0;
for (const { name, run } of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
console.log(`${cases.length - failures}/${cases.length} checks passed`);
if (failures) throw new Error(`${failures} check(s) failed`);

