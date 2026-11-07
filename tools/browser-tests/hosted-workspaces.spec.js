'use strict';
// Actual Chromium -> HTTP API -> owned PostgreSQL. Identity is an explicit
// test-only adapter; no Netlify login, email, AI or PayPal request is made.
const {test,expect}=require('@playwright/test');
async function fixture(browser,options){const {startHostedFixture}=await import('../../apps/scope-web/tests/browser/server.mjs');const app=await startHostedFixture(options),contexts=[],external=[];return{app,external,async page(role,path='/'){const context=await browser.newContext();contexts.push(context);await context.route('**/*',route=>{if(new URL(route.request().url()).origin===app.origin)return route.continue();external.push(route.request().url());return route.abort();});const page=await context.newPage();await page.goto(app.origin+path);if(role){await page.getByLabel('Email address',{exact:true}).fill(role+'@invented.example');await page.getByLabel('Password',{exact:true}).fill('fixture-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();}return page;},async close(){for(const context of contexts)await context.close();await app.close();}};}
async function create(page,projectName='Alder & Vale opening illustration'){await expect(page.getByRole('heading',{name:'A clear offer starts here.'})).toBeVisible();await page.getByRole('button',{name:'New commission',exact:true}).click();await page.getByRole('button',{name:'Use invented bookshop example'}).click();await page.getByLabel('Project name',{exact:true}).fill(projectName);await page.getByLabel('Buyer’s account email',{exact:true}).fill('buyer@invented.example');await page.getByRole('button',{name:'Create private workspace'}).click();await expect(page.getByRole('heading',{name:projectName,exact:true})).toBeVisible();return new URL(page.url()).pathname.split('/').at(-1);}
async function fill(page){for(const[label,value]of [['What you will deliver','One raven illustration as digital SVG and PNG files.'],['Permitted uses and exclusions','Bookshop website, 250 paper bags and organic Instagram only. No paid adverts or resale. Printing services are not included.'],['Delivery commitment','January 8, 2027'],['Revision allowance','Two rounds.'],['All-in price (USD)','145.00']])await page.getByLabel(label,{exact:true}).fill(value);await page.getByRole('button',{name:'Use full payment before work'}).click();}
async function publish(page,revision){await page.getByLabel('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',{exact:true}).check();await page.getByRole('button',{name:'Publish exact offer',exact:true}).click();await expect(page.locator('.offer-state')).toBeVisible();await expect(page.getByText('REVISION '+revision,{exact:true})).toBeVisible();await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('Current saved offer loaded');}
async function accept(page){await page.getByLabel('I reviewed the full conversation and accept this exact offer and revision.',{exact:true}).check();await page.getByRole('button',{name:'Accept this revision',exact:true}).click();await expect(page.locator('.offer-state')).toHaveText('This exact revision is accepted. Payment is a separate step below.');}
async function changes(page){await page.getByLabel('Changes you need before accepting',{exact:true}).fill('Please include three revision rounds at the same total.');await page.getByLabel('Send this exact request for changes. This does not accept the offer.',{exact:true}).check();await page.getByRole('button',{name:'Request changes',exact:true}).click();}

async function downloadRecord(page){const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download saved record',exact:true}).click();const file=await pending;return {name:file.suggestedFilename(),record:JSON.parse(await require('node:fs/promises').readFile(await file.path(),'utf8'))};}
async function downloadReadable(page){const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download readable record',exact:true}).click();const file=await pending;return {name:file.suggestedFilename(),html:await require('node:fs/promises').readFile(await file.path(),'utf8')};}
async function downloadAccount(page){const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download account data',exact:true}).click();const file=await pending;return {name:file.suggestedFilename(),record:JSON.parse(await require('node:fs/promises').readFile(await file.path(),'utf8'))};}

test('payment preset explains unavailable actions and preserves existing terms when the price changes',async({browser})=>{
 const f=await fixture(browser,{checkout:true});try{
  const page=await f.page('creator');await create(page);const preset=page.getByRole('button',{name:'Use full payment before work',exact:true}),price=page.getByLabel('All-in price (USD)',{exact:true}),terms=page.getByLabel('Payment timing and other terms',{exact:true}),help=page.locator('#scope-payment-preset-help');
  await expect(preset).toBeDisabled();await expect(help).toContainText('Enter a price');await fill(page);await expect(preset).toBeDisabled();await expect(help).toContainText('clear the terms field after reviewing it');
  const ack=page.getByLabel('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',{exact:true});await ack.check();await price.fill('160.00');await expect(ack).not.toBeChecked();await expect(terms).toHaveValue('Single full payment of USD145.00 before work starts.');
  await terms.fill('Half before work; keep the cancellation terms.');await expect(preset).toBeDisabled();await expect(terms).toHaveValue('Half before work; keep the cancellation terms.');await terms.fill('');await price.fill('10000.01');await expect(preset).toBeDisabled();await expect(help).toContainText('Enter a price');await price.fill('10000.00');await expect(preset).toBeEnabled();
  await price.fill('160.00');await preset.click();await expect(terms).toHaveValue('Single full payment of USD160.00 before work starts.');await expect(preset).toBeDisabled();await expect(ack).not.toBeChecked();expect(f.app.counts.publish).toBe(0);expect(f.app.checkoutCounts).toEqual({create:0,check:0,capture:0});expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('accepted non-preset payment terms explain the needed new revision without authorizing checkout',async({browser},testInfo)=>{
 const f=await fixture(browser,{checkout:true});try{
  const merchant=await f.page('creator');await create(merchant);await fill(merchant);await merchant.getByLabel('Payment timing and other terms',{exact:true}).fill('Payment in one full payment before work starts.');await publish(merchant,1);
  const buyer=await f.page('buyer',new URL(await merchant.getByLabel('Private review link').inputValue()).pathname);await buyer.getByRole('button',{name:'Join this review',exact:true}).click();await accept(buyer);
  const payment=buyer.locator('#scope-payment');await expect(payment).toContainText('The published payment terms do not match the full-payment preset for USD145.00.');await expect(payment).toContainText('buyer must review and accept the new revision');await expect(buyer.getByRole('button',{name:'Create sandbox checkout',exact:true})).toHaveCount(0);await payment.scrollIntoViewIfNeeded();await buyer.screenshot({path:testInfo.outputPath('authored-payment-terms-blocked.png')});
  await merchant.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await expect(merchant.locator('#scope-payment')).toContainText('The published payment terms do not match');await merchant.getByLabel('All-in price (USD)',{exact:true}).fill('210.00');await merchant.getByLabel('Payment timing and other terms',{exact:true}).fill('');await merchant.getByRole('button',{name:'Use full payment before work',exact:true}).click();await publish(merchant,2);
  await buyer.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await expect(payment).toContainText('Review and accept the current offer');await expect(buyer.getByRole('button',{name:'Create sandbox checkout',exact:true})).toHaveCount(0);await accept(buyer);
  await expect(buyer.getByLabel('Create a PayPal sandbox order for USD210.00 and accepted revision 2. Approval and payment remain separate steps.',{exact:true})).toBeVisible();await expect(buyer.getByRole('button',{name:'Create sandbox checkout',exact:true})).toBeDisabled();expect(f.app.checkoutCounts).toEqual({create:0,check:0,capture:0});expect(f.app.counts.publish).toBe(2);expect(f.app.counts.accept).toBe(2);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('sign-out clears private header and panels before a held workspace reply can arrive',async({browser},testInfo)=>{
 const f=await fixture(browser);try{
  const page=await f.page('creator'),id=await create(page,'Private sign-out qualification');
  const held=f.app.hold('/api/v1/workspaces/'+id,{method:'GET'});await page.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await held.started;
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Your private workspace',exact:true})).toBeVisible();
  held.release();await page.waitForLoadState('networkidle');
  await expect(page.getByText('creator@invented.example',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Sign out',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Private sign-out qualification',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'The complete conversation',exact:true})).toHaveCount(0);
  await expect(page.getByText('Your account data',{exact:true})).toBeHidden();expect((await page.request.get(f.app.origin+'/api/v1/me')).status()).toBe(401);
  // A late initial-session completion must not overwrite the signed-out notice
  // with that old account's maintenance state either.
  f.app.pauseWrites();const oldSession=f.app.hold('/api/v1/workspaces/'+id,{method:'GET'});
  await page.getByLabel('Email address',{exact:true}).fill('creator@invented.example');await page.getByLabel('Password',{exact:true}).fill('fixture-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();await oldSession.started;
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Your private workspace',exact:true})).toBeVisible();oldSession.release();await page.waitForLoadState('networkidle');
  await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('Signed out.');await expect(page.getByRole('status',{name:'Workspace status',exact:true})).not.toContainText('Changes are temporarily paused.');await expect(page.getByText('creator@invented.example',{exact:true})).toHaveCount(0);
  expect(f.app.counts.publish).toBe(0);expect(f.app.counts.ai).toBe(0);expect(f.external).toEqual([]);
  await testInfo.attach('signed-out-private-screen-authored',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await f.close();}
});

test('a late dashboard list cannot repopulate the new-commission form or change its unsaved fields',async({browser})=>{
 const f=await fixture(browser);try{
  const held=f.app.hold('/api/v1/workspaces',{method:'GET'}),page=await f.page('creator');await held.started;
  await page.getByRole('button',{name:'New commission',exact:true}).click();await page.getByLabel('Project name',{exact:true}).fill('Unsent new commission');await page.getByLabel('Message',{exact:true}).nth(0).fill('An invented unsent draft.');
  held.release();await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading',{name:'Bring the conversation.',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Your workspaces',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Invitations for you',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Project name',{exact:true})).toHaveValue('Unsent new commission');await expect(page.getByLabel('Message',{exact:true}).nth(0)).toHaveValue('An invented unsent draft.');expect(f.app.counts.create).toBe(0);
  await page.getByRole('button',{name:'Cancel new workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'Your workspaces',exact:true})).toBeVisible();expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('unconfirmed SDK logout clears private UI without claiming success and retries only on an explicit action',async({browser})=>{
 const f=await fixture(browser);try{
  const page=await f.page('creator','/?testLogout=fail-once');await create(page,'Unconfirmed sign-out qualification');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign-out could not be confirmed.',exact:true})).toBeVisible();await expect(page.getByText('creator@invented.example',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Unconfirmed sign-out qualification',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Sign in',exact:true})).toHaveCount(0);await expect(page.getByText('Your account data',{exact:true})).toBeHidden();
  expect((await page.request.get(f.app.origin+'/api/v1/me')).status()).toBe(200);expect(await page.evaluate(()=>globalThis.scopeFixtureAuthEvents.filter(e=>e==='logout-unconfirmed').length)).toBe(1);
  await page.getByRole('button',{name:'Retry sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Your private workspace',exact:true})).toBeVisible();expect((await page.request.get(f.app.origin+'/api/v1/me')).status()).toBe(401);
  expect(await page.evaluate(()=>globalThis.scopeFixtureAuthEvents.filter(e=>e==='logout').length)).toBe(1);expect(f.app.counts.ai).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('sign-out preserves a lost AI action reference for the original account and recovery never sends it again',async({browser})=>{
 const f=await fixture(browser);try{
  const page=await f.page('creator');await create(page);const disclosure='Send excerpts from this saved conversation to Anthropic through Netlify for AI review. Scope privately retains this request and its result.';
  await page.getByLabel(disclosure,{exact:true}).check();f.app.lose('/draft');await page.getByRole('button',{name:'Review saved conversation with AI',exact:true}).click();await expect(page.getByRole('button',{name:'Check saved action',exact:true})).toBeVisible();
  const key='scope-hosted-action-v1:'+f.app.users.creator.id,before=await page.evaluate(key=>sessionStorage.getItem(key),key);expect(JSON.parse(before).path).toMatch(/\/draft$/);expect(f.app.counts.ai).toBe(1);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Your private workspace',exact:true})).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBe(before);
  await page.getByLabel('Email address',{exact:true}).fill('creator@invented.example');await page.getByLabel('Password',{exact:true}).fill('fixture-password-123');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Check saved action',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Check saved action',exact:true}).click();await expect(page.getByText('Suggestions saved · review required',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Check saved action',exact:true})).toBeHidden();
  await expect.poll(()=>page.evaluate(key=>sessionStorage.getItem(key),key)).toBe(null);expect(f.app.counts.ai).toBe(1);expect(f.app.counts.publish).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('unused invitation revocation survives a lost reply and removes a stale recipient join without losing creator edits',async({browser},testInfo)=>{
 const f=await fixture(browser);try{
  const merchant=await f.page('creator'),id=await create(merchant),path=new URL(await merchant.getByLabel('Private review link').inputValue()).pathname;
  const buyer=await f.page('buyer',path);await expect(buyer.getByRole('button',{name:'Join this review',exact:true})).toBeEnabled();
  await merchant.getByLabel('Permitted uses and exclusions',{exact:true}).fill('UNSAVED creator text stays here after revocation.');
  const revoke=merchant.getByRole('button',{name:'Revoke invitation',exact:true});await expect(revoke).toBeDisabled();
  let posts=0;merchant.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/revoke'))posts++;});
  f.app.lose('/revoke');await merchant.getByLabel('Permanently revoke this unused invitation.',{exact:true}).check();await revoke.click();
  await expect(merchant.getByRole('button',{name:'Check saved action',exact:true})).toBeVisible();await expect(merchant.getByLabel('Private review link')).toBeHidden();
  await merchant.getByRole('button',{name:'Check saved action',exact:true}).click();await expect(merchant.getByRole('heading',{name:'Invitation revoked',exact:true})).toBeVisible();
  await expect(merchant.getByLabel('Permitted uses and exclusions',{exact:true})).toHaveValue('UNSAVED creator text stays here after revocation.');await expect(revoke).toHaveCount(0);expect(posts).toBe(1);
  await buyer.getByRole('button',{name:'Join this review',exact:true}).click();await expect(buyer.getByRole('status',{name:'Workspace status',exact:true})).toContainText('unavailable');
  expect((await f.app.store('creator').read(id)).buyerJoined).toBe(false);await buyer.reload();await expect(buyer.getByRole('button',{name:'Join this review',exact:true})).toHaveCount(0);
  await merchant.setViewportSize({width:320,height:844});await testInfo.attach('revoked-invitation-authored',{body:await merchant.locator('.invite').screenshot(),contentType:'image/png'});
  expect(f.app.counts.publish).toBe(0);expect(f.app.counts.ai).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('a creator cannot revoke an invitation after a buyer joins through a separately opened page',async({browser})=>{
 const f=await fixture(browser);try{
  const merchant=await f.page('creator'),id=await create(merchant),path=new URL(await merchant.getByLabel('Private review link').inputValue()).pathname;
  await merchant.getByLabel('Permanently revoke this unused invitation.',{exact:true}).check();
  const buyer=await f.page('buyer',path);await buyer.getByRole('button',{name:'Join this review',exact:true}).click();await expect(buyer.getByRole('heading',{name:'Your decision',exact:true})).toBeVisible();
  await merchant.getByRole('button',{name:'Revoke invitation',exact:true}).click();await expect(merchant.getByRole('status',{name:'Workspace status',exact:true})).toContainText('already joined');
  await merchant.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await expect(merchant.getByRole('heading',{name:'Buyer has joined',exact:true})).toBeVisible();await expect(merchant.getByRole('button',{name:'Revoke invitation',exact:true})).toHaveCount(0);
  expect((await f.app.store('buyer').read(id)).role).toBe('buyer');expect(f.app.counts.accept).toBe(0);expect(f.app.counts.ai).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('unaccepted revisions expose price and permission changes while historical views cannot accept the old offer or replace edits',async({browser},testInfo)=>{
 const f=await fixture(browser);try{
  const merchant=await f.page('creator'),id=await create(merchant);await fill(merchant);await publish(merchant,1);
  const buyer=await f.page('buyer',new URL(await merchant.getByLabel('Private review link').inputValue()).pathname);await buyer.getByRole('button',{name:'Join this review'}).click();
  await merchant.getByLabel('Permitted uses and exclusions',{exact:true}).fill('Bookshop website and 500 bags. No paid adverts or resale.');await merchant.getByLabel('All-in price (USD)',{exact:true}).fill('160.00');await merchant.getByLabel('Payment timing and other terms',{exact:true}).fill('Single full payment of USD160.00 before work starts.');await publish(merchant,2);
  await buyer.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await expect(buyer.getByRole('heading',{name:'Changes from revision 1',exact:true})).toBeVisible();await expect(buyer.locator('.revision-changes')).toContainText('All-in price changed from USD 145.00 to USD 160.00');await expect(buyer.locator('.revision-changes')).toContainText('500 bags');await expect(buyer.locator('.decision-target')).toHaveText('Current decision: revision 2 · USD 160.00.');
  const buyerAck=buyer.getByLabel('I reviewed the full conversation and accept this exact offer and revision.',{exact:true});await buyerAck.check();await expect(buyer.getByRole('button',{name:'Accept this revision',exact:true})).toBeEnabled();await buyer.getByText('Earlier published revisions',{exact:true}).click();await expect(buyerAck).not.toBeChecked();await expect(buyer.getByRole('button',{name:'Accept this revision',exact:true})).toBeDisabled();await expect(buyer.locator('.history-amount')).toHaveText('USD 145.00');await expect(buyer.locator('.amount')).toHaveText('USD 160.00');await expect(buyer.locator('.revision-history')).toContainText('Your current decision still applies to revision 2 at USD 160.00');
  await merchant.getByLabel('All-in price (USD)',{exact:true}).fill('200.00');const merchantAck=merchant.getByLabel('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',{exact:true});await merchantAck.check();await merchant.getByText('Earlier published revisions',{exact:true}).click();await expect(merchantAck).not.toBeChecked();await expect(merchant.getByLabel('All-in price (USD)',{exact:true})).toHaveValue('200.00');await expect(merchant.getByRole('button',{name:'Publish exact offer',exact:true})).toBeDisabled();
  await testInfo.attach('unaccepted-revision-comparison-authored',{body:await buyer.locator('.revision-changes').screenshot(),contentType:'image/png'});
  await accept(buyer);const saved=await f.app.store('creator').read(id);expect(saved.quoteHistory.map(q=>q.accepted)).toEqual([false,true]);expect(saved.currentQuote.totalCents).toBe(16000);expect(f.app.counts.publish).toBe(2);expect(f.app.counts.accept).toBe(1);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('source-only revisions and earlier accepted snapshots stay qualified, wrap literal markup and retire on failed or foreign reads',async({browser})=>{
 const f=await fixture(browser);try{
  const merchant=await f.page('creator'),id=await create(merchant);await fill(merchant);await publish(merchant,1);const buyer=await f.page('buyer',new URL(await merchant.getByLabel('Private review link').inputValue()).pathname);await buyer.getByRole('button',{name:'Join this review'}).click();await accept(buyer);
  const literal='<img src="https://invalid.example/pixel" onerror="alert(1)">'+ 'x'.repeat(700);await merchant.getByLabel('What you will deliver',{exact:true}).fill(literal);await publish(merchant,2);
  const store=f.app.store('creator'),w=await store.read(id);await store.replaceSource(id,{requestId:require('node:crypto').randomUUID(),expectedVersion:w.source.version,messages:[...w.source.messages,{id:'B99',role:'buyer',text:'A saved source-only clarification.'}]});await merchant.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await publish(merchant,3);
  await buyer.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await buyer.setViewportSize({width:320,height:900});await expect(buyer.getByRole('heading',{name:'Changes from revision 2',exact:true})).toBeVisible();await expect(buyer.locator('.revision-changes')).toContainText('No offer field text changed');await expect(buyer.locator('.revision-changes')).toContainText('saved conversation also changed');
  await buyer.getByText('Earlier published revisions',{exact:true}).click();await expect(buyer.locator('.revision-history dd').first()).toHaveText(literal);await expect(buyer.locator('.revision-history img,.revision-history form,.revision-history iframe')).toHaveCount(0);expect(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await buyer.getByLabel('View earlier revision',{exact:true}).selectOption('1');await expect(buyer.locator('.revision-history')).toContainText('Acceptance was recorded for this earlier revision. It is not acceptance of the current offer or proof of payment.');await expect(buyer.locator('.decision-target')).toHaveText('Current decision: revision 3 · USD 145.00.');await expect(buyer.getByRole('button',{name:'Accept this revision',exact:true})).toBeDisabled();
  await buyer.route('**/api/v1/workspaces/'+id,route=>route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',body:'{"error":{"code":"service_unavailable"}}'}):route.continue());await buyer.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await expect(buyer.locator('.revision-review')).toBeHidden();await expect(buyer.getByRole('button',{name:'Accept this revision',exact:true})).toBeDisabled();await buyer.unroute('**/api/v1/workspaces/'+id);
  await buyer.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await expect(buyer.locator('.revision-review')).toBeVisible();const held=f.app.hold('/api/v1/workspaces/'+id,{method:'GET'});await buyer.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await held.started;f.app.users.buyer.id=require('node:crypto').randomUUID();held.release();await expect(buyer.getByRole('heading',{name:'Workspace unavailable',exact:true})).toBeVisible();await expect(buyer.locator('.revision-review')).toHaveCount(0);expect(f.app.counts.accept).toBe(1);expect(f.app.counts.publish).toBe(3);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('dashboard pages retain prior results on failed reads and retire them when the account changes mid-page',async({browser},testInfo)=>{
 const f=await fixture(browser);try{
  const recipient='pagination-'+require('node:crypto').randomUUID()+'@invented.example';f.app.users.buyer.email=recipient;
  const owner=f.app.store('creator'),messages=[{id:'B1',role:'buyer',text:'Invented paginated commission.'}];
  for(let i=0;i<26;i++)await owner.create({requestId:require('node:crypto').randomUUID(),projectName:'Page commission '+String(i).padStart(2,'0'),buyerEmail:recipient,messages});
  const page=await f.page('creator'),links=page.locator('a[href^="/workspace/"]');await expect(links).toHaveCount(25);await expect(page.getByRole('button',{name:'Load more workspaces',exact:true})).toBeVisible();
  let fail=true;await page.route(/\/api\/v1\/workspaces\?cursor=/,route=>{if(fail&&new URL(route.request().url()).searchParams.get('cursor')!=='start'){fail=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":{"code":"service_unavailable"}}'});}return route.continue();});
  await page.getByRole('button',{name:'Load more workspaces',exact:true}).click();await expect(page.getByLabel('Workspaces list status',{exact:true})).toContainText('Displayed items are unchanged');await expect(links).toHaveCount(25);
  await page.getByRole('button',{name:'Retry workspace page',exact:true}).click();await expect(links).toHaveCount(26);expect(new Set(await links.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))).size).toBe(26);await expect(page.getByRole('button',{name:'Load more workspaces',exact:true})).toBeHidden();
  await page.reload();await expect(links).toHaveCount(25);const held=f.app.hold('/api/v1/workspaces',{method:'GET'});await page.getByRole('button',{name:'Load more workspaces',exact:true}).click();await held.started;await page.context().addCookies([{name:'scope_fixture_actor',value:'buyer',url:f.app.origin}]);held.release();
  await expect(page.locator('.session')).toContainText(recipient);await expect(links).toHaveCount(0);const invitations=page.locator('a[href^="/invitation/"]');await expect(invitations).toHaveCount(25);
  await page.getByRole('button',{name:'Load more invitations',exact:true}).click();await expect(invitations).toHaveCount(26);await expect(page.getByRole('button',{name:'Load more invitations',exact:true})).toBeHidden();expect(f.external).toEqual([]);expect(f.app.counts.ai).toBe(0);
  await testInfo.attach('paginated-invitations-authored',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await f.close();}
});

test('account data copies download older saved conversations for both members without exporting unsaved edits',async({browser},testInfo)=>{
 const f=await fixture(browser);try{
  const merchant=await f.page('creator'),id=await create(merchant);await fill(merchant);await publish(merchant,1);
  const saved=await f.app.store('creator').read(id);await f.app.store('creator').replaceSource(id,{requestId:require('node:crypto').randomUUID(),expectedVersion:1,messages:[...saved.source.messages,{id:'B99',role:'buyer',text:'Invented later saved clarification.'}]});
  const buyer=await f.page('buyer',new URL(await merchant.getByLabel('Private review link').inputValue()).pathname);await buyer.getByRole('button',{name:'Join this review'}).click();
  await merchant.getByLabel('Permitted uses and exclusions',{exact:true}).fill('UNSAVED ACCOUNT DATA must stay in the editor');
  await merchant.getByText('Your account data',{exact:true}).click();const own=await downloadAccount(merchant);expect(own.name).toBe('scope-account-data.json');expect(own.record.sections.conversations.map(s=>s.version).sort()).toEqual([1,2]);expect(own.record.sections.offers).toHaveLength(1);expect(own.record.sections.invitations[0].recipientEmail).toBe('buyer@invented.example');expect(JSON.stringify(own.record)).not.toContain('UNSAVED ACCOUNT DATA');expect(own.record.notice).toContain('not an atomic');
  await expect(merchant.getByLabel('Permitted uses and exclusions',{exact:true})).toHaveValue('UNSAVED ACCOUNT DATA must stay in the editor');
  await buyer.getByText('Your account data',{exact:true}).click();f.app.pauseWrites();const other=await downloadAccount(buyer);expect(other.record.sections.conversations).toHaveLength(2);expect(other.record.sections.aiReviews).toEqual([]);expect(other.record.recoveryReadOnly).toBe(true);expect(other.record.recoveryNotice).toContain('later activity');
  expect(f.app.counts.publish).toBe(1);expect(f.app.counts.accept).toBe(0);expect(f.app.counts.ai).toBe(0);expect(f.external).toEqual([]);
  await testInfo.attach('account-data-authored',{body:JSON.stringify(own.record,null,2),contentType:'application/json'});
  await testInfo.attach('account-data-download-ui',{body:await merchant.locator('footer').screenshot(),contentType:'image/png'});
 }finally{await f.close();}
});

test('failed, cancelled and account-switched exports never download a partial private copy',async({browser})=>{
 const f=await fixture(browser);try{
  const page=await f.page('creator');await create(page);await page.getByText('Your account data',{exact:true}).click();let downloads=0;page.on('download',()=>downloads++);
  await page.route('**/api/v1/account-record/*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":{"code":"service_unavailable"}}'}));
  await page.getByRole('button',{name:'Download account data',exact:true}).click();await expect(page.getByLabel('Account data download status',{exact:true})).toContainText('No partial file was downloaded');expect(downloads).toBe(0);await page.unroute('**/api/v1/account-record/*');
  const cancelled=f.app.hold('/api/v1/account-record',{method:'GET'});await page.getByRole('button',{name:'Download account data',exact:true}).click();await cancelled.started;await page.getByRole('button',{name:'Cancel account download',exact:true}).click();cancelled.release();await expect(page.getByLabel('Account data download status',{exact:true})).toContainText('cancelled');expect(downloads).toBe(0);
  const switched=f.app.hold('/api/v1/account-record',{method:'GET'});await page.getByRole('button',{name:'Download account data',exact:true}).click();await switched.started;await page.context().addCookies([{name:'scope_fixture_actor',value:'buyer',url:f.app.origin}]);switched.release();await expect(page.getByRole('heading',{name:'Workspace unavailable'})).toBeVisible();expect(downloads).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('recovery mode keeps private reads and downloads available while direct and visible writes are held',async({browser},testInfo)=>{
 const f=await fixture(browser,{checkout:true});try{
  const page=await f.page('creator'),id=await create(page);await fill(page);await publish(page,1);
  const buyer=f.app.store('buyer'),uuid=()=>require('node:crypto').randomUUID();await buyer.joinInvitation(id,{requestId:uuid(),confirmation:'join-this-invited-workspace'});const q=(await buyer.read(id)).currentQuote;
  await buyer.accept(id,{requestId:uuid(),revision:1,quoteBinding:q.binding,confirmation:'accept-exact-published-offer'});
  const created=await buyer.startCheckout(id,{requestId:uuid(),revision:1,quoteBinding:q.binding,confirmation:'create-sandbox-checkout-for-this-offer'}),checked=await buyer.checkCheckout(id,{requestId:uuid(),checkoutId:created.checkout.id,confirmation:'check-this-sandbox-order'});
  await buyer.captureCheckout(id,{requestId:uuid(),checkoutId:created.checkout.id,approvalId:checked.checkout.approvalId,confirmation:'capture-this-exact-approved-sandbox-order'});
  f.app.pauseWrites();await page.reload();
  await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('Changes are temporarily paused');
  await expect(page.getByRole('button',{name:'Publish exact offer',exact:true})).toBeDisabled();
  await expect(page.locator('.payment-state')).toHaveText('Saved sandbox capture record. Current payment status is under recovery review.');await expect(page.locator('.offer-state')).toContainText('Later activity is under recovery review');
  const projected=await (await page.request.get(f.app.origin+'/api/v1/workspaces/'+id+'/checkout')).json();expect(projected.readOnly).toBe(true);expect(projected.data.checkout.state).toBe('recovery_review');expect((await buyer.readCheckout(id)).checkout.state).toBe('completed');
  const file=await downloadRecord(page);expect(file.record.currentRevision).toBe(1);expect(file.record.currentDecision).toBe('accepted');expect(file.record.recoveryReadOnly).toBe(true);expect(file.record.notice).toContain('saved data may precede later activity');expect(file.record.publishedRevisions[0].fields.price).toBe('145.00');
  const readable=await downloadReadable(page);expect(readable.html).toContain('Recovery review: later activity may be missing');expect(readable.html).toContain('does not establish payment or current funds');
  const denied=await page.request.post(f.app.origin+'/api/v1/workspaces/'+id+'/publish',{headers:{Origin:f.app.origin,'Content-Type':'application/json','X-Scope-Action':'explicit-user-action','X-Scope-Session':f.app.users.creator.id},data:'not JSON'});expect(denied.status()).toBe(503);expect((await denied.json()).error.code).toBe('recovery_read_only');
  expect((await f.app.store('creator').read(id)).currentQuote.revision).toBe(1);expect(f.app.checkoutCounts).toEqual({create:1,check:1,capture:1});expect(f.app.counts.ai).toBe(0);expect(f.external).toEqual([]);
  await page.getByRole('status',{name:'Workspace status',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('authored-recovery-read-only.png'),fullPage:false});
 }finally{await f.close();}
});

test('both members can download fresh saved records without leaking unsaved edits or changing decisions',async({browser},testInfo)=>{
 const f=await fixture(browser);try{
  const merchant=await f.page('creator'),id=await create(merchant);await fill(merchant);await publish(merchant,1);
  const buyer=await f.page('buyer',new URL(await merchant.getByLabel('Private review link').inputValue()).pathname);await buyer.getByRole('button',{name:'Join this review'}).click();await accept(buyer);
  // Merchant's displayed snapshot predates acceptance. Export must read again.
  await merchant.getByLabel('Permitted uses and exclusions',{exact:true}).fill('UNSAVED EDIT must not be downloaded');
  const first=await downloadRecord(merchant);expect(first.name).toBe('scope-offer-'+id+'-r1.json');expect(first.record.currentDecision).toBe('accepted');expect(first.record.publishedRevisions[0].fields.price).toBe('145.00');expect(JSON.stringify(first.record)).not.toContain('UNSAVED EDIT');expect(JSON.stringify(first.record)).not.toContain('buyer@invented.example');
  const readable=await downloadReadable(merchant);expect(readable.name).toBe('scope-offer-'+id+'-r1.html');expect(readable.html).not.toContain('UNSAVED EDIT');expect(readable.html).not.toContain('buyer@invented.example');
  await expect(merchant.getByRole('status',{name:'Record download status',exact:true})).toContainText('Check your browser’s downloads to confirm the file was saved');
  const copy=await merchant.context().newPage();await copy.setContent(readable.html);await expect(copy.getByRole('heading',{name:'Published revision 1',exact:true})).toBeVisible();await expect(copy.getByText('Acceptance recorded for the current revision',{exact:true})).toBeVisible();await expect(copy.locator('script,img,form,a')).toHaveCount(0);await copy.screenshot({path:testInfo.outputPath('authored-readable-offer.png'),fullPage:false});await copy.pdf({path:testInfo.outputPath('authored-readable-offer.pdf'),format:'A4',printBackground:true});await copy.close();
  await expect(merchant.getByLabel('Permitted uses and exclusions',{exact:true})).toHaveValue('UNSAVED EDIT must not be downloaded');
  await merchant.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await publish(merchant,2);
  await buyer.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await changes(buyer);
  const second=await downloadRecord(buyer);expect(second.record.currentDecision).toBe('changes-requested');expect(second.record.currentRevision).toBe(2);expect(second.record.publishedRevisions.map(q=>q.acceptanceRecorded)).toEqual([true,false]);expect(second.record.changeRequests[0].note).toContain('three revision rounds');
  const buyerCopy=await downloadReadable(buyer);expect(buyerCopy.html).toContain('Changes requested');expect(buyerCopy.html).toContain('three revision rounds');expect(buyerCopy.html).toContain('Published revision 2');
  expect(f.app.counts.publish).toBe(2);expect(f.app.counts.accept).toBe(1);expect(f.app.counts.ai).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('a failed read or changed account cannot download a cached private record',async({browser})=>{
 const f=await fixture(browser);try{
  const page=await f.page('creator'),id=await create(page);await fill(page);await publish(page,1);let downloads=0;page.on('download',()=>downloads++);
  let failed=true;await page.route('**/api/v1/workspaces/'+id,route=>{if(failed&&route.request().method()==='GET'){failed=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":{"code":"service_unavailable"}}'});}return route.continue();});
  await page.getByRole('button',{name:'Download saved record',exact:true}).click();await expect(page.getByText('The saved record could not be downloaded. Check your account and refresh the saved offer before trying again.',{exact:true})).toBeVisible();expect(downloads).toBe(0);
  await page.context().addCookies([{name:'scope_fixture_actor',value:'buyer',url:f.app.origin}]);await page.getByRole('button',{name:'Download readable record',exact:true}).click();await expect(page.getByRole('heading',{name:'Workspace unavailable'})).toBeVisible();expect(downloads).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('authored AI suggestions survive lost HTTP response, require individual review, preserve manual price and retire on source changes',async({browser})=>{
 const f=await fixture(browser);try{
  const page=await f.page('creator'),id=await create(page,'Authored AI review qualification');
  const consent='Send excerpts from this saved conversation to Anthropic through Netlify for AI review. Scope privately retains this request and its result.';
  await expect(page.getByRole('button',{name:'Review saved conversation with AI'})).toBeDisabled();
  await page.getByLabel('All-in price (USD)',{exact:true}).fill('145.00');
  await page.getByLabel(consent,{exact:true}).check();f.app.lose('/draft');await page.getByRole('button',{name:'Review saved conversation with AI'}).click();
  await expect(page.getByRole('button',{name:'Check saved action'})).toBeVisible();
  await page.getByRole('button',{name:'Check saved action'}).click();
  await expect(page.getByLabel('All-in price (USD)',{exact:true})).toHaveValue('145.00');
  const suggestion=page.getByLabel('AI suggestion: What you will deliver',{exact:true});await expect(suggestion).toBeVisible();
  const card=page.locator('.ai-suggestion').filter({has:suggestion}),copy=card.getByRole('button',{name:'Copy reviewed what you will deliver'}),ack=card.getByLabel('I checked the complete messages, exclusions and questions for this suggestion.');
  await expect(copy).toBeDisabled();await suggestion.fill('One raven illustration as digital SVG and PNG files.');await ack.check();await copy.click();
  await expect(page.getByLabel('What you will deliver',{exact:true})).toHaveValue('One raven illustration as digital SVG and PNG files.');await expect(copy).toBeDisabled();
  await expect(page.getByLabel('Payment timing and other terms',{exact:true})).toHaveValue('');await expect(page.getByLabel('AI suggestion: Payment timing and other terms',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Check saved AI result'}).click();await expect(suggestion).toHaveValue('One raven illustration as digital SVG and PNG files.');
  await page.getByText('Update the conversation',{exact:true}).click();const source=page.locator('.message-editor textarea').first();await source.fill('A changed source requiring fresh review.');
  await expect(card.getByLabel('I checked the complete messages, exclusions and questions for this suggestion.')).toBeDisabled();
  await page.getByRole('button',{name:'Save changed conversation'}).click();await expect(page.getByText('This saved review belongs to an older conversation. It cannot be copied.',{exact:true})).toBeVisible();await expect(suggestion).toHaveCount(0);
  expect(f.app.counts.ai).toBe(1);expect(f.app.counts.publish).toBe(0);expect(f.app.counts.accept).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('mobile section navigation preserves edits and AI rereads retire copying after failure or an external source change',async({browser},testInfo)=>{
 const f=await fixture(browser);try{
  const page=await f.page('creator'),id=await create(page,'Mobile source retirement qualification');await page.setViewportSize({width:320,height:844});
  await page.getByRole('button',{name:'Offer editor',exact:true}).click();await expect(page.getByRole('heading',{name:'Write your exact offer',exact:true})).toBeFocused();
  await page.getByLabel('All-in price (USD)',{exact:true}).fill('145.00');
  await page.getByRole('button',{name:'AI review',exact:true}).click();const heading=page.getByRole('heading',{name:'Find the terms in the conversation',exact:true});await expect(heading).toBeFocused();
  await expect.poll(()=>heading.evaluate(el=>{const nav=document.querySelector('.workspace-nav');return el.getBoundingClientRect().top>=nav.getBoundingClientRect().bottom&&el.getBoundingClientRect().bottom<innerHeight;})).toBe(true);
  await page.getByLabel('Send excerpts from this saved conversation to Anthropic through Netlify for AI review. Scope privately retains this request and its result.',{exact:true}).check();await page.getByRole('button',{name:'Review saved conversation with AI',exact:true}).click();
  await expect(page.locator('.ai-state')).toHaveText('Suggestions saved · review required');
  const suggestion=page.getByLabel('AI suggestion: What you will deliver',{exact:true}),card=page.locator('.ai-suggestion').filter({has:suggestion}),ack=card.getByLabel('I checked the complete messages, exclusions and questions for this suggestion.'),copy=card.getByRole('button',{name:'Copy reviewed what you will deliver',exact:true});
  await suggestion.fill('My reviewed correction stays here.');await ack.check();await expect(copy).toBeEnabled();
  let failOnce=true;await page.route('**/api/v1/workspaces/'+id+'/draft',route=>{if(failOnce&&route.request().method()==='GET'){failOnce=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":{"code":"service_unavailable"}}'});}return route.continue();});
  await page.getByRole('button',{name:'Check saved AI result',exact:true}).click();await expect(page.locator('.ai-state')).toContainText('could not be checked');await expect(suggestion).toHaveValue('My reviewed correction stays here.');await expect(ack).not.toBeChecked();await expect(copy).toBeDisabled();
  await page.getByRole('button',{name:'Check saved AI result',exact:true}).click();await expect(page.locator('.ai-state')).toHaveText('Suggestions saved · review required');await expect(suggestion).toHaveValue('My reviewed correction stays here.');await expect(ack).not.toBeChecked();await ack.check();await expect(copy).toBeEnabled();
  const store=f.app.store('creator'),saved=await store.read(id);await store.replaceSource(id,{requestId:crypto.randomUUID(),expectedVersion:saved.source.version,messages:[...saved.source.messages,{id:'B4',role:'buyer',text:'A separate client saved a new source requirement.'}]});
  await page.getByRole('button',{name:'Check saved AI result',exact:true}).click();await expect(page.locator('.ai-state')).toHaveText('Saved review · older conversation');await expect(suggestion).toHaveValue('My reviewed correction stays here.');await expect(ack).toBeDisabled();await expect(copy).toBeDisabled();
  await page.getByRole('button',{name:'Offer editor',exact:true}).click();await expect(page.getByLabel('All-in price (USD)',{exact:true})).toHaveValue('145.00');await expect(page.getByLabel('What you will deliver',{exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'Publish exact offer',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'AI review',exact:true}).click();await expect(heading).toBeFocused();await page.screenshot({path:testInfo.outputPath('mobile-ai-source-retired.png'),fullPage:false});
  expect(f.app.counts.ai).toBe(1);expect(f.app.counts.publish).toBe(0);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('confirmed invitation, creator offer, buyer-only review and fresh acceptance across revisions',async({browser},testInfo)=>{
 const f=await fixture(browser);try{const merchant=await f.page('creator'),id=await create(merchant);await fill(merchant);await publish(merchant,1);const invitation=new URL(await merchant.getByLabel('Private review link').inputValue()).pathname;
 const buyer=await f.page('buyer',invitation);await expect(buyer.getByRole('button',{name:'Join this review'})).toBeEnabled();await buyer.getByRole('button',{name:'Join this review'}).click();await expect(buyer).toHaveURL(new RegExp('/workspace/'+id+'$'));await expect(buyer.getByLabel('What you will deliver',{exact:true})).toHaveCount(0);await accept(buyer);
 await expect(buyer.getByRole('button',{name:'Accept this revision'})).toBeHidden();await merchant.getByRole('button',{name:'Refresh saved offer'}).click();await expect(merchant.getByRole('heading',{name:'Buyer has joined'})).toBeVisible();
 await merchant.getByLabel('All-in price (USD)',{exact:true}).fill('160.00');await merchant.getByLabel('Payment timing and other terms',{exact:true}).fill('Single full payment of USD160.00 before work starts.');await publish(merchant,2);
 await buyer.getByRole('button',{name:'Refresh saved offer'}).click();await expect(buyer.getByText('REVISION 2',{exact:true})).toBeVisible();await expect(buyer.getByRole('button',{name:'Accept this revision'})).toBeDisabled();await buyer.getByText('Changes since your earlier accepted offer',{exact:true}).click();await expect(buyer.getByText('Earlier: 145.00',{exact:true})).toBeVisible();await expect(buyer.getByText('Now: 160.00',{exact:true})).toBeVisible();await changes(buyer);await expect(buyer.locator('.offer-state')).toContainText('Changes requested');await expect(buyer.getByRole('button',{name:'Accept this revision'})).toBeDisabled();
 await merchant.getByRole('button',{name:'Refresh saved offer'}).click();await expect(merchant.getByText('Please include three revision rounds at the same total.',{exact:true})).toBeVisible();await merchant.getByLabel('Revision allowance',{exact:true}).fill('Three rounds.');await merchant.getByLabel('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',{exact:true}).check();await expect(merchant.getByRole('button',{name:'Publish exact offer'})).toBeDisabled();await merchant.getByLabel('I reviewed the buyer’s open request. Publish this revision as my response.',{exact:true}).check();await expect(merchant.getByRole('button',{name:'Publish exact offer'})).toBeEnabled();
 await merchant.getByText('Update the conversation',{exact:true}).click();await merchant.getByRole('button',{name:'Add message',exact:true}).click();await merchant.getByLabel('Message',{exact:true}).last().fill('Three revision rounds requested; the price stays USD160.');await expect(merchant.getByRole('button',{name:'Publish exact offer'})).toBeDisabled();await merchant.getByRole('button',{name:'Save changed conversation',exact:true}).click();await expect(merchant.getByRole('status',{name:'Workspace status',exact:true})).toContainText('Current saved offer loaded');await expect(merchant.getByText('Open request. The creator must explicitly publish a response.',{exact:true})).toBeVisible();await merchant.getByLabel('I reviewed the buyer’s open request. Publish this revision as my response.',{exact:true}).check();await publish(merchant,3);
 await buyer.getByRole('button',{name:'Refresh saved offer'}).click();await expect(buyer.getByText('REVISION 3',{exact:true})).toBeVisible();await expect(buyer.getByRole('button',{name:'Accept this revision'})).toBeDisabled();await expect(buyer.getByText('Revision 3 uses a changed conversation and supersedes this request. Review the new offer separately.',{exact:true})).toBeVisible();await expect(buyer.getByRole('heading',{name:'Changes in response to your request',exact:true})).toBeVisible();await expect(buyer.getByText('Requested revision: Two rounds.',{exact:true})).toBeVisible();await expect(buyer.getByText('Creator’s response: Three rounds.',{exact:true})).toBeVisible();await accept(buyer);
 expect(f.app.counts).toEqual({create:1,publish:3,join:1,accept:2,changes:1,ai:0});expect(f.external).toEqual([]);await buyer.evaluate(()=>{window.scrollTo(0,0);document.querySelector('.conversation').scrollTop=0;});await expect.poll(()=>buyer.evaluate(()=>window.scrollY)).toBe(0);await buyer.screenshot({path:testInfo.outputPath('hosted-buyer.png'),fullPage:true});
 }finally{await f.close();}
});
test('late edits survive publication and lost response recovery never replays a POST',async({browser})=>{
 const f=await fixture(browser);try{const page=await f.page('creator');await create(page);await fill(page);const held=f.app.hold('/publish');await page.getByLabel('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',{exact:true}).check();await page.getByRole('button',{name:'Publish exact offer',exact:true}).click();await held.started;await expect(page.getByRole('button',{name:'Check saved action'})).toBeHidden();
 const usage=page.getByLabel('Permitted uses and exclusions',{exact:true});await usage.fill('Later merchant correction, preserved while the response is held.');held.release();await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('unsaved text is preserved');await expect(usage).toHaveValue('Later merchant correction, preserved while the response is held.');await expect(page.getByRole('button',{name:'Publish exact offer'})).toBeDisabled();
 f.app.lose('/publish');await page.getByLabel('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',{exact:true}).check();await page.getByRole('button',{name:'Publish exact offer'}).click();await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('response is unconfirmed');await usage.fill('A further unsaved draft after the lost response.');await page.getByRole('button',{name:'Check saved action'}).click();await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('unsaved text is preserved');await expect(usage).toHaveValue('A further unsaved draft after the lost response.');await expect(page.getByText('REVISION 2',{exact:true})).toBeVisible();expect(f.app.counts.publish).toBe(2);expect(f.external).toEqual([]);
 }finally{await f.close();}
});
test('an account switch cannot submit another creator’s stale form and private fields are retired',async({browser})=>{
 const f=await fixture(browser);try{const page=await f.page('creator'),id=await create(page);await fill(page);await page.getByLabel('I reviewed the conversation, all six offer fields, exclusions and payment terms. Publish this exact offer.',{exact:true}).check();await page.context().addCookies([{name:'scope_fixture_actor',value:'buyer',url:f.app.origin}]);await page.getByRole('button',{name:'Publish exact offer'}).click();await expect(page.getByRole('heading',{name:'Workspace unavailable'})).toBeVisible();await expect(page.getByLabel('What you will deliver',{exact:true})).toHaveCount(0);expect((await f.app.store('creator').read(id)).currentQuote).toBeNull();expect(f.external).toEqual([]);
 }finally{await f.close();}
});
for(const type of ['invite','recovery'])test('account '+type+' callback requires the correct password-completion SDK action',async({browser})=>{
 const f=await fixture(browser);try{const page=await f.page(null,'/?testCallback='+type);await page.getByLabel('Choose a new password',{exact:true}).fill('fixture-new-password-123');await page.getByLabel('Repeat new password',{exact:true}).fill('fixture-new-password-123');await page.getByRole('button',{name:'Save password and continue'}).click();await expect(page.getByRole('heading',{name:'A clear offer starts here.'})).toBeVisible();const events=await page.evaluate(()=>globalThis.scopeFixtureAuthEvents);expect(events.filter(e=>e===(type==='invite'?'acceptInvite':'updateUser')).length).toBe(1);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('an unavailable API never displays response markup or parser internals',async({browser})=>{
 const f=await fixture(browser);try{const page=await f.page(null);await page.route('**/api/v1/me',route=>route.fulfill({status:503,contentType:'text/html',body:'<!doctype html><title>private upstream marker</title>'}));await page.reload();await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('The private service is unavailable.');await expect(page.locator('body')).not.toContainText('Unexpected token');await expect(page.locator('body')).not.toContainText('private upstream marker');expect(f.app.counts).toEqual({create:0,publish:0,join:0,accept:0,changes:0,ai:0});
 }finally{await f.close();}
});

test('a lost buyer change response survives reload and is recovered by GET without another submission',async({browser})=>{
 const f=await fixture(browser);try{const merchant=await f.page('creator');await create(merchant);await fill(merchant);await publish(merchant,1);const invitation=new URL(await merchant.getByLabel('Private review link').inputValue()).pathname;const buyer=await f.page('buyer',invitation);await buyer.getByRole('button',{name:'Join this review'}).click();await expect(buyer.getByRole('heading',{name:'Your decision'})).toBeVisible();f.app.lose('/request-changes');await changes(buyer);await expect(buyer.getByRole('status',{name:'Workspace status',exact:true})).toContainText('response is unconfirmed');buyer.once('dialog',dialog=>dialog.accept());await buyer.reload();await expect(buyer.getByRole('button',{name:'Check saved action'})).toBeVisible();await buyer.getByRole('button',{name:'Check saved action'}).click();await expect(buyer.getByRole('button',{name:'Check saved action'})).toBeHidden();await expect(buyer.locator('.offer-state')).toContainText('Changes requested');expect(f.app.counts.changes).toBe(1);await expect(buyer.getByRole('button',{name:'Withdraw request',exact:true})).toBeDisabled();await buyer.getByLabel('Withdraw this exact request. This does not accept any offer.',{exact:true}).check();await buyer.getByRole('button',{name:'Withdraw request',exact:true}).click();await expect(buyer.getByText('Buyer withdrew this request. No offer was accepted.',{exact:true})).toBeVisible();await expect(buyer.getByRole('button',{name:'Accept this revision',exact:true})).toBeDisabled();await expect(buyer.getByRole('button',{name:'Request changes',exact:true})).toBeHidden();await accept(buyer);expect(f.external).toEqual([]);
 }finally{await f.close();}
});

test('browser Back preserves unsaved offer text and keeps the visible route consistent',async({browser})=>{
 const f=await fixture(browser);try{const page=await f.page('creator'),id=await create(page);await fill(page);await publish(page,1);await page.getByRole('link',{name:'All workspaces',exact:true}).click();await page.getByRole('link',{name:'Alder & Vale opening illustration',exact:true}).click();await page.getByLabel('Permitted uses and exclusions',{exact:true}).fill('Unsaved correction that must survive Back.');await page.goBack();await expect(page).toHaveURL(new RegExp('/workspace/'+id+'$'));await expect(page.getByLabel('Permitted uses and exclusions',{exact:true})).toHaveValue('Unsaved correction that must survive Back.');await expect(page.getByRole('status',{name:'Workspace status',exact:true})).toContainText('Discard unsaved changes');expect(f.app.counts.publish).toBe(1);
 }finally{await f.close();}
});

test('mobile workspaces wrap long names and render offer and buyer-request markup as literal text',async({browser},testInfo)=>{
 const f=await fixture(browser);try{const merchant=await f.page('creator');await merchant.setViewportSize({width:390,height:844});await create(merchant,'Commission'+'X'.repeat(100));await fill(merchant);const literal='<img src="https://invalid.example/pixel" onerror="alert(1)">';await merchant.getByLabel('Permitted uses and exclusions',{exact:true}).fill('Website only. No resale. '+literal);await publish(merchant,1);expect(await merchant.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const invitation=new URL(await merchant.getByLabel('Private review link').inputValue()).pathname,buyer=await f.page('buyer',invitation);await buyer.setViewportSize({width:390,height:844});await buyer.getByRole('button',{name:'Join this review'}).click();await expect(buyer.getByText('Website only. No resale. '+literal,{exact:true})).toBeVisible();await buyer.getByLabel('Changes you need before accepting',{exact:true}).fill('Please remove this literal example: '+literal);await buyer.getByLabel('Send this exact request for changes. This does not accept the offer.',{exact:true}).check();await buyer.getByRole('button',{name:'Request changes',exact:true}).click();await expect(buyer.getByText('Please remove this literal example: '+literal,{exact:true})).toBeVisible();await expect(buyer.locator('img')).toHaveCount(0);expect(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(f.external).toEqual([]);await buyer.screenshot({path:testInfo.outputPath('hosted-mobile.png'),fullPage:true});
 }finally{await f.close();}
});


test('acceptance while an old payment-status read is held reads the current local journal without provider IO',async({browser})=>{
 const f=await fixture(browser,{checkout:true});let release;try{
  const merchant=await f.page('creator'),id=await create(merchant);await fill(merchant);await publish(merchant,1);
  const buyer=await f.page('buyer',new URL(await merchant.getByLabel('Private review link').inputValue()).pathname);
  let first=true,entered,reads=0;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  await buyer.route('**/api/v1/workspaces/'+id+'/checkout',async route=>{if(route.request().method()!=='GET')return route.continue();reads++;if(!first)return route.continue();first=false;const response=await route.fetch();entered();await held;await route.fulfill({response});});
  await buyer.getByRole('button',{name:'Join this review',exact:true}).click();await started;await accept(buyer);release();
  await expect(buyer.getByLabel('Create a PayPal sandbox order for USD145.00 and accepted revision 1. Approval and payment remain separate steps.',{exact:true})).toBeVisible();expect(reads).toBe(2);expect(f.app.checkoutCounts).toEqual({create:0,check:0,capture:0});expect(f.external).toEqual([]);
 }finally{release?.();await f.close();}
});

test('signed refund through HTTP and PostgreSQL retires capture confirmation after the recoverable sandbox checkout journey',async({browser},testInfo)=>{
 const f=await fixture(browser,{checkout:true,webhook:true});try{
  const merchant=await f.page('creator'),id=await create(merchant);await fill(merchant);await publish(merchant,1);
  const buyer=await f.page('buyer',new URL(await merchant.getByLabel('Private review link').inputValue()).pathname);await buyer.getByRole('button',{name:'Join this review'}).click();await accept(buyer);
  const consent=buyer.getByLabel('Create a PayPal sandbox order for USD145.00 and accepted revision 1. Approval and payment remain separate steps.',{exact:true});await expect(consent).toBeVisible();
  await expect(buyer.getByRole('button',{name:'Create sandbox checkout',exact:true})).toBeDisabled();await consent.check();f.app.lose('/checkout');await buyer.getByRole('button',{name:'Create sandbox checkout',exact:true}).click();await expect(buyer.getByRole('status',{name:'Workspace status',exact:true})).toContainText('response is unconfirmed');
  await buyer.reload();await buyer.getByRole('button',{name:'Check saved action',exact:true}).click();await expect(buyer.getByRole('status',{name:'Workspace status',exact:true})).toContainText('Saved action found.');await expect(buyer.locator('.payment-state')).toHaveText('Order created. Buyer approval is still needed.');expect(f.app.checkoutCounts.create).toBe(1);
  const approval=buyer.getByRole('link',{name:'Approve this order on PayPal sandbox',exact:true});const savedCase=await f.app.store('buyer').readCheckout(id);await expect(approval).toHaveAttribute('href','https://www.sandbox.paypal.com/checkoutnow?token='+savedCase.checkout.orderId);
  await buyer.getByRole('button',{name:'Refresh payment status',exact:true}).click();expect(f.app.checkoutCounts.check).toBe(0);expect(f.app.checkoutCounts.capture).toBe(0);
  await buyer.goto(f.app.origin+'/workspace/'+id+'?paypal_return='+id+'&token=UNTRUSTED&PayerID=UNTRUSTED');await expect(buyer.locator('.payment-state')).toContainText('approval is still needed');expect(f.app.checkoutCounts.check).toBe(0);expect(f.app.checkoutCounts.capture).toBe(0);
  await buyer.getByRole('button',{name:'Check order with PayPal',exact:true}).click();const pay=buyer.getByRole('button',{name:'Confirm sandbox payment',exact:true});await expect(pay).toBeDisabled();
  await buyer.getByLabel('Pay USD145.00 in sandbox for accepted revision 1. This sends one capture request.',{exact:true}).check();f.app.lose('/checkout/capture');await pay.click();await expect(buyer.getByRole('status',{name:'Workspace status',exact:true})).toContainText('response is unconfirmed');
  const captureIntent=await buyer.evaluate(actor=>JSON.parse(sessionStorage.getItem('scope-hosted-action-v1:'+actor)),f.app.users.buyer.id),lookup=f.app.hold('/operations/'+captureIntent.requestId,{method:'GET'});
  await buyer.getByRole('button',{name:'Check saved action',exact:true}).click();await lookup.started;
  // The safe status GET may already show capture history while the operation
  // recovery is still pending. That caption must not stand in for completion.
  await buyer.getByRole('button',{name:'Refresh payment status',exact:true}).click();await expect(buyer.locator('.payment-state')).toHaveText('Sandbox payment confirmed.');
  await expect(buyer.getByRole('button',{name:'Download saved record',exact:true})).toBeDisabled();await expect(buyer.getByRole('button',{name:'Confirm sandbox payment',exact:true})).toHaveCount(0);expect(f.app.checkoutCounts).toEqual({create:1,check:1,capture:1});
  lookup.release();await expect(buyer.getByRole('status',{name:'Workspace status',exact:true})).toContainText('Saved action found.');
  await expect(buyer.locator('.payment-state')).toHaveText('Sandbox payment confirmed.');await expect(buyer.getByRole('button',{name:'Confirm sandbox payment',exact:true})).toHaveCount(0);await buyer.reload();await expect(buyer.locator('.payment-state')).toHaveText('Sandbox payment confirmed.');
  await merchant.getByRole('button',{name:'Refresh saved offer',exact:true}).click();await expect(merchant.locator('.payment-state')).toHaveText('Sandbox payment confirmed.');await expect(merchant.getByRole('link',{name:'Approve this order on PayPal sandbox'})).toHaveCount(0);
  const completed=await f.app.store('buyer').readCheckout(id);const delivered=await f.app.deliverWebhook(f.app.webhookEvent({type:'PAYMENT.CAPTURE.REFUNDED',orderId:completed.checkout.orderId,captureId:completed.checkout.captureId}));expect(delivered.status).toBe(200);
  await buyer.getByRole('button',{name:'Refresh payment status',exact:true}).click();await expect(buyer.locator('.payment-state')).toHaveText('PayPal reported a payment change or conflicting update. Review the payment before starting work.');await expect(buyer.getByRole('button',{name:'Confirm sandbox payment',exact:true})).toHaveCount(0);
  const recheck=f.app.hold('/checkout/check');await expect(buyer.getByRole('button',{name:'Check order with PayPal',exact:true})).toBeEnabled();await buyer.getByRole('button',{name:'Check order with PayPal',exact:true}).click();await recheck.started;
  // The refund warning already exists while the new check is pending. Wait
  // for the held HTTP reply and settled controls, not the unchanged caption.
  await expect(buyer.locator('.payment-state')).toContainText('Review the payment before starting work');expect(f.app.checkoutCounts.check).toBe(2);await expect(buyer.getByRole('button',{name:'Check order with PayPal',exact:true})).toBeDisabled();
  recheck.release();await expect.poll(()=>f.app.checkoutCounts.check).toBe(2);await expect(buyer.getByRole('button',{name:'Check order with PayPal',exact:true})).toBeEnabled();
  await merchant.getByRole('button',{name:'Refresh payment status',exact:true}).click();await expect(merchant.locator('.payment-state')).toContainText('Review the payment before starting work');
  expect(f.app.checkoutCounts).toEqual({create:1,check:2,capture:1});expect(f.external).toEqual([]);await buyer.locator('#scope-payment').scrollIntoViewIfNeeded();await buyer.screenshot({path:testInfo.outputPath('authored-checkout-recovered.png'),fullPage:false});
 }finally{await f.close();}
});
