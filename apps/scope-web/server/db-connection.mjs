// A client must be acquired before any transaction or domain query starts.
// If the caller times out in the pool queue, a late client is released unused.
export async function acquireConnection(pool, timeoutMs = 3000) {
  if (!pool || typeof pool.connect !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 3000) throw new TypeError('database_connection_configuration');
  let expired = false, timer;
  const pending = Promise.resolve().then(() => pool.connect()).then(client => {
    if (expired) { client.release(); return null; }
    return client;
  });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(Error('database_connection_timeout')); }, timeoutMs);
  });
  try { return await Promise.race([pending, deadline]); }
  finally { clearTimeout(timer); }
}
