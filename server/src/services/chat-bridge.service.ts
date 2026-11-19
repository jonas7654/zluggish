import type { RepositoryContext as Runtime } from '#src/context';
import { BaseService } from '#src/services/base.service';
import { MessageService } from '#src/services/message.service';

/** What the server needs from any chat bridge it relays riders' chat to. */
export interface Bridge {
  send(content: string, sender?: string): void;
  online(id: bigint, joining: boolean): void;
  close(): Promise<void>;
}

export interface ChatTransport {
  deliver(content: string, sender: string): Promise<void>;
  presence(count: number): void;
  close(): Promise<void>;
}

export interface ChatSettings {
  readonly helpMessage: string;
  readonly announcePlayers: boolean;
}

/** All external work is bounded and detached from the ride tick. */
export class ChatBridge extends BaseService implements Bridge {
  // Open admits at most 100 sends; close permanently stops admission. Each settled send releases one slot.
  private pending = 0;

  private stopped = false;

  constructor(
    readonly runtime: Runtime,
    readonly transport: ChatTransport,
    private readonly name: string,
    private readonly settings: () => ChatSettings,
  ) {
    super(runtime.accounts.repositories);
  }

  get closed() {
    return this.stopped;
  }

  /** Answers bridge commands and relays anything else to riders in-game. */
  relay(author: string, content: string) {
    const settings = this.settings();

    if (content === '!online') this.send(`${this.runtime.world.online.size} riders online`);
    else if (content === '!ping') this.send('pong');
    else if (content === '!help' && settings.helpMessage) this.send(settings.helpMessage);
    else if (!content.startsWith('!'))
      this.runtime.bridge!.runSync(
        MessageService.use((messages) => messages.sendMessage(content.slice(0, 2000), undefined, author)),
      );
  }

  send(content: string, sender = 'Server') {
    if (this.stopped || this.pending >= 100) return;
    this.pending++;
    void this.transport
      .deliver(content, sender)
      .catch(() => {
        this.runtime.world.lifecycle.log.warn(
          `${this.name.toLowerCase()}.delivery_failed`,
          `${this.name} delivery failed`,
        );
      })
      .finally(() => {
        this.pending--;
      });
  }

  online(id: bigint, joining: boolean) {
    this.transport.presence(this.runtime.world.online.size);

    if (!this.settings().announcePlayers) return;
    const profile = this.runtime.profiles.get(Number(id));
    this.send(joining ? 'Riding' : 'Leaving', `${profile.firstName} ${profile.lastName}`);
  }

  async close() {
    this.stopped = true;
    await this.transport.close();
  }
}
