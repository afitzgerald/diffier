const { execFileSync } = require('child_process');
const path = require('path');
const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    // ponytail: no Apple credentials in env (local/dev build) — ad-hoc sign so
    // the app still launches, skip notarization. Real signing/notarizing
    // needs a Developer ID cert in the keychain plus these three env vars.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
    return;
  }

  await notarize({
    appBundleId: 'com.fitzgeraldweb.diffier',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
};
