const { notarize } = require('@electron/notarize');
const path = require('path');
const { execSync } = require('child_process');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  // FAIL HARD if Apple credentials are missing. Previously this silently
  // skipped notarization, which meant a forgotten `source ~/.zshrc` (or
  // running from CI/IDE without env inherited) would happily publish a
  // completely unsigned, unnotarized, unstapled artifact — customers would
  // hit the "Apple could not verify" Gatekeeper warning on first launch.
  // Better to fail the build loudly than ship a bad release.
  //
  // Override for legitimate dev/preview builds: SKIP_NOTARIZE=1 npm run build
  const missing = [];
  if (!process.env.APPLE_ID) missing.push('APPLE_ID');
  if (!process.env.APPLE_APP_SPECIFIC_PASSWORD) missing.push('APPLE_APP_SPECIFIC_PASSWORD');
  if (!process.env.APPLE_TEAM_ID) missing.push('APPLE_TEAM_ID');
  if (missing.length) {
    if (process.env.SKIP_NOTARIZE === '1') {
      console.warn(`[notarize] SKIP_NOTARIZE=1 set — bypassing notarization. Missing: ${missing.join(', ')}`);
      console.warn('[notarize] DO NOT publish this build. It will trigger Gatekeeper warnings for end users.');
      return;
    }
    throw new Error(
      `[notarize] BUILD ABORTED — missing Apple credentials: ${missing.join(', ')}. ` +
      `Source your shell rc (source ~/.zshrc) to load them, or set SKIP_NOTARIZE=1 ` +
      `for a local-only dev build that you will NOT publish.`
    );
  }

  console.log(`[notarize] Submitting ${appPath} to Apple — this can take several minutes...`);
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log('[notarize] Done.');

  // ── STAPLE the notarization ticket to the .app bundle ────────────
  // Without this, macOS has to phone Apple online to verify the
  // notarization on first launch. If that lookup fails or is slow,
  // Gatekeeper shows the user "Apple could not verify ... is free of
  // malware" — even though the app IS notarized. Stapling embeds the
  // proof inside the bundle so macOS can verify offline.
  //
  // Must run AFTER notarize() resolves. The DMG (built later by
  // electron-builder) will then include the stapled .app, so the
  // ticket survives all the way to the end user.
  try {
    console.log(`[notarize] Stapling ticket to ${appPath}...`);
    execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
    console.log('[notarize] Stapled successfully.');
    execSync(`xcrun stapler validate "${appPath}"`, { stdio: 'inherit' });
    console.log('[notarize] Staple validated.');
  } catch (err) {
    console.error('[notarize] Stapling failed:', err.message);
    throw err; // fail the build — unstapled artifact would just repeat this exact user-facing problem
  }

  // ── FINAL ASSERTION: simulate what macOS Gatekeeper does on the user's
  // machine. spctl --assess runs the same checks (signature + notarization
  // + staple) that block first launch when missing. If this passes here,
  // the user's first launch will pass too.
  try {
    console.log(`[notarize] Final Gatekeeper check (spctl)...`);
    execSync(`spctl --assess --verbose=4 --type execute "${appPath}"`, { stdio: 'inherit' });
    console.log('[notarize] ✓ Gatekeeper-ready. Build will not trigger "Apple could not verify" warnings.');
  } catch (err) {
    console.error('[notarize] Gatekeeper check FAILED — this build would trigger the "Apple could not verify" warning for end users.');
    throw err;
  }
};
