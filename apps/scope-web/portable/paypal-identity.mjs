export const validPayPalSubject=value=>typeof value==='string'&&/^[!-~]{1,512}$/.test(value);
export const validPayPalPayer=value=>typeof value==='string'&&/^[A-Z0-9]{13}$/.test(value);

const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)&&!/[\u0000-\u001f\u007f]/.test(value);
// The installed SDK requests paypalv1.1, whose primary email lives in emails[]
// with boolean primary/confirmed flags. OIDC uses email/email_verified instead.
// This hook only receives SDK-fetched UserInfo, never caller-supplied profiles.
export function normalizePayPalEmail(profile){
 const failed={email:undefined,email_verified:false};
 if(!profile||typeof profile!=='object'||Array.isArray(profile))return failed;
 const oidc=Object.hasOwn(profile,'email')||Object.hasOwn(profile,'email_verified');
 let legacy;
 if(Object.hasOwn(profile,'emails')){
  if(!Array.isArray(profile.emails)||profile.emails.length<1||profile.emails.length>20)return failed;
  if(profile.emails.some(e=>!e||typeof e!=='object'||Array.isArray(e)||typeof e.primary!=='boolean'||typeof e.confirmed!=='boolean'))return failed;
  const primary=profile.emails.filter(e=>e.primary===true);
  if(primary.length!==1||!validEmail(primary[0].value))return failed;
  legacy={email:primary[0].value,email_verified:primary[0].confirmed===true};
 }
 if(oidc){
  if(!validEmail(profile.email)||typeof profile.email_verified!=='boolean')return failed;
  if(legacy&&(legacy.email.toLowerCase()!==profile.email.toLowerCase()||legacy.email_verified!==profile.email_verified))return failed;
  return {email:profile.email,email_verified:profile.email_verified===true};
 }
 return legacy??failed;
}

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
