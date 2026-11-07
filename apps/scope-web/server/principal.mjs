const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const confirmed = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hasEmail = value => typeof value === 'string' && value.length <= 254 && !/[\s\u0000-\u001f\u007f]/u.test(value) && value.split('@').length === 2;

// All dependencies are server-owned SDK methods. Profile lookup never accepts a
// request-body ID, never authenticates someone by itself and never mutates users.
export function createPrincipalReader({ getUser, getSettings, getProfile }) {
  if ([getUser, getSettings, getProfile].some(method => typeof method !== 'function')) throw new TypeError('identity_reader_configuration');
  return async () => {
    const signedIn = await getUser();
    if (!signedIn || !uuid(signedIn.id)) return null;
    let profile = signedIn;
    if (!confirmed(signedIn.confirmedAt)) {
      // The SDK's verified-claims fallback has no confirmation timestamp.
      // Use its documented server-only profile reader for this signed-in ID.
      try { profile = await getProfile(signedIn.id); }
      catch { throw Error('identity_profile_unavailable'); }
      if (!profile || profile.id !== signedIn.id) throw Error('identity_profile_mismatch');
    }
    let emailVerified = false;
    if (confirmed(profile.confirmedAt) && hasEmail(profile.email)) {
      // Auto-confirmed accounts do not prove ownership. Unavailable settings
      // must keep invitation joining closed, while known members retain access.
      try { emailVerified = (await getSettings()).autoconfirm === false; } catch { /* no ownership proof */ }
    }
    return { id: signedIn.id, email: profile.email, name: profile.name ?? signedIn.name, confirmedAt: profile.confirmedAt, emailVerified };
  };
}
