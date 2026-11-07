'use strict';
// Real HTTP/native stores/Chromium with one authored fake draft per fixture.
// No live inference, credentials or developer runtime state are used.
const {test,expect}=require('@playwright/test'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {openDraftService,makeSource}=require('../../experiments/scope-to-quote/draft-service');
const R=require('../../experiments/scope-to-quote/nvidia-partial-request');
const {startDraftDemo}=require('../../experiments/scope-to-quote/demo');
for(const email of [false,true])test((email?'email variant':'main app')+' leaves missing terms for the merchant and copies only reviewed useful fields',async({browser},testInfo)=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'partial-review-authored-'));await fs.chmod(root,0o700);
 const source=makeSource([{id:'B1',role:'buyer',text:'An invented request: one heron for my website.'},{id:'M1',role:'merchant',text:'I can supply one heron illustration as a digital PNG. Own website only. No resale or physical printing.'}]);
 const response={fields:{deliverable:{text:'One heron illustration as a digital PNG.',refs:['r2']},usage:{text:'Own website only. No resale or physical printing.',refs:['r2']},delivery:null,revisions:null,terms:null},exclusions:{state:'proposed',text:'No resale or physical printing.',refs:['r2']},questions:['delivery','revisions','terms'].map(field=>({field,question:'Please choose '+field+'.',refs:['r1']}))};
 let service,app,context,server,calls=0;const external=[],errors=[];
 try{
  service=await openDraftService({directory:root,messages:source.messages,draftFormat:'partial_nonprice_v3',admission:{syntheticOnly:true,transportMode:'injected_test_only',allowedSourceBindings:[source.binding],blockedSourceBindings:[],maximumCalls:1},transport:async()=>{calls++;return R.prepare(source).candidate(JSON.stringify(response));}});
  if(email){server=await require('../../experiments/email-bound-offer-checkout/live-server').start({draftService:service});app={origin:'http://127.0.0.1:'+server.address().port};app.merchantUrl=app.origin+'/offer';}else app=await startDraftDemo({draftService:service});
  context=await browser.newContext();await context.route('**/*',route=>{if(new URL(route.request().url()).origin===app.origin)return route.continue();external.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(app.merchantUrl);expect(calls).toBe(0);
  await page.getByText('Optional draft assistance Review suggestions before copying',{exact:true}).click();
  await page.locator('#draft-send-ack').check();await page.locator('#draft-request').click();
  await expect(page.locator('#draft-status')).toContainText('Unverified test draft');
  await expect(page.locator('#draft-result')).toContainText('Needs your input: delivery');
  await expect(page.locator('#draft-result')).toContainText('Unverified model questions · 3');
  await expect(page.locator('#draft-use')).toBeDisabled();
  await page.locator('#offer-price').fill('87.00');
  await page.locator('#draft-exclusions-text').fill('Own website only. No resale or physical printing.');
  await page.locator('#draft-exclusions-ack').check();
  await expect(page.locator('#draft-select-delivery')).toBeDisabled();
  await expect(page.locator('#draft-select-revisions')).toBeDisabled();
  await expect(page.locator('#draft-select-terms')).toBeDisabled();
  await page.locator('#draft-select-deliverable').check();await page.locator('#draft-select-usage').check();
  await page.locator('#draft-use-selected').click();
  await expect(page.locator('#offer-deliverable')).toHaveValue(response.fields.deliverable.text);
  await expect(page.locator('#offer-price')).toHaveValue('87.00');
  for(const field of ['delivery','revisions','terms'])await expect(page.locator('#offer-'+field)).toHaveValue('');
  await expect(page.locator('#offer-publish')).toBeDisabled();
  await page.locator('#offer-delivery').fill('January 12, 2027');await page.locator('#offer-revisions').fill('Two rounds.');
  await page.locator('#offer-full-payment-terms').click();await page.locator('#offer-merchant-ack').check();await page.locator('#offer-publish').click();
  await expect(page.locator('#offer-quote')).toContainText('87.00');
  if(!email){await expect(page.locator('#offer-record-mode')).toContainText('Exact server publish confirmed.');await page.locator('#offer-buyer-view').click();await page.locator('#offer-buyer-ack').check();await page.locator('#offer-accept').click();await expect(page.locator('#offer-acceptance')).toHaveText(/^This exact published revision is accepted\./);await page.locator('#checkout-prepare-ack').check();await page.locator('#checkout-prepare').click();await expect(page.locator('#checkout-amount')).toContainText('87.00');expect(app.observations()).toEqual({stage:null,create:0,read:0,capture:0});}
  expect(calls).toBe(1);expect(external).toEqual([]);expect(errors).toEqual([]);
  await page.keyboard.press('Control+Home');await page.screenshot({path:testInfo.outputPath('partial-review.png'),fullPage:true});
 }finally{await context?.close();if(server)await new Promise(resolve=>server.close(resolve));if(!email&&app)await app.close();await service?.close();await fs.rm(root,{recursive:true,force:true});}
});
