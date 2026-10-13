// Test-only preload: source tests must not depend on a retained deployment build.
import './moderation-fixture.js';

if (!process.argv.includes('--source-client')) process.argv.push('--source-client');
