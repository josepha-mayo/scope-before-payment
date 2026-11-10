import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePayPalEmail} from '../paypal-identity.mjs';
const address='owned-buyer@invented.example';
const legacy=()=>({emails:[{value:'secondary@invented.example',primary:false,confirmed:true},{value:address,primary:true,confirmed:true}]});
test('paypalv1.1 selects exactly one confirmed primary email without changing the provider subject',()=>{
 const profile={...legacy(),user_id:'opaque-owned-subject',payer_id:'123456789ABCD'};
 const before=JSON.stringify(profile);assert.deepEqual(normalizePayPalEmail(profile),{email:address,email_verified:true});assert.equal(JSON.stringify(profile),before);
});
test('OIDC and legacy formats retain strict boolean proof and never use account verification as email proof',()=>{
 assert.deepEqual(normalizePayPalEmail({email:address,email_verified:true}),{email:address,email_verified:true});
 assert.deepEqual(normalizePayPalEmail({email:address,email_verified:false}),{email:address,email_verified:false});
 assert.deepEqual(normalizePayPalEmail({emails:[{value:address,primary:true,confirmed:false}],verified_account:true}),{email:address,email_verified:false});
 for(const profile of [{email:address,email_verified:'true'},{emails:[{value:address,primary:true,confirmed:'true'}]},{emails:[{value:address,primary:'true',confirmed:true}]},{email:address,verified_account:true}])assert.equal(normalizePayPalEmail(profile).email_verified,false);
});
test('ambiguous, malformed and conflicting primary claims fail closed',()=>{
 for(const profile of [null,[],{}, {emails:[]},{emails:'invalid'},{emails:[{value:address,primary:false,confirmed:true}]},{emails:[{value:address,primary:true,confirmed:true},{value:'other@invented.example',primary:true,confirmed:true}]},{emails:[{value:'bad\n@invented.example',primary:true,confirmed:true}]},{...legacy(),email:'different@invented.example',email_verified:true},{...legacy(),email:address,email_verified:false},{emails:Array.from({length:21},()=>({value:address,primary:true,confirmed:true}))}]){
  assert.deepEqual(normalizePayPalEmail(profile),{email:undefined,email_verified:false});
 }
 assert.deepEqual(normalizePayPalEmail({...legacy(),email:address.toUpperCase(),email_verified:true}),{email:address.toUpperCase(),email_verified:true});
});
