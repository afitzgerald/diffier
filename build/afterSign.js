const path = require('path');
const { notarize } = require('@electron/notarize');

// One-time setup: xcrun notarytool store-credentials diffier-notary \
//   --apple-id <you@example.com> --team-id JB72T5K5AU --password <app-specific-password>
const NOTARY_PROFILE = 'diffier-notary';

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // ponytail: notarization is opt-in via NOTARIZE=1 so local/dev `yarn dist`
  // stays fast and doesn't need the keychain profile set up.
  if (!process.env.NOTARIZE) return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // CI (see .github/workflows/release.yml) has no keychain profile to use,
  // so it passes Apple credentials directly instead.
  const { APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (APPLE_ID && APPLE_APP_PASSWORD && APPLE_TEAM_ID) {
    await notarize({
      appPath,
      appleId: APPLE_ID,
      appleIdPassword: APPLE_APP_PASSWORD,
      teamId: APPLE_TEAM_ID,
    });
    return;
  }
  await notarize({ appPath, keychainProfile: NOTARY_PROFILE });
};
