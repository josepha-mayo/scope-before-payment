import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {crc32} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Ephemeral authored key/certificate. No key is written to source; the owned temporary key file is removed.
// Production verification still parses an actual X509 certificate; no test key
// reader, authentication bypass or fixture certificate is in the runtime entry.
export function signedWebhookFixture(){
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const binary=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
  const directory=mkdtempSync(join(tmpdir(),'scope-webhook-key-')),file=join(directory,'authored-key.pem');let cert;
  try{writeFileSync(file,keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});cert=execFileSync(binary,['req','-new','-x509','-key',file,'-subj','/CN=authored-scope-webhook','-days','1'],{stdio:['ignore','pipe','pipe'],windowsHide:true}).toString('utf8');}
  finally{unlinkSync(file);rmdirSync(directory);}

  const env={SCOPE_PAYPAL_WEBHOOK_ENABLED:'true',SCOPE_PAYPAL_WEBHOOK_ID:'AUTHOREDWEBHOOK123',SCOPE_PAYPAL_WEBHOOK_MERCHANT_ID:'Y53RSV36EJCGG'};
  function event({type='PAYMENT.CAPTURE.REFUNDED',orderId='AUTHOREDORDER',captureId='AUTHOREDCAPTURE',eventId='WH-'+randomUUID().replaceAll('-','').toUpperCase(),time=new Date().toISOString()}={}){
    return {id:eventId,event_type:type,create_time:time,resource:{id:type==='CHECKOUT.ORDER.APPROVED'?orderId:captureId,status:type.split('.').at(-1),amount:{currency_code:'USD',value:'87.00'},payee:{email_address:'private-payer@invented.example'},supplementary_data:{related_ids:{order_id:orderId,capture_id:captureId}}}};
  }
  function request(body,{headers={},time=new Date().toISOString(),id=randomUUID(),webhookId=env.SCOPE_PAYPAL_WEBHOOK_ID,origin='https://scope-before-payment.netlify.app'}={}){
    const raw=typeof body==='string'?body:JSON.stringify(body),message=id+'|'+time+'|'+webhookId+'|'+crc32(Buffer.from(raw));
    return new Request(origin+'/api/paypal/webhook',{method:'POST',headers:{'content-type':'application/json','paypal-transmission-id':id,'paypal-transmission-time':time,'paypal-transmission-sig':sign('RSA-SHA256',Buffer.from(message),keys.privateKey).toString('base64'),'paypal-cert-url':'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-AUTHORED-ONLY','paypal-auth-algo':'SHA256withRSA',...headers},body:raw});
  }
  return {env,cert,event,request};
}
