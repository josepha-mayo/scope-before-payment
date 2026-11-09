import {betterAuth} from 'better-auth';
import {authOptions} from './auth-options.mjs';

// The production factory has no test plugin, provider override, unsigned user
// shortcut or environment switch enabling a test login.
export const createPortableAuth=dependencies=>betterAuth(authOptions(dependencies));
