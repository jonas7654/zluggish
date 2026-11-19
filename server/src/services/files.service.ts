import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const files = context.accounts.repositories.filesRepository;

  const exists = Effect.fn('FilesService.exists')(function* (path: string) {
    return files.existsSync(path);
  });

  /** Whether path names a regular file. */
  const isFile = Effect.fn('FilesService.isFile')(function* (path: string) {
    return files.existsSync(path) && files.statSync(path).isFile();
  });

  const read = Effect.fn('FilesService.read')(function* (path: string) {
    return files.readFileSync(path);
  });

  const readText = Effect.fn('FilesService.readText')(function* (path: string) {
    return files.readFileSync(path, 'utf8');
  });

  /** Write path durably; an existing file is kept unless replace is set. */
  const write = Effect.fn('FilesService.write')(function* (path: string, data: string | Uint8Array, replace = false) {
    files.writeDurable(path, data, replace);
  });

  return { exists, isFile, read, readText, write };
});

/** Files in the asset and storage folders. */
export class FilesService extends Context.Service<FilesService, Effect.Success<typeof make>>()(
  'zluggish/FilesService',
) {
  static readonly layer = Layer.effect(FilesService, make);
}
