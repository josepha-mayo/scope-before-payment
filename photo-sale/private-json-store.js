'use strict';

// Private local JSON engine only. Wrappers own schema, purpose and retention.
// No credential handling, provider dispatch, or application authorization.
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function nativeLock(fd) {
  return spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'],
    { stdio: ['ignore', 'ignore', 'ignore', fd], env: { LANG: 'C' }, timeout: 5000, killSignal: 'SIGKILL' });
}

async function openPrivateJsonStore(directory, validatePayload, options, io = fs, lockRunner = nativeLock) {
  if (!options || !['scene_store', 'payment_store'].includes(options.errorPrefix)) throw new Error('private_store_configuration');
  const stopped = code => Object.assign(new Error(`${options.errorPrefix}_${code}`), { code: `${options.errorPrefix}_${code}` });
  const { fileName, lockName, tempPrefix, format, maxBytes, legacyLockName = null } = options;
  if (!/^[a-z][a-z0-9-]{0,50}\.json$/.test(fileName) || !/^[a-z][a-z0-9-]{0,50}\.lock$/.test(lockName) ||
      !/^[a-z][a-z0-9-]{0,30}$/.test(tempPrefix) || !/^[a-z0-9-]{1,80}$/.test(format) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 12 * 1024 * 1024 ||
      legacyLockName !== null && !/^[a-z][a-z0-9-]{0,50}\.lock$/.test(legacyLockName)) throw stopped('configuration');
  function privateOwned(stat, directory = false) {
    if (!(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o077) !== 0 ||
        typeof process.getuid !== 'function' || stat.uid !== process.getuid()) throw stopped('not_private_owned');
  }

  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof validatePayload !== 'function') throw stopped('configuration');
  // Do not chmod existing paths or follow a final directory/file symlink.
  try { await io.mkdir(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const dirStat = await io.lstat(directory); privateOwned(dirStat, true);
  const real = await io.realpath(directory);
  if (real !== path.resolve(directory)) throw stopped('symlink_path');
  if (process.platform !== 'linux') throw stopped('native_lock_unavailable');
  // Restrict this demo's locking/durability claim to known local Linux filesystems.
  const localTypes = new Set([0xef53, 0x01021994, 0x794c7630, 0x58465342, 0x9123683e, 0x858458f6]);
  if (!localTypes.has(Number((await io.statfs(directory)).type))) throw stopped('local_filesystem_required');
  // Never bypass an older create-exclusive writer which did not use advisory locks.
  if (legacyLockName) {
    try { await io.lstat(path.join(directory, legacyLockName)); throw stopped('legacy_lock_requires_offline_recovery'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const dirHandle = await io.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const lockPath = path.join(directory, lockName);
  let lock, lockIdentity;
  try {
    lock = await io.open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    lockIdentity = await lock.stat(); privateOwned(lockIdentity);
    if (lockIdentity.nlink !== 1) throw stopped('lock_identity_changed');
    const result = lockRunner(lock.fd);
    if (result.error || result.signal || result.status !== 0) throw stopped(result.status === 73 ? 'writer_locked' : 'native_lock_unavailable');
    // flock's short helper inherits a duplicate of THIS open file description.
    // Its successful exit is expected; our parent descriptor retains ownership
    // until close/process death. No resident helper, PID guesses or lock unlink.
    const named = await io.lstat(lockPath);
    if (named.ino !== lockIdentity.ino || named.dev !== lockIdentity.dev) throw stopped('lock_identity_changed');
    await lock.sync(); await dirHandle.sync();
  } catch (e) { if (lock) await lock.close(); await dirHandle.close(); throw e; }
  let closed = false, failed = false, writing = false;
  const filePath = path.join(directory, fileName);
  function encode(value) {
    const payload = validatePayload(value);
    const serialized = JSON.stringify(payload);
    const bytes = Buffer.from(JSON.stringify({ format, payload, sha256: hash(serialized) }) + '\n');
    if (bytes.length > maxBytes) throw stopped('too_large');
    return { payload, bytes };
  }
  async function assertDirectory() {
    const s = await io.lstat(directory); privateOwned(s, true);
    if (s.ino !== dirStat.ino || s.dev !== dirStat.dev || await io.realpath(directory) !== real) throw stopped('directory_changed');
    const held = await lock.stat(), named = await io.lstat(lockPath); privateOwned(named);
    if (held.ino !== lockIdentity.ino || held.dev !== lockIdentity.dev || named.ino !== held.ino || named.dev !== held.dev || named.nlink !== 1) throw stopped('lock_identity_changed');
  }
  async function load() {
    if (closed || failed || writing) throw stopped('unavailable');
    await assertDirectory();
    let h;
    try { h = await io.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if (e.code === 'ENOENT') return null; throw stopped('read_failed'); }
    try {
      const stat = await h.stat(); privateOwned(stat);
      if (stat.size < 1 || stat.size > maxBytes) throw stopped('too_large');
      const raw = await h.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(raw) > maxBytes) throw stopped('too_large');
      let envelope;
      try { envelope = JSON.parse(raw); } catch { throw stopped('corrupt'); }
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'format,payload,sha256' || envelope.format !== format ||
          typeof envelope.sha256 !== 'string' || envelope.sha256 !== hash(JSON.stringify(envelope.payload))) throw stopped('corrupt');
      return encode(envelope.payload).payload;
    } finally { await h.close(); }
  }
  async function save(value) {
    if (closed || failed) throw stopped('unavailable');
    if (writing) throw stopped('write_busy');
    const { bytes } = encode(value); // Reject unsupported facts before any write.
    writing = true;
    let temp, h, renamed = false;
    try {
      await assertDirectory();
      // Existing payload must remain private; rename must not hide a bad path.
      try { privateOwned(await io.lstat(filePath)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      temp = path.join(directory, `${tempPrefix}-${crypto.randomUUID()}.tmp`);
      h = await io.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await h.writeFile(bytes); await h.sync(); await h.close(); h = null;
      await assertDirectory();
      await io.rename(temp, filePath); renamed = true;
      await dirHandle.sync(); // Success is reported only after directory durability.
    } catch {
      failed = true; // Even a post-rename fsync failure must not be reported unpaid/unsaved.
      throw stopped(renamed ? 'commit_unconfirmed' : 'save_failed');
    } finally {
      if (h) await h.close().catch(() => {});
      if (temp && !renamed) await io.unlink(temp).catch(() => {});
      writing = false;
    }
  }
  async function close() {
    if (closed) return;
    if (writing) throw stopped('write_busy');
    closed = true;
    try { await lock.close(); } finally { await dirHandle.close(); } // Never unlink the stable advisory inode.
  }
  return { load, save, close };
}

module.exports = { openPrivateJsonStore };
