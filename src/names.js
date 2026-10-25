/** Stable identities kept in one place so a rename touches one module. */
export const PLUGIN_NAME = 'dsh-tether-android-arm64';
export const TOOL_PREFIX = 'tether';
export const STATE_BASENAME = PLUGIN_NAME;

/** Build a model-facing tool name with the plugin prefix. */
export function toolName(suffix) {
  return `${TOOL_PREFIX}_${suffix}`;
}
