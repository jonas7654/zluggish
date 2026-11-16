import { immediate } from '#src/db/transaction';
import type { RepositoryContext } from '#src/context';
import { BaseService } from '#src/services/base.service';
import { ApplicationError } from '#src/errors';

interface ActiveRide {
  activity: bigint;
  token: string;
  generation: number;
  key: Buffer;
}

interface Permission extends ActiveRide {
  deadline: number;
  lastSeen: number;
}

interface Receipt {
  token: string;
  activity: bigint;
  body: string;
  until: number;
  result: string;
}

/** A disabled rider's completion permission is deliberately not a normal identity. */
export class RideCompletionService extends BaseService {
  private readonly active = new Map<number, ActiveRide>();

  private readonly permissions = new Map<number, Permission>();

  private readonly receipts = new Map<number, Receipt>();

  constructor(private readonly context: RepositoryContext) {
    super(context.accounts.repositories);
  }

  persistRelay(player: number, key: Uint8Array, version: number) {
    immediate(this.context.accounts.db, () => {
      const rider = this.context.accounts.get(player);

      if (!rider?.enabled || rider.auth_version !== version) throw new ApplicationError(401, 'Relay revoked.');
      this.riderDocuments.put(player, 'encryption_key.bin', key);
      this.riderDocuments.put(player, 'relay-auth-version', String(version));
    });
  }

  register(player: number, activity: bigint, bearer: string) {
    const relay = this.context.world.relays.get(BigInt(player));

    if (!relay || !bearer) return;
    this.active.set(player, {
      activity,
      token: this.cryptoRepository.sha256(bearer),
      generation: this.context.world.generation(BigInt(player)),
      key: Buffer.from(relay.key),
    });
  }

  capture(player: number) {
    const ride = this.active.get(player);

    if (!ride || this.context.world.generation(BigInt(player)) !== ride.generation) return null;

    return { ...ride, deadline: Date.now() + 4 * 60 * 60_000, lastSeen: Date.now() };
  }

  grant(player: number, permission: Permission | null) {
    this.cancel(player, false);

    if (permission) this.permissions.set(player, permission);
    else this.context.world.logout(BigInt(player));
  }

  cancel(player: number, close = true) {
    this.active.delete(player);
    this.permissions.delete(player);
    this.receipts.delete(player);

    if (close) this.context.world.logout(BigInt(player));
  }

  permission(player: number) {
    const permission = this.permissions.get(player);

    if (!permission) return null;

    if (
      Date.now() >= permission.deadline ||
      Date.now() >= permission.lastSeen + this.context.config.recovery.resumeMinutes * 60_000 ||
      this.context.world.generation(BigInt(player)) !== permission.generation
    ) {
      this.cancel(player);

      return null;
    }

    return permission;
  }

  relay(player: number) {
    const permission = this.permission(player);
    const current = this.context.world.relays.get(BigInt(player));

    return !!(permission && current && permission.key.equals(current.key));
  }

  touch(player: number) {
    const permission = this.permission(player);

    if (permission) permission.lastSeen = Date.now();
  }

  authorize(player: number, activity: bigint, bearer: string, bytes: Uint8Array) {
    const digest = this.cryptoRepository.sha256(bearer);
    const receipt = this.receipts.get(player);
    const body = this.cryptoRepository.sha256(bytes);

    if (receipt && receipt.until > Date.now() && receipt.token === digest && receipt.activity === activity) {
      if (receipt.body !== body) throw new ApplicationError(409, 'Final save data changed.');

      return { receipt: receipt.result };
    }

    const permission = this.permission(player);

    if (!permission || permission.token !== digest || permission.activity !== activity)
      throw new ApplicationError(401, 'Ride completion permission expired.');

    return { receipt: null };
  }

  finish(player: number, activity: bigint, bearer: string, bytes: Uint8Array, result: string) {
    const token = this.cryptoRepository.sha256(bearer);
    const body = this.cryptoRepository.sha256(bytes);
    this.cancel(player);
    this.receipts.set(player, { token, activity, body, result, until: Date.now() + 300_000 });
  }

  sweep() {
    for (const player of this.permissions.keys()) this.permission(player);

    for (const [player, receipt] of this.receipts) if (receipt.until <= Date.now()) this.receipts.delete(player);
  }
}
