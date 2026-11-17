import type { ResolvedConfig } from '#src/config/index';

// The origins clients reach through the hosts file and the shared certificate.
const impersonated = /https:\/\/(?:us-or-rly101|launcher|secure)\.zwift\.com(?![\w.-])/g;

/** Moves game-facing URLs in `text` to the configured public game origin; unchanged when none is set. */
export function gameUrls(config: ResolvedConfig, text: string) {
  const origin = config.network.api.publicUrl;

  return origin ? text.replaceAll(impersonated, () => origin) : text;
}
