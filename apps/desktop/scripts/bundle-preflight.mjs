/**
 * Pure validation of the Tauri bundle configuration.
 *
 * The DMG itself can only be produced on macOS with Apple credentials, so this
 * preflight exists to catch the configuration mistakes that would otherwise
 * only surface on a signing machine: icons positioned outside the DMG window,
 * a background whose pixel size does not match the window, a referenced
 * entitlements file that was never committed, a placeholder identifier, and so
 * on. Everything here is a pure function over the parsed config plus a
 * filesystem probe, so it runs and is tested on Linux.
 */

/** Tauri `AppCategory` values that map to a macOS LSApplicationCategoryType. */
export const MACOS_CATEGORIES = new Set([
  "Business",
  "DeveloperTool",
  "Education",
  "Entertainment",
  "Finance",
  "Game",
  "ActionGame",
  "AdventureGame",
  "ArcadeGame",
  "BoardGame",
  "CardGame",
  "CasinoGame",
  "DiceGame",
  "EducationalGame",
  "FamilyGame",
  "KidsGame",
  "MusicGame",
  "PuzzleGame",
  "RacingGame",
  "RolePlayingGame",
  "SimulationGame",
  "SportsGame",
  "StrategyGame",
  "TriviaGame",
  "WordGame",
  "GraphicsAndDesign",
  "HealthcareAndFitness",
  "Lifestyle",
  "Medical",
  "Music",
  "News",
  "Photography",
  "Productivity",
  "Reference",
  "SocialNetworking",
  "Sports",
  "Travel",
  "Utility",
  "Video",
  "Weather",
]);

/** Finder renders DMG icons at 128pt plus a label; keep them clear of the edges. */
const ICON_EXTENT = 128;
const LABEL_HEIGHT = 24;

/** Reads width/height from a PNG IHDR chunk without pulling in an image library. */
export function readPngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24) return null;
  for (const [index, value] of signature.entries()) {
    if (bytes[index] !== value) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * @param config parsed tauri.conf.json
 * @param probe  {(relativePath: string) => {exists: boolean, bytes?: Uint8Array}}
 */
export function inspectBundleConfig(config, probe) {
  const errors = [];
  const warnings = [];
  const bundle = config.bundle ?? {};
  const macOS = bundle.macOS ?? {};
  const dmg = macOS.dmg ?? {};
  const targets = bundle.targets === "all" ? ["dmg"] : (bundle.targets ?? []);
  const buildsDmg = targets.includes("dmg");

  if (!config.identifier) {
    errors.push("bundle identifier is required");
  } else if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/u.test(config.identifier)) {
    errors.push(`bundle identifier must be reverse-DNS: ${config.identifier}`);
  } else if (/tauri\.dev$|example|changeme/iu.test(config.identifier)) {
    errors.push(`bundle identifier is still a placeholder: ${config.identifier}`);
  }

  if (!config.productName) {
    errors.push("productName is required");
  } else if (/[/:]/u.test(config.productName)) {
    // productName becomes the mounted DMG volume name.
    errors.push(`productName must not contain "/" or ":": ${config.productName}`);
  }

  if (!config.version) errors.push("version is required");
  else if (config.version === "0.0.0") {
    warnings.push("version is 0.0.0; a distributable DMG needs a real release version");
  }

  for (const [field, message] of [
    ["copyright", "copyright is empty; Finder shows it in Get Info"],
    ["longDescription", "longDescription is empty; it appears in the installer metadata"],
    ["licenseFile", "licenseFile is not set; the DMG ships without license text"],
  ]) {
    if (!bundle[field]) warnings.push(message);
  }

  if (bundle.licenseFile) {
    const probed = probe(bundle.licenseFile);
    if (!probed.exists) errors.push(`licenseFile is missing: ${bundle.licenseFile}`);
  }

  for (const resource of bundle.resources ?? []) {
    if (!probe(resource).exists) {
      errors.push(`bundle resource is missing (run desktop:prepare first): ${resource}`);
    }
  }

  const icons = bundle.icon ?? [];
  if (icons.length === 0) {
    warnings.push("bundle.icon is not pinned; Tauri falls back to its default icon list");
  } else {
    for (const icon of icons) {
      if (!probe(icon).exists) errors.push(`bundle icon is missing: ${icon}`);
    }
    if (buildsDmg && !icons.some((icon) => icon.endsWith(".icns"))) {
      errors.push("macOS bundles require an .icns icon in bundle.icon");
    }
  }

  if (buildsDmg) {
    if (bundle.category && !MACOS_CATEGORIES.has(bundle.category)) {
      errors.push(`category is not a macOS application category: ${bundle.category}`);
    }
    if (!macOS.minimumSystemVersion) {
      warnings.push("macOS.minimumSystemVersion is unset; Gatekeeper reporting is vaguer");
    } else if (!/^\d+(\.\d+){0,2}$/u.test(macOS.minimumSystemVersion)) {
      errors.push(`macOS.minimumSystemVersion is not a version: ${macOS.minimumSystemVersion}`);
    }
    if (macOS.entitlements && !probe(macOS.entitlements).exists) {
      errors.push(`macOS.entitlements is missing: ${macOS.entitlements}`);
    }
    errors.push(...inspectDmgLayout(dmg, probe));
  }

  const csp = config.app?.security?.csp;
  if (!csp) warnings.push("app.security.csp is unset; the shell would run without a CSP");
  else if (/unsafe-eval/u.test(csp)) errors.push("app.security.csp allows unsafe-eval");

  return { errors, warnings };
}

function inspectDmgLayout(dmg, probe) {
  const errors = [];
  const windowSize = dmg.windowSize;
  if (!windowSize) return errors;
  const positions = [
    ["appPosition", dmg.appPosition],
    ["applicationFolderPosition", dmg.applicationFolderPosition],
  ].filter(([, position]) => position);

  for (const [name, position] of positions) {
    const halfIcon = ICON_EXTENT / 2;
    if (position.x - halfIcon < 0 || position.x + halfIcon > windowSize.width) {
      errors.push(`${name}.x places the icon outside the ${windowSize.width}pt DMG window`);
    }
    if (position.y - halfIcon < 0 || position.y + halfIcon + LABEL_HEIGHT > windowSize.height) {
      errors.push(`${name}.y clips the icon or its label in the ${windowSize.height}pt DMG window`);
    }
  }

  if (positions.length === 2) {
    const [, app] = positions[0];
    const [, folder] = positions[1];
    const dx = Math.abs(app.x - folder.x);
    const dy = Math.abs(app.y - folder.y);
    if (dx < ICON_EXTENT && dy < ICON_EXTENT) {
      errors.push("appPosition and applicationFolderPosition overlap");
    }
  }

  if (dmg.background) {
    const probed = probe(dmg.background);
    if (!probed.exists) {
      errors.push(`dmg.background is missing: ${dmg.background}`);
    } else {
      const size = readPngSize(probed.bytes);
      if (size && (size.width % windowSize.width !== 0 || size.height % windowSize.height !== 0)) {
        errors.push(
          `dmg.background is ${size.width}x${size.height}px, which is not a whole-number scale of the ${windowSize.width}x${windowSize.height}pt window`,
        );
      }
    }
  }
  return errors;
}
