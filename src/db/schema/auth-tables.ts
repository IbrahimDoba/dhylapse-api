/**
 * Single import surface for the tables better-auth manages, so its config
 * doesn't reach across three schema files.
 */
export { appUser } from './tenancy.ts';
export { authAccount, authSession, authVerification } from './auth.ts';
