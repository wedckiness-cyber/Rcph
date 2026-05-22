import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, 'dist');
const androidMainDir = path.join(projectRoot, 'android', 'app', 'src', 'main');
const androidJavaDir = path.join(androidMainDir, 'java');
const resDir = path.join(androidMainDir, 'res');
const manifestPath = path.join(androidMainDir, 'AndroidManifest.xml');
const stringsPath = path.join(resDir, 'values', 'strings.xml');
const androidAppBuildGradlePath = path.join(projectRoot, 'android', 'app', 'build.gradle');
const androidAppBuildGradleKtsPath = path.join(projectRoot, 'android', 'app', 'build.gradle.kts');
const capacitorConfigPath = path.join(projectRoot, 'capacitor.config.json');
const backgroundAudioTemplateDir = path.join(projectRoot, 'templates', 'android-background-audio');

const launcherSizes = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192]
];

const readJson = async (filePath) => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const resolveConfiguredIcon = async () => {
  const manifestFile = path.join(distDir, 'manifest.webmanifest');
  const fallback = path.join(distDir, 'pwa-icon.png');

  if (!(await fileExists(manifestFile))) {
    if (await fileExists(fallback)) return fallback;
    throw new Error('No manifest.webmanifest or fallback pwa-icon.png was found in dist/.');
  }

  const manifest = await readJson(manifestFile);
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const preferredIcon =
    icons.find((item) => String(item.sizes || '').includes('512x512')) ||
    icons.find((item) => String(item.sizes || '').includes('192x192')) ||
    icons[0];

  if (!preferredIcon?.src) {
    if (await fileExists(fallback)) return fallback;
    throw new Error('manifest.webmanifest does not contain an icon src and fallback pwa-icon.png is missing.');
  }

  const iconPath = path.resolve(distDir, preferredIcon.src);
  if (!(await fileExists(iconPath))) {
    if (await fileExists(fallback)) return fallback;
    throw new Error(`Configured icon not found: ${iconPath}`);
  }

  return iconPath;
};

const resolveAndroidPackageName = async () => {
  const capacitorConfig = await readJson(capacitorConfigPath);
  const appId = String(capacitorConfig.appId || '').trim();

  if (!appId) {
    throw new Error('capacitor.config.json is missing appId.');
  }

  return appId;
};

const createRoundMask = (size) => Buffer.from(
  `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
  </svg>`
);

const clearExistingLauncherResources = async () => {
  await fs.rm(path.join(resDir, 'mipmap-anydpi-v26'), { recursive: true, force: true });

  for (const [folder] of launcherSizes) {
    const targetDir = path.join(resDir, folder);

    if (!(await fileExists(targetDir))) {
      continue;
    }

    const entries = await fs.readdir(targetDir, { withFileTypes: true });
    const staleLauncherFiles = entries.filter(
      (entry) =>
        entry.isFile() &&
        ['ic_launcher', 'ic_launcher_round'].includes(path.parse(entry.name).name)
    );

    await Promise.all(
      staleLauncherFiles.map((entry) =>
        fs.rm(path.join(targetDir, entry.name), { force: true })
      )
    );
  }
};

const generateLauncherIcons = async (iconPath) => {
  await clearExistingLauncherResources();

  for (const [folder, size] of launcherSizes) {
    const targetDir = path.join(resDir, folder);
    await ensureDir(targetDir);

    const baseImage = sharp(iconPath).resize(size, size, {
      fit: 'cover',
      position: 'centre'
    });

    await baseImage.clone().webp({ quality: 100 }).toFile(path.join(targetDir, 'ic_launcher.webp'));
    await baseImage
      .clone()
      .composite([{ input: createRoundMask(size), blend: 'dest-in' }])
      .webp({ quality: 100 })
      .toFile(path.join(targetDir, 'ic_launcher_round.webp'));
  }
};

