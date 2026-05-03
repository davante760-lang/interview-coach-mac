const { notarize } = require('@electron/notarize');
const path = require('path');
const { execSync } = require('child_process');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.warn('[notarize] Skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set');
    return;
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
};
