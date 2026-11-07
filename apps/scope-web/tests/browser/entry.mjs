// Only this test build has an authored identity adapter. The production entry
// imports Netlify Identity directly and cannot select this adapter at runtime.
import { mount } from '../../src/app.mjs';
import '../../src/style.css';
const events=[],listeners=[];
globalThis.scopeFixtureAuthEvents=events; // Action names only; never passwords.
function login(email){if(!['creator@invented.example','buyer@invented.example'].includes(email))throw Error('fixture identity');document.cookie='scope_fixture_actor='+(email.startsWith('creator')?'creator':'buyer')+'; Path=/; SameSite=Strict';events.push('login');return Promise.resolve();}
const auth={
  getSettings:async()=>({providers:{email:true},disableSignup:false,autoconfirm:false}),
  handleAuthCallback:async()=>{const type=new URLSearchParams(location.search).get('testCallback');if(type==='invite')return{type,token:'AUTHORED_INVITE_TOKEN',user:null};if(type==='recovery'){await login('buyer@invented.example');return{type,user:{},token:undefined};}return null;},
  login,signup:login,
  logout:async()=>{document.cookie='scope_fixture_actor=; Max-Age=0; Path=/';events.push('logout');for(const fn of listeners)fn('LOGOUT',null);},
  acceptInvite:async(token,password)=>{if(token!=='AUTHORED_INVITE_TOKEN'||password.length<12)throw Error('fixture invite');events.push('acceptInvite');await login('buyer@invented.example');},
  updateUser:async({password})=>{if(password.length<12)throw Error('fixture recovery');events.push('updateUser');},
  onAuthChange:fn=>{listeners.push(fn);return()=>listeners.splice(listeners.indexOf(fn),1);},
  requestPasswordRecovery:async()=>{events.push('requestPasswordRecovery');},
};
mount({document,auth});
document.querySelector('footer').append(' Automated test: identity and provider IO are authored fixtures.');
