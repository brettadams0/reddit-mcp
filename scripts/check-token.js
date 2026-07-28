import { redditFetch } from '../src/auth.js';

async function main() {
  const me = await redditFetch('/api/v1/me');
  console.log(`OK: logged in as /u/${me.name}`);
}

main().catch((err) => {
  console.error(`EXPIRED_OR_MISSING: ${err.message}`);
  process.exit(1);
});