const generateNotificationIcon = async (iconPath) => {
  const drawableDir = path.join(resDir, 'drawable');
  await ensureDir(drawableDir);

  await sharp(iconPath)
    .resize(96, 96, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .ensureAlpha()
    .tint({ r: 255, g: 255, b: 255 })
    .png()
    .toFile(path.join(drawableDir, 'push_icon.png'));
};

const upsertUsesPermission = (manifest, permissionName) => {
  if (manifest.includes(`android:name="${permissionName}"`)) {
    return manifest;
  }

  return manifest.replace(
    /<application\b/,
    `    <uses-permission android:name="${permissionName}" />\n\n    <application`
  );
};

const upsertServiceDeclaration = (manifest) => {
  const serviceLine =
    '        <service android:name=".BackgroundAudioService" android:exported="false" android:foregroundServiceType="mediaPlayback" />';

  if (/BackgroundAudioService/.test(manifest)) {
    return manifest.replace(
      /<service[^>]*BackgroundAudioService[^>]*\/>/,
      serviceLine
    );
  }

  return manifest.replace(
    /<application([\s\S]*?)>/,
    (match) => `${match}\n${serviceLine}`
  );
};

const upsertAndroidManifestEntries = async () => {
  let manifest = await fs.readFile(manifestPath, 'utf8');

  const notificationIconMeta = 'android:name="com.google.firebase.messaging.default_notification_icon"';
  const channelMeta = 'android:name="com.google.firebase.messaging.default_notification_channel_id"';

  if (manifest.includes(notificationIconMeta)) {
    manifest = manifest.replace(
      /<meta-data\s+android:name="com\.google\.firebase\.messaging\.default_notification_icon"[\s\S]*?\/>/,
      '        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/push_icon" />'
    );
  } else {
    manifest = manifest.replace(
      /<application([\s\S]*?)>/,
      (match) => `${match}\n        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/push_icon" />`
    );
  }

  if (manifest.includes(channelMeta)) {
    manifest = manifest.replace(
      /<meta-data\s+android:name="com\.google\.firebase\.messaging\.default_notification_channel_id"[\s\S]*?\/>/,
      '        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="@string/default_notification_channel_id" />'
    );
  } else {
    manifest = manifest.replace(
      /<meta-data android:name="com\.google\.firebase\.messaging\.default_notification_icon" android:resource="@drawable\/push_icon" \/>/,
      '        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/push_icon" />\n        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="@string/default_notification_channel_id" />'
    );
  }

  manifest = upsertUsesPermission(manifest, 'android.permission.WAKE_LOCK');
  manifest = upsertUsesPermission(manifest, 'android.permission.FOREGROUND_SERVICE');
  manifest = upsertUsesPermission(manifest, 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
  manifest = upsertServiceDeclaration(manifest);

  await fs.writeFile(manifestPath, manifest, 'utf8');
};

const upsertStringsXml = async () => {
  let stringsXml = await fs.readFile(stringsPath, 'utf8');

  if (stringsXml.includes('name="default_notification_channel_id"')) {
    stringsXml = stringsXml.replace(
      /<string name="default_notification_channel_id">[\s\S]*?<\/string>/,
      '<string name="default_notification_channel_id">roche_messages</string>'
    );
  } else {
    stringsXml = stringsXml.replace(
      '</resources>',
      '    <string name="default_notification_channel_id">roche_messages</string>\n</resources>'
    );
  }

  await fs.writeFile(stringsPath, stringsXml, 'utf8');
};

const upsertDependencyBlockEntry = (content, dependencyLine) => {
  if (content.includes('androidx.media:media')) {
    return content;
  }

  if (!/dependencies\s*\{/.test(content)) {
    throw new Error('Could not find dependencies block in android/app build file.');
  }

  return content.replace(
    /dependencies\s*\{/,
    (match) => `${match}\n${dependencyLine}`
  );
};

const upsertAndroidMediaDependency = async () => {
  if (await fileExists(androidAppBuildGradlePath)) {
    const buildGradle = await fs.readFile(androidAppBuildGradlePath, 'utf8');
    const nextBuildGradle = upsertDependencyBlockEntry(
      buildGradle,
      '    implementation "androidx.media:media:1.7.0"'
    );
    await fs.writeFile(androidAppBuildGradlePath, nextBuildGradle, 'utf8');
    return path.relative(projectRoot, androidAppBuildGradlePath);
  }

  if (await fileExists(androidAppBuildGradleKtsPath)) {
    const buildGradle = await fs.readFile(androidAppBuildGradleKtsPath, 'utf8');
    const nextBuildGradle = upsertDependencyBlockEntry(
      buildGradle,
      '    implementation("androidx.media:media:1.7.0")'
    );
    await fs.writeFile(androidAppBuildGradleKtsPath, nextBuildGradle, 'utf8');
    return path.relative(projectRoot, androidAppBuildGradleKtsPath);
  }

  throw new Error('Android app build.gradle file was not found after generating the Android project.');
};

const installBackgroundAudioTemplates = async (packageName) => {
  const packageDir = path.join(androidJavaDir, ...packageName.split('.'));

  await ensureDir(packageDir);

  const templateFiles = [
    { templateName: 'MainActivity.java.template', targetName: 'MainActivity.java' },
    { templateName: 'BackgroundAudioPlugin.java.template', targetName: 'BackgroundAudioPlugin.java' },
    { templateName: 'BackgroundAudioService.java.template', targetName: 'BackgroundAudioService.java' }
  ];

  await fs.rm(path.join(packageDir, 'MainActivity.kt'), { force: true });

  for (const { templateName, targetName } of templateFiles) {
    const templatePath = path.join(backgroundAudioTemplateDir, templateName);
    const targetPath = path.join(packageDir, targetName);
    const templateContent = await fs.readFile(templatePath, 'utf8');
    const javaSource = templateContent.replace(/__PACKAGE__/g, packageName);

    await fs.writeFile(targetPath, javaSource, 'utf8');
  }
};

const main = async () => {
  const iconPath = await resolveConfiguredIcon();
  const packageName = await resolveAndroidPackageName();

  await generateLauncherIcons(iconPath);
  await generateNotificationIcon(iconPath);
  await installBackgroundAudioTemplates(packageName);
  await upsertAndroidManifestEntries();
  await upsertStringsXml();
  const mediaDependencyTarget = await upsertAndroidMediaDependency();

  console.log(`[prepare-android] Using icon source: ${path.relative(projectRoot, iconPath)}`);
  console.log(`[prepare-android] Installed background audio package: ${packageName}`);
  console.log(`[prepare-android] Ensured media session dependency in: ${mediaDependencyTarget}`);
};

main().catch((error) => {
  console.error('[prepare-android] Failed:', error);
  process.exitCode = 1;
});
