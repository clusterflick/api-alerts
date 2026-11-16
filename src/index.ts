import { handlePreview, PREVIEW_PATH } from "./preview";
import { handleRemember, REMEMBER_PATH } from "./remember";
import { runNightly } from "./run";

/**
 * Clusterflick's email alerts: the nightly run (`src/run.ts`), and what the
 * site's settings page asks for: a preview (`src/preview.ts`), and the
 * watchlist remembered when alerts are switched on (`src/remember.ts`).
 *
 * Only handlers are exported from here: workerd refuses anything else in the
 * entry module.
 */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === PREVIEW_PATH) return handlePreview(request, env);
    if (pathname === REMEMBER_PATH) return handleRemember(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(controller, env) {
    await runNightly(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
