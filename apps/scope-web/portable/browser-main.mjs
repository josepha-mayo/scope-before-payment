import {mount} from '../src/app.mjs';
import '../src/style.css';
import {createBrowserIdentity} from './browser-auth.mjs';

const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('scope-auth-events-v1'):undefined;
const auth=createBrowserIdentity({location,history,channel});
mount({document,auth,
  signInUnavailable:'Sign-in is unavailable. Please try again shortly.',
  aiDataUseText:'Saved reviews may come from an earlier provider integration. Opening a workspace or checking a saved result sends no new AI request. New reviews disclose their provider before confirmation.',
  dataUseText:[
    'GitHub handles creator sign-in. When enabled, PayPal Sandbox handles test-buyer sign-in and verifies the sandbox payer account through Scope’s authentication service. Signing in does not request payment. Scope retains account references, buyer invitation email, saved conversations, published offers, decisions and action history in its database. Saved offer reads are limited to workspace members.',
    'AI reviews are optional and only run after explicit confirmation. Read the provider disclosure beside each new request. Scope retains the request and result; saved reviews can come from an earlier provider. Opening a workspace or checking a saved result sends no new AI request. The short offer record excludes AI suggestions, invitation routing and payment history. The separate account data copy includes older conversations and additional saved history, with credentials and hosting backups excluded.',
    'Automatic deletion and account erasure are not implemented. Replacing a conversation or signing out does not delete its saved history. Use invented conversations while these controls are being qualified.',
  ],
});
