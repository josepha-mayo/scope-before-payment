'use strict';
const {test,expect}=require('@playwright/test');
const origin='https://127.0.0.1:4188';
test.describe.configure({mode:'serial'});
let metadata;
async function github(page,role){
  await page.route('https://github.com/login/oauth/authorize?**',async route=>{
    const url=new URL(route.request().url());expect(url.searchParams.get('scope')).toBe('user:email');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    await route.fulfill({status:302,headers:{location:origin+'/api/auth/callback/github?code=owned-'+role+'&state='+encodeURIComponent(url.searchParams.get('state'))}});
  });
  await page.getByRole('button',{name:'Continue with GitHub',exact:true}).click();
}
test.beforeEach(async({page,request})=>{
  metadata=await (await request.get('/__owned/status')).json();
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||url.origin==='https://github.com')return route.continue();throw Error('unexpected_external_browser_request');});
});
test('portable entry has one real SDK sign-in and truthful inactive-provider disclosure',async({page,request})=>{
  const response=await request.get('/healthz');expect(response.status()).toBe(200);expect(await response.json()).toEqual({status:'ready',mode:'read-only'});
  expect(response.headers()['strict-transport-security']).toBe('max-age=31536000');
  await page.goto('/');await expect(page.getByRole('heading',{name:'Your private workspace'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue with GitHub'})).toBeVisible();await expect(page.getByLabel('Password',{exact:true})).toHaveCount(0);
  await page.getByText('How Scope stores your data',{exact:true}).click();await expect(page.getByText('New AI review is not connected on this host.',{exact:false})).toBeVisible();
  await page.screenshot({path:'portable-login-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('button',{name:'Continue with GitHub'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'portable-login-mobile.png',fullPage:true});
});
test('actual browser callback preserves creator ownership, source history and the read-only hold',async({page})=>{
  await page.goto('/workspace/'+metadata.workspaceId);await github(page,'creator');
  await expect(page).toHaveURL(origin+'/workspace/'+metadata.workspaceId);
  await expect(page.getByRole('heading',{name:'Portable migration - owned history',exact:true})).toBeVisible();
  await expect(page.getByText('Owned private migration message for one heron.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Publish exact offer',exact:true})).toBeDisabled();
  const me=await page.evaluate(async()=>{const response=await fetch('/api/v1/me');return {status:response.status,body:await response.json()};});expect(me.status).toBe(200);expect(me.body.actorId).toBe(metadata.actors.creator);expect(me.body.data.readOnly).toBe(true);
  expect(await page.evaluate(()=>document.cookie.includes('session_token'))).toBe(false);
  const held=await page.evaluate(async actor=>{const response=await fetch('/api/v1/workspaces',{method:'POST',headers:{'Content-Type':'application/json','X-Scope-Action':'explicit-user-action','X-Scope-Session':actor},body:'not parsed during hold'});return {status:response.status,body:await response.json()};},metadata.actors.creator);expect(held.status).toBe(503);expect(held.body.error.code).toBe('recovery_read_only');
  await page.getByText('AI provider, privacy and limits',{exact:true}).click();await expect(page.getByText('Saved reviews may come from an earlier provider integration.',{exact:false})).toBeVisible();
  await page.screenshot({path:'portable-private-readonly.png',fullPage:true});
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Continue with GitHub'})).toBeVisible();
  await expect(page.getByText('Owned private migration message for one heron.',{exact:true})).toHaveCount(0);
  const denied=await page.evaluate(async()=>{const response=await fetch('/api/v1/me',{headers:{'X-Scope-Actor':'00000000-0000-0000-0000-000000000001'}});return response.status;});expect(denied).toBe(401);
});
test('buyer reaches only its mapped history, cannot replay unknown checkout and cannot read creator AI',async({page})=>{
  await page.goto('/workspace/'+metadata.workspaceId);await github(page,'buyer');
  await expect(page.getByRole('heading',{name:'Portable migration - owned history',exact:true})).toBeVisible();
  const result=await page.evaluate(async workspace=>{
    const me=await(await fetch('/api/v1/me')).json(),checkout=await(await fetch('/api/v1/workspaces/'+workspace+'/checkout')).json(),ai=await fetch('/api/v1/workspaces/'+workspace+'/draft');
    return {actor:me.actorId,readOnly:me.data.readOnly,checkout:checkout.data.checkout,aiStatus:ai.status};
  },metadata.workspaceId);
  expect(result.actor).toBe(metadata.actors.buyer);expect(result.readOnly).toBe(true);expect(result.checkout.state).toBe('unconfirmed');expect(result.aiStatus).toBe(403);
  await expect(page.getByRole('button',{name:'Create sandbox checkout',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Sign out',exact:true}).click();
});
test('unmapped sign-in cannot enroll during migration or reveal another workspace',async({page})=>{
  await page.goto('/workspace/'+metadata.workspaceId);await github(page,'stranger');
  await expect(page.getByRole('button',{name:'Continue with GitHub'})).toBeVisible();
  expect(await page.evaluate(async()=>{const response=await fetch('/api/v1/me');return response.status;})).toBe(401);
  await expect(page.getByText('Owned private migration message for one heron.',{exact:true})).toHaveCount(0);
});
test('failed async sign-in returns control and never follows an untrusted redirect',async({page})=>{
  await page.goto('/');await page.route('**/api/auth/sign-in/social',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'authentication_unavailable'}})}));
  await page.getByRole('button',{name:'Continue with GitHub'}).click();await expect(page.getByText('That sign-in method could not be opened. Try again later.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue with GitHub'})).toBeEnabled();
  await page.route('**/api/auth/sign-in/social',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({url:'https://untrusted.invalid/steal',redirect:false})}));
  await page.getByRole('button',{name:'Continue with GitHub'}).click();await expect(page).toHaveURL(origin+'/');await expect(page.getByRole('button',{name:'Continue with GitHub'})).toBeEnabled();
});
test('production runtime never exposes the fixture helper or starts new AI/payment work',async({request})=>{
  const status=await(await request.get('/__owned/status')).json();expect(status.forbiddenRequests).toBe(0);expect(status.authoredAiCalls).toBe(1);expect(status.authoredPaypalCalls).toBe(1);expect(status.counts).toEqual({ai:1,payments:1});
  for(const path of ['/api/auth/get-session','/api/auth/link-social','/portable/start.mjs','/server/api.mjs'])expect((await request.get(path)).status()).toBe(404);
});
