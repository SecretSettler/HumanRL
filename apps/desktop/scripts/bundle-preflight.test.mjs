import { describe, expect, it } from "vitest";

import { inspectBundleConfig, readPngSize } from "./bundle-preflight.mjs";

const present = () => ({ exists: true });
const missing = () => ({ exists: false });

function baseConfig(overrides = {}) {
  return {
    productName: "IntentTrace",
    version: "1.2.3",
    identifier: "local.intenttrace.desktop",
    app: { security: { csp: "default-src 'self'" } },
    bundle: {
      targets: ["app", "dmg"],
      category: "DeveloperTool",
      copyright: "© IntentTrace",
      longDescription: "Local trace workbench",
      licenseFile: "../../LICENSE",
      icon: ["icons/icon.icns", "icons/128x128.png"],
      resources: ["resources/intenttrace-stack.tar.gz"],
      macOS: {
        minimumSystemVersion: "12.0",
        dmg: {
          windowSize: { width: 660, height: 400 },
          appPosition: { x: 180, y: 170 },
          applicationFolderPosition: { x: 480, y: 170 },
        },
      },
    },
    ...overrides,
  };
}

describe("bundle preflight", () => {
  it("accepts the shipped configuration shape", () => {
    const { errors, warnings } = inspectBundleConfig(baseConfig(), present);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("rejects placeholder and malformed identifiers", () => {
    for (const identifier of ["com.tauri.dev", "notreversedns", "com.example.app"]) {
      const { errors } = inspectBundleConfig(baseConfig({ identifier }), present);
      expect(errors.join(" ")).toContain("identifier");
    }
  });

  it("rejects a product name that would break the DMG volume", () => {
    const { errors } = inspectBundleConfig(baseConfig({ productName: "Intent/Trace" }), present);
    expect(errors.join(" ")).toContain("must not contain");
  });

  it("flags 0.0.0 as not releasable without failing the build", () => {
    const { errors, warnings } = inspectBundleConfig(baseConfig({ version: "0.0.0" }), present);
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toContain("real release version");
  });

  it("catches DMG icons pushed outside the window", () => {
    const config = baseConfig();
    config.bundle.macOS.dmg.appPosition = { x: 180, y: 360 };
    const { errors } = inspectBundleConfig(config, present);
    expect(errors.join(" ")).toContain("clips the icon");
  });

  it("catches overlapping DMG icons", () => {
    const config = baseConfig();
    config.bundle.macOS.dmg.applicationFolderPosition = { x: 200, y: 170 };
    const { errors } = inspectBundleConfig(config, present);
    expect(errors.join(" ")).toContain("overlap");
  });

  it("requires referenced files to exist", () => {
    const { errors } = inspectBundleConfig(baseConfig(), missing);
    expect(errors.join(" ")).toContain("resources/intenttrace-stack.tar.gz");
    expect(errors.join(" ")).toContain("LICENSE");
    expect(errors.join(" ")).toContain("icons/icon.icns");
  });

  it("requires an icns icon for macOS bundles", () => {
    const config = baseConfig();
    config.bundle.icon = ["icons/128x128.png"];
    const { errors } = inspectBundleConfig(config, present);
    expect(errors.join(" ")).toContain(".icns");
  });

  it("validates category and minimum system version", () => {
    const config = baseConfig();
    config.bundle.category = "NotACategory";
    config.bundle.macOS.minimumSystemVersion = "Sonoma";
    const { errors } = inspectBundleConfig(config, present);
    expect(errors.join(" ")).toContain("application category");
    expect(errors.join(" ")).toContain("not a version");
  });

  it("requires a committed entitlements file when one is referenced", () => {
    const config = baseConfig();
    config.bundle.macOS.entitlements = "entitlements.plist";
    const { errors } = inspectBundleConfig(config, (path) => ({
      exists: path !== "entitlements.plist",
    }));
    expect(errors.join(" ")).toContain("entitlements is missing");
  });

  it("rejects a background whose pixels do not scale to the window", () => {
    const config = baseConfig();
    config.bundle.macOS.dmg.background = "dmg-background.png";
    const png = (width, height) => {
      const bytes = new Uint8Array(24);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      new DataView(bytes.buffer).setUint32(16, width);
      new DataView(bytes.buffer).setUint32(20, height);
      return bytes;
    };
    const bad = inspectBundleConfig(config, () => ({ exists: true, bytes: png(700, 400) }));
    expect(bad.errors.join(" ")).toContain("whole-number scale");
    const retina = inspectBundleConfig(config, () => ({ exists: true, bytes: png(1320, 800) }));
    expect(retina.errors).toEqual([]);
  });

  it("rejects an unsafe-eval CSP and warns when none is set", () => {
    const unsafe = inspectBundleConfig(
      baseConfig({ app: { security: { csp: "default-src 'self'; script-src 'unsafe-eval'" } } }),
      present,
    );
    expect(unsafe.errors.join(" ")).toContain("unsafe-eval");
    const none = inspectBundleConfig(baseConfig({ app: {} }), present);
    expect(none.warnings.join(" ")).toContain("csp");
  });

  it("skips macOS-only rules when the DMG target is absent", () => {
    const config = baseConfig();
    config.bundle.targets = ["deb"];
    config.bundle.category = "NotACategory";
    config.bundle.icon = ["icons/128x128.png"];
    const { errors } = inspectBundleConfig(config, present);
    expect(errors).toEqual([]);
  });
});

describe("readPngSize", () => {
  it("returns null for non-PNG input", () => {
    expect(readPngSize(new Uint8Array(24))).toBeNull();
    expect(readPngSize(new Uint8Array(4))).toBeNull();
    expect(readPngSize(undefined)).toBeNull();
  });
});
