import type { RepositoryContext as Runtime } from '#src/context';
import type { DiscordTransport } from '#src/repositories/discord.repository';
import { BaseService } from '#src/services/base.service';
import type { Bridge } from '#src/services/chat-bridge.service';
import { ChatBridge } from '#src/services/chat-bridge.service';

export class DiscordBridge extends BaseService implements Bridge {
  private readonly chat: ChatBridge;

  constructor(
    readonly runtime: Runtime,
    readonly transport: DiscordTransport,
  ) {
    super(runtime.accounts.repositories);
    this.chat = new ChatBridge(
      runtime,
      {
        deliver: (content, sender) => transport.send(content.slice(0, 2000), sender.slice(0, 80)),
        presence: (count) => transport.presence(count),
        close: () => transport.close(),
      },
      'Discord',
      () => runtime.config.integrations.discord,
    );
  }

  receive(channel: string, author: string, bot: boolean, content: string) {
    if (this.chat.closed || bot || channel !== String(this.runtime.config.integrations.discord.channel)) return;
    this.chat.relay(author, content);
  }

  welcome(member: string) {
    const message = this.runtime.config.integrations.discord.welcomeMessage;

    if (message) this.send(`${member}\n${message}`);
  }

  send(content: string, sender?: string) {
    this.chat.send(content, sender);
  }

  online(id: bigint, joining: boolean) {
    this.chat.online(id, joining);
  }

  close() {
    return this.chat.close();
  }
}

export class DiscordService extends BaseService {
  startDiscord(runtime: Runtime) {
    const transport = this.discordRepository.openDiscordTransport(runtime.config.integrations.discord, {
      receive: (channel, author, bot, content) => bridge.receive(channel, author, bot, content),
      welcome: (member) => bridge.welcome(member),
      onlineCount: () => runtime.world.online.size,
      connectionFailed: () =>
        runtime.world.lifecycle.log.warn('discord.connection_failed', 'Discord connection failed'),
      loginFailed: () =>
        runtime.world.lifecycle.log.warn(
          'discord.login_failed',
          'Discord login failed; local riding remains available',
        ),
    });

    const bridge = new DiscordBridge(runtime, transport);

    return bridge;
  }
}
