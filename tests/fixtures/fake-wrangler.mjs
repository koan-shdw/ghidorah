// Test stand-in for Cloudflare's wrangler (share with clients, FEATURE-SPECS 3). Signed out until "login"; one D1
// database once created; the version migration fails the second time like the real one; "deploy" prints the local
// share site's address (FAKE_SHARE_URL). The sign-in reaches the accounts in FAKE_WRANGLER_ACCOUNTS (JSON, default one);
// with more than one, every Cloudflare call needs CLOUDFLARE_ACCOUNT_ID, like the real one. Every call is logged to
// FAKE_WRANGLER_LOG with the account it named.
import fs from 'node:fs';
const args = process.argv.slice(2), stateFile = process.env.FAKE_WRANGLER_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { loggedIn: false, databases: [], migrated: false, deploys: 0 };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const accounts = process.env.FAKE_WRANGLER_ACCOUNTS ? JSON.parse(process.env.FAKE_WRANGLER_ACCOUNTS) : [{ id: '00000000000000000000000000f1c7e0', name: "fixture@example.com's Account" }];
const account = process.env.CLOUDFLARE_ACCOUNT_ID || null;
fs.appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args, cwd: process.cwd(), account }) + '\n');
const [command, sub] = args;
if (command === 'whoami' && args.includes('--json')) {
  if (!state.loggedIn) { console.error(JSON.stringify({ loggedIn: false })); process.exit(1); }
  console.log(' ⛅️ wrangler 4.152.0\n' + JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'fixture@example.com', accounts: accounts.map(row => ({ ...row, type: 'standard', settings: {} })) }, null, 4)); process.exit(0);
}
if (command === 'whoami') { console.log(state.loggedIn ? 'You are logged in with an OAuth Token, associated with the email fixture@example.com.' : 'You are not authenticated. Please run `wrangler login`.'); process.exit(0); }
if (command === 'login') { state.loggedIn = true; save(); console.log('Successfully logged in.'); process.exit(0); }
if (!state.loggedIn) { console.error('Not logged in.'); process.exit(1); }
if (accounts.length > 1 && !accounts.some(row => row.id === account)) { console.error('More than one account available but unable to select one in non-interactive mode.\nAvailable accounts are (`<name>`: `<account_id>`):\n' + accounts.map(row => '  `' + row.name + '`: `' + row.id + '`').join('\n')); process.exit(1); }
if (command === 'd1' && sub === 'list') { console.log(JSON.stringify(state.databases)); process.exit(0); }
if (command === 'd1' && sub === 'create') { const uuid = 'f1ebd8a9-0000-4000-8000-00000000fake'.replace('fake', '0001'); state.databases.push({ uuid, name: args[2] }); save(); console.log(`Created\n{\n  "d1_databases": [\n    { "binding": "DB", "database_name": "${args[2]}", "database_id": "${uuid}" }\n  ]\n}`); process.exit(0); }
if (command === 'd1' && sub === 'execute') {
  const file = args[args.indexOf('--file') + 1];
  if (!args.includes('--remote') || !args.includes('--yes') || !fs.existsSync(file)) { console.error('Bad execute call.'); process.exit(1); }
  if (file === 'migrate.sql') { if (state.migrated) { console.error('duplicate column name: version: SQLITE_ERROR'); process.exit(1); } state.migrated = true; save(); }
  console.log('Executed ' + file); process.exit(0);
}
if (command === 'deploy') {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
  if (!fs.existsSync(config.main) || !fs.existsSync('public/_notes/notes.js')) { console.error('Missing site files.'); process.exit(1); }
  state.deploys++; save(); console.log('Uploaded ' + config.name + '\nDeployed ' + config.name + ' triggers\n  ' + process.env.FAKE_SHARE_URL); process.exit(0);
}
console.error('Unknown command: ' + args.join(' ')); process.exit(1);
