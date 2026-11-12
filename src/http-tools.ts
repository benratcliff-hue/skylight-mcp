// Ratcliff fork: the tool set the hosted HTTP entry (src/http.ts) serves.
//
// The family calendar lives in Google Calendar and reaches Claude through the
// Google connector, so every tool that reads or writes Skylight's own calendar
// is left out here. They are dropped by name rather than by module, because
// the events module also holds `skylight_list_categories` (the family-member
// list chores and rewards need), and two event-creating tools sit inside
// modules that otherwise stay.
//
// This file is fork-only. src/index.ts (the upstream stdio entry) is untouched,
// which keeps upstream merges conflict-free.
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolRegistrar } from '@chrischall/mcp-utils';
import type { SkylightClient } from './client.js';
import { registerFrameTools } from './tools/frames.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerCalendarTools } from './tools/calendars.js';
import { registerMemberTools } from './tools/members.js';
import { registerEventTools } from './tools/events.js';
import { registerListTools } from './tools/lists.js';
import { registerChoreTools } from './tools/chores.js';
import { registerMealTools } from './tools/meals.js';
import { registerMessageTools } from './tools/messages.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerRewardTools } from './tools/rewards.js';
import { registerAiTools } from './tools/ai.js';
import { registerPhotoTools } from './tools/photos.js';
import { registerHealthcheckTools } from './tools/health.js';
import { registerLoginTools } from './tools/login.js';

type GetClient = () => Promise<SkylightClient>;

/** Every calendar tool. Anything here never reaches a client of the HTTP entry. */
export const BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  // calendars.ts: the whole module
  'skylight_list_calendars',
  'skylight_get_calendar',
  'skylight_add_webcal',
  'skylight_update_calendar',
  'skylight_delete_source_calendar', // could break the Google feed onto the frame
  'skylight_set_default_calendar',
  'skylight_list_nudges',
  'skylight_link_apple_calendar',
  'skylight_categorize_source_calendar',
  'skylight_create_source_calendar',
  // events.ts: all but skylight_list_categories
  'skylight_list_events',
  'skylight_get_event',
  'skylight_create_event',
  'skylight_update_event',
  'skylight_delete_event',
  'skylight_list_source_calendars',
  'skylight_list_recent_invited_emails',
  'skylight_get_event_notification_settings',
  'skylight_update_event_notification_settings',
  // inside modules that otherwise stay
  'skylight_import_events_from_photo', // photos.ts: creates events from a flyer
  'skylight_generate_activity_ideas', // ai.ts: creates draft calendar events
]);

/**
 * Wrap a registrar so any tool it registers under a blocked name is removed
 * the moment it is registered. The registrar sees a proxy of the server whose
 * `registerTool` defers to the real one, so return values stay real.
 */
export function withoutTools<T>(
  register: ToolRegistrar<T>,
  blocked: ReadonlySet<string> = BLOCKED_TOOLS,
): ToolRegistrar<T> {
  return (server: McpServer, deps: T) => {
    const proxy = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === 'registerTool') {
          return (name: string, ...rest: unknown[]) => {
            const tool = (target.registerTool as (...a: unknown[]) => { remove(): void })(name, ...rest);
            if (blocked.has(name)) tool.remove();
            return tool;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return register(proxy, deps);
  };
}

/** Registrars for the hosted entry: every module, calendar tools removed. */
export const HTTP_TOOL_REGISTRARS: ToolRegistrar<GetClient>[] = [
  registerFrameTools,
  registerSettingsTools,
  registerCalendarTools,
  registerMemberTools,
  registerEventTools,
  registerListTools,
  registerChoreTools,
  registerMealTools,
  registerMessageTools,
  registerTaskTools,
  registerRewardTools,
  registerAiTools,
  registerPhotoTools,
  registerHealthcheckTools,
  registerLoginTools,
].map((r) => withoutTools<GetClient>(r));
