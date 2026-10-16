// Test-only preload: source tests must not depend on a retained deployment build.
import './moderation-fixture.js';

// Integration fixtures model multiple players on loopback; session-quota tests opt in explicitly.
process.env.SP_FOREIGN_SESSION_LIMIT ??= 'off';

if (!process.argv.includes('--source-client')) process.argv.push('--source-client');
