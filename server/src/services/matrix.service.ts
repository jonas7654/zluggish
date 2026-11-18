import type { RepositoryContext as Runtime } from '#src/context';
import type { MatrixTransport } from '#src/repositories/matrix.repository';
import { BaseService } from '#src/services/base.service';
import type { Bridge } from '#src/services/chat-bridge.service';
import { ChatBridge } from '#src/services/chat-bridge.service';

export class MatrixBridge extends BaseService implements Bridge {
  private readonly chat: ChatBridge;

  constructor(
    readonly runtime: Runtime,
    readonly transport: MatrixTransport,
  ) {
    super(runtime.accounts.repositories);
    this.chat = new ChatBridge(
      runtime,
      {
        // A Matrix message has no per-message username, so the sender leads the text.
        deliver: (content, sender) =>
          transport.send((sender === 'Server' ? content : `${sender}: ${content}`).slice(0, 2000)),
        presence: (count) => transport.presence(count),
        close: () => transport.close(),
      },
      'Matrix',
      () => runtime.config.integrations.matrix,
    );
  }

  receive(author: string, content: string) {
    if (!this.chat.closed) this.chat.relay(author, content);
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

export class MatrixService extends BaseService {
  startMatrix(runtime: Runtime) {
    const transport = this.matrixRepository.openMatrixTransport(
      runtime.config.integrations.matrix,
      runtime.config.storageDir,
      {
        receive: (author, content) => bridge.receive(author, content),
        onlineCount: () => runtime.world.online.size,
        encrypted: () =>
          runtime.world.lifecycle.log.warn(
            'matrix.encrypted_room',
            'Matrix room is encrypted; the bridge only supports unencrypted rooms',
          ),
        connectionFailed: () =>
          runtime.world.lifecycle.log.warn('matrix.connection_failed', 'Matrix connection failed'),
        loginFailed: () =>
          runtime.world.lifecycle.log.warn(
            'matrix.login_failed',
            'Matrix login failed; local riding remains available',
          ),
      },
    );

    const bridge = new MatrixBridge(runtime, transport);

    return bridge;
  }
}
