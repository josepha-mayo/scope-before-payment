import * as identity from '@netlify/identity';
import { mount } from './app.mjs';
import './style.css';
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
// Identity is a hosted platform service, not a local fake login. Browser tests
// import mount from a separate test entry point with an explicit owned adapter.
const auth = local ? { ...identity, handleAuthCallback: async () => null, getSettings: async () => { throw Error('hosted_preview_required'); } } : identity;
mount({ document, auth, offlinePreview: local });
