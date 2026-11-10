export const validPayPalSubject=value=>typeof value==='string'&&/^[!-~]{1,512}$/.test(value);
export const validPayPalPayer=value=>typeof value==='string'&&/^[A-Z0-9]{13}$/.test(value);

// Only the installed SDK's verified sandbox UserInfo hook calls this. A browser
// cannot select this identity or supply a payer ID through an application route.
export async function bindPayPalUserInfo({pool,profile,canEnroll}){
  if(profile?.email_verified!==true||!validPayPalSubject(profile.user_id)||!validPayPalPayer(profile.payer_id))return false;
  try{
    const existing=(await pool.query('SELECT payer_id FROM scope_identity.paypal_payer_links WHERE provider_subject=$1',[profile.user_id])).rows;
    if(existing.length)return existing.length===1&&existing[0].payer_id===profile.payer_id;
    if(canEnroll()!==true)return false;
    await pool.query('INSERT INTO scope_identity.paypal_payer_links(provider_subject,payer_id) VALUES($1,$2) ON CONFLICT(provider_subject) DO NOTHING',[profile.user_id,profile.payer_id]);
    const saved=(await pool.query('SELECT payer_id FROM scope_identity.paypal_payer_links WHERE provider_subject=$1',[profile.user_id])).rows;
    return saved.length===1&&saved[0].payer_id===profile.payer_id;
  }catch(error){
    if(error.code==='23505')return false;
    // Never pass a raw database/profile error into a provider logger.
    throw Error('paypal_identity_unavailable');
  }
}
