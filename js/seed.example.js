/*
 * TEMPLATE — copy to js/seed.js and fill in.
 *
 * js/seed.js is gitignored because it holds a live access token.
 *
 * SILO_DEFAULT_SERVER is pre-filled on the sign-in screen (not secret).
 * SILO_SEED pre-fills a whole session, so the app skips the sign-in screen.
 *
 * Obtain a token by signing in with Quick Connect:
 *   POST /QuickConnect/Initiate                     -> { Secret, Code }
 *   POST /Users/AuthenticateWithQuickConnect {Secret} -> { AccessToken, User }
 * Then write:
 *
 *   window.SILO_DEFAULT_SERVER = 'https://silo-jf.example.com';
 *   window.SILO_SEED = {
 *     server: 'https://silo-jf.example.com',
 *     token: '<AccessToken>',
 *     userId: '<user id>',
 *     userName: '<display name>'
 *   };
 */
window.SILO_DEFAULT_SERVER = '';
window.SILO_SEED = null;
