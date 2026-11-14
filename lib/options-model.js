import { normalizeConfig } from "./config.js";
import { parseProxyInput } from "./proxy.js";

export function buildProxyPatch(config, form) {
  const result = parseProxyInput(form.address, {
    scheme: form.scheme,
    username: form.username,
    password: form.password
  });
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    config: normalizeConfig({ ...config, proxy: result.proxy, lastError: null }),
    notice: result.notice || ""
  };
}
