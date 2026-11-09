import {createAuthClient} from 'better-auth/client';

// Browser operations use the maintained SDK. Identity and membership still
// come only from Scope's server-verified /me endpoint, never this UI adapter.
export function createBrowserIdentity({location,history,channel,client=createAuthClient({baseURL:location.origin,disableDefaultFetchPlugins:true,fetchOptions:{credentials:'same-origin',retry:0,headers:{'x-scope-auth-action':'explicit-user-action'}},sessionOptions:{refetchInterval:0,refetchOnWindowFocus:false}})}){
  const listeners=new Set();
  const changed=()=>{for(const fn of listeners)fn('LOGOUT',null);};
  channel?.addEventListener('message',changed);
  function accepted(result){if(!result||result.error)throw Error('sign_in_unavailable');return result.data;}
  return {
    async getSettings(){
      const value=accepted(await client.$fetch('/settings',{method:'GET'}));
      if(value?.providers?.github!==true||value.providers.email!==false)throw Error('sign_in_unavailable');
      return {providers:{github:true,email:false},disableSignup:true,...(value.existingAccountsOnly===true?{notice:'This host is undergoing migration. Existing accounts can sign in; new accounts cannot access workspaces yet.'}:{})};
    },
    async oauthLogin(provider){
      if(provider!=='github')throw Error('provider_unavailable');
      const value=accepted(await client.signIn.social({provider:'github'},{disableSignal:true}));
      let target;try{target=new URL(value.url);}catch{throw Error('sign_in_unavailable');}
      if(target.origin!=='https://github.com'||target.pathname!=='/login/oauth/authorize'||target.username||target.password||target.hash)throw Error('sign_in_unavailable');
      location.assign(target.href);
    },
    async logout(){accepted(await client.signOut({},{disableSignal:true}));channel?.postMessage({type:'session-changed'});},
    async handleAuthCallback(){
      const url=new URL(location.href),values=url.searchParams.getAll('signin');
      if(!values.length)return null;
      const complete=values.length===1&&values[0]==='complete';
      // The OAuth code/state exchange ends on the server. Drop the callback
      // marker before any private route is restored; never echo error details.
      url.searchParams.delete('signin');history.replaceState(null,'',url.pathname+url.search);
      if(!complete)return {type:'oauth-error'};
      channel?.postMessage({type:'session-changed'});return {type:'oauth'};
    },
    onAuthChange(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    dispose(){channel?.removeEventListener('message',changed);channel?.close();listeners.clear();},
  };
}
