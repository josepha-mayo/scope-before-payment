const sdkMessages=new Map([
 ['PayPal token exchange failed:','paypal_token_exchange_failed'],
 ['Failed to validate authorization code','oauth_code_exchange_failed'],
 ['Failed to fetch user info from PayPal:','paypal_user_info_fetch_failed'],
 ['Failed to fetch user info from PayPal','paypal_user_info_fetch_failed'],
 ['Failed to decode PayPal ID token:','paypal_id_token_invalid'],
 ['PayPal user info subject does not match ID token subject','paypal_id_token_subject_mismatch'],
 ['Unable to get user info','oauth_user_info_unavailable'],
 ['Unable to derive provider account identity','oauth_account_subject_invalid'],
 ['Failed to parse state','oauth_state_invalid'],
]);
const callbackErrors=new Set(['no_code','oauth_provider_not_found','issuer_missing','issuer_mismatch','invalid_code','nonce_binding_missing','unable_to_get_user_info','no_callback_url','unable_to_link_account','email_does_not_match','account_already_linked_to_different_user','email_not_found','email_not_verified','verified_paypal_identity_required','verified_github_email_required','state_not_found','state_mismatch','state_invalid','internal_server_error','access_denied']);
const providerCodes=new Set(['invalid_grant','invalid_client','invalid_scope','invalid_request','unauthorized_client','access_denied','state_security_mismatch','state_mismatch','state_invalid','state_not_found']);
const codes=new Set([...sdkMessages.values(),'paypal_identity_proof_bound','paypal_email_proof_missing','paypal_payer_proof_missing','paypal_subject_proof_missing','paypal_identity_binding_rejected','oauth_callback_success','oauth_callback_unclassified',...Array.from(callbackErrors,x=>'oauth_callback_'+x)]);

// Never serialize SDK messages, error objects, Request, URL, cookies or profiles.
// Only enumerated outcomes and numeric HTTP status can leave this adapter.
export function createAuthSignalWriter({write=line=>console.info(line)}={}){
 return event=>{try{
  if(!codes.has(event?.code))return;
  const value={kind:'scope_auth_outcome_v1',at:new Date().toISOString(),code:event.code};
  if(Number.isInteger(event.httpStatus)&&event.httpStatus>=200&&event.httpStatus<=599)value.httpStatus=event.httpStatus;
  if(providerCodes.has(event.providerCode))value.providerCode=event.providerCode;
  write(JSON.stringify(value));
 }catch{/* Observability must never change an authentication result. */}};
}
export function safeSdkLogger(signal=()=>{}){
 return {disabled:false,level:'warn',disableColors:true,log(_level,message,error){try{
  const code=sdkMessages.get(message);if(!code)return;
  const event={code};const status=error?.status??error?.statusCode;
  if(Number.isInteger(status)&&status>=400&&status<=599)event.httpStatus=status;
  for(const value of [error?.code,error?.error,error?.error?.error,error?.error?.name])if(providerCodes.has(value)){event.providerCode=value;break;}
  signal(event);
 }catch{/* Do not fall back to printing the SDK arguments. */}}};
}
export function callbackSignal(response,origin){
 try{
  const target=new URL(response.headers.get('location'));
  if(target.origin!==origin||target.pathname!=='/')return {code:'oauth_callback_unclassified'};
  const error=target.searchParams.get('error');
  if(callbackErrors.has(error))return {code:'oauth_callback_'+error};
  if(!error&&target.searchParams.get('signin')==='complete')return {code:'oauth_callback_success'};
 }catch{}
 return {code:'oauth_callback_unclassified'};
}
