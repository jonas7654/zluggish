import { Context } from 'effect';
import type { ResolvedConfig } from '#src/config/index';
import type { AccountsService } from '#src/services/auth.service';
import type { SessionsService } from '#src/services/browser-session.service';
import type { Profiles } from '#src/repositories/profile.repository';
import type { SettingsStore } from '#src/repositories/settings.repository';
import type { World } from '#src/world/state';

export interface RepositoryContext {
  bridges?: import('#src/services/chat-bridge.service').Bridge[];
  config: ResolvedConfig;
  accounts: AccountsService;
  sessions: SessionsService;
  world: World;
  settings: SettingsStore;
  profiles: Profiles;
  assets: string;
  tokens: { access: string; refresh: string; id: string };
}

/** The runtime context as an Effect service. Services read the parts they need from it. */
export class RuntimeContext extends Context.Service<RuntimeContext, RepositoryContext>()('zluggish/RuntimeContext') {}
